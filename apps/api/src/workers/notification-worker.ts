import { DataAccessError, getTenantItem, putNewItem, skKey, tenantPk } from '../config/dynamodb.js';
import { type DomainEvent, EVENT_TYPES, type EventType } from '../events/publisher.js';
import { type CoreRepository, coreRepository } from '../modules/core/repository.js';
import type { IsoDate, LiableParty } from '../modules/core/types.js';
import { type MembershipRepository, membershipRepository } from '../modules/memberships/repository.js';
import { createNotifierFromEnv } from '../modules/notifications/email.js';
import type { DeliveryResult, Notification, NotificationLine, NotificationTemplate, Notifier } from '../modules/notifications/notifier.js';
import { type UnitMembership, visibleParties } from '../modules/portal/types.js';
import { type ApartmentRoleRepository, apartmentRoleRepository } from '../modules/apartment-roles/repository.js';
import type { ApartmentRole } from '../modules/apartment-roles/types.js';
import { isTicketEvent, operationsDigestRecipients, ticketRecipients } from '../modules/tickets/notifications.js';
import { type CourierSnapshot, gateRecipients, isGateEvent } from '../modules/gate/notifications.js';
import { type GateRepository, gateRepository } from '../modules/gate/repository.js';
import { type Courier, gateKeys } from '../modules/gate/types.js';
import { type BookingSnapshot, isReservationEvent, reservationRecipients } from '../modules/reservations/notifications.js';
import { type ReservationRepository, reservationRepository } from '../modules/reservations/repository.js';

export type { DeliveryResult, Notification, NotificationTemplate, Notifier } from '../modules/notifications/notifier.js';
export { createLogNotifier } from '../modules/notifications/notifier.js';

/**
 * Bildirim worker'i (SQS tuketicisi).
 *
 * Akis: API -> SNS (events) -> SQS (notification, raw delivery) -> bu Lambda.
 *  1. Mesaj govdesi = domain olayi JSON'u (raw delivery). SNS zarfi gelirse de acilir.
 *  2. Idempotency: `NOTIF#<eventId>` kaydi varsa olay daha once islenmistir -> atlanir.
 *     (SQS at-least-once teslim eder; ayni olay iki kez gelebilir.)
 *  3. Alicilar DynamoDB'den cozulur (yalnizca o an gecerli daire uyelikleri):
 *       PAYMENT_RECEIVED       -> odemenin yapildigi alt cariyi goren uyeler
 *       DUE_GENERATED          -> her kalemin dairesinde ilgili alt cariyi goren uyeler
 *                                 (toplu tahakkuk kalemleri HARIC: onlar DUES_BATCH_SUMMARY ile)
 *       DUES_BATCH_SUMMARY     -> kullanici basina TEK ozet: gordugu tum kalemler bir arada
 *       ANNOUNCEMENT_PUBLISHED -> apartmandaki (blok hedefliyse o bloklardaki) tum uyeler
 *       LATE_FEE_POSTED        -> tazminat yazilan alt cariyi goren uyeler
 *       DUES_REMINDER          -> hatirlatilan alt cariyi goren uyeler (ilk kalem)
 *       TICKET_*               -> yonetim / gorevli / talep tarafi (modules/tickets/notifications.ts)
 *       OPERATIONS_DIGEST      -> gunluk ozet: yonetim tumu, gorevli kendi kalemleri
 *       GATE_COURIER_ARRIVED   -> bolumde oturan guncel uyeler; kurye kaydi okunur (beklemiyorsa yok)
 *       GATE_GUEST_ENTERED     -> gecisi olusturan sakin (hala oturuyorsa)  (modules/gate/notifications.ts)
 *       RESERVATION_*          -> rezervasyonu yapan sakin (hala uyeyse); gerekce ve ucret iadesinin
 *                                 guncel durumu rezervasyon kaydindan (modules/reservations/notifications.ts)
 *  4. Her aliciya `Notifier` ile bildirim gonderilir: NOTIFICATION_CHANNEL=log (yapilandirilmis
 *     log) veya ses (e-posta; tercih, adres ve alici bazli tekrar korumasi kanal icinde, bkz.
 *     modules/notifications/email.ts). SMS / WhatsApp ayni arayuzle eklenecek.
 *  5. Basariyla islenen olay icin `NOTIF#` kaydi yazilir (30 gun TTL).
 * Hatali mesajlar `batchItemFailures` ile yalnizca kendileri yeniden denenir; 5 denemeden
 * sonra DLQ'ya duser (Terraform: maxReceiveCount = 5) ve alarm uretir.
 *
 * Bir alicinin gecici hatasinda olay yeniden denenir; e-posta kanali `NOTIFSENT#` kaydiyla
 * onceki alicilara ikinci kez gondermez (log kanalinda dis etki yoktur).
 */

// ---------------------------------------------------------------------------
// SQS olay tipleri (yalnizca kullanilan alanlar)
// ---------------------------------------------------------------------------

export type SqsRecord = { messageId: string; body: string; receiptHandle?: string };
export type SqsEvent = { Records: SqsRecord[] };
export type SqsBatchResponse = { batchItemFailures: { itemIdentifier: string }[] };

// ---------------------------------------------------------------------------
// Ayristirma
// ---------------------------------------------------------------------------

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

export function parseDomainEvent(body: string): DomainEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new InvalidEventError('Mesaj govdesi JSON degil');
  }
  // Raw delivery kapaliysa SNS zarfi gelir: { Type: 'Notification', Message: '<json>' }
  if (isObject(raw) && raw.Type === 'Notification' && typeof raw.Message === 'string') {
    return parseDomainEvent(raw.Message);
  }
  if (!isObject(raw)) throw new InvalidEventError('Olay bir nesne olmalidir');
  const { eventId, type, apartmentId, payload } = raw;
  if (typeof eventId !== 'string' || !eventId) throw new InvalidEventError('eventId eksik');
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new InvalidEventError(`Bilinmeyen olay turu: ${String(type)}`);
  }
  if (typeof apartmentId !== 'string' || !apartmentId) throw new InvalidEventError('apartmentId eksik');
  if (!isObject(payload)) throw new InvalidEventError('payload eksik');
  return raw as DomainEvent;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Alici cozumleme (saf)
// ---------------------------------------------------------------------------

function isCurrent(m: UnitMembership, day: IsoDate): boolean {
  return m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);
}

const seesParty = (m: UnitMembership, party: LiableParty) => visibleParties(m).includes(party);

/** Kalem bu uyeye mi? Paydasa ozel kalemde (`userId`, Finans 2.1) yalnizca o paydas. */
const receives = (m: UnitMembership, item: { unitId: string; userId?: string }, party: LiableParty) =>
  m.unitId === item.unitId && seesParty(m, party) && (!item.userId || m.userId === item.userId);

/**
 * Worker'in olay icin ayrica okudugu kayitlar (payload kisisel veri / serbest metin tasimaz).
 * `now`: zamana bagli kurallar (kurye yanit suresi); verilmezse su an.
 */
export type NotificationRecords = { now?: Date; courier?: CourierSnapshot; booking?: BookingSnapshot };

/** Olaydan alici bazli bildirimleri uretir (ayni kullaniciya ayni olay icin tek bildirim). */
export function buildNotifications(
  event: DomainEvent,
  memberships: UnitMembership[],
  unitBlocks: Map<string, string>,
  day: IsoDate,
  roles: readonly ApartmentRole[] = [],
  records: NotificationRecords = {},
): Notification[] {
  const current = memberships.filter((m) => m.apartmentId === event.apartmentId && isCurrent(m, day));
  const out = new Map<string, Notification>();
  const add = (userId: string, template: NotificationTemplate, data: Notification['data']) => {
    if (!out.has(userId)) {
      out.set(userId, { eventId: event.eventId, apartmentId: event.apartmentId, userId, template, data });
    }
  };

  if (event.type === 'OPERATIONS_DIGEST') {
    return operationsDigestRecipients(event, roles, day).map((r) => ({ eventId: event.eventId, apartmentId: event.apartmentId, userId: r.userId, template: r.template, data: r.data }));
  }
  if (isGateEvent(event)) {
    return gateRecipients(event, memberships, day, { now: records.now ?? new Date(), ...('courier' in records ? { courier: records.courier } : {}) }).map((r) => ({
      eventId: event.eventId,
      apartmentId: event.apartmentId,
      userId: r.userId,
      template: r.template,
      data: r.data,
    }));
  }
  if (isReservationEvent(event)) {
    return reservationRecipients(event, memberships, day, records.booking).map((r) => ({
      eventId: event.eventId,
      apartmentId: event.apartmentId,
      userId: r.userId,
      template: r.template,
      data: r.data,
    }));
  }
  if (isTicketEvent(event)) {
    return ticketRecipients(event, memberships, roles, day).map((r) => ({
      eventId: event.eventId,
      apartmentId: event.apartmentId,
      userId: r.userId,
      template: r.template,
      data: r.data,
    }));
  }

  switch (event.type) {
    case 'PAYMENT_RECEIVED': {
      const p = event.payload;
      // Ayrilan sakin/malik carisine tahsilat: ilk surumde ayrilan kisinin portal/bildirim erisimi
      // yok; dairenin bugunku sakinine de gitmemeli.
      if (p.receivableAccountId) break;
      for (const m of current) {
        if (m.unitId === p.unitId && seesParty(m, p.liableParty)) {
          add(m.userId, 'payment_received', {
            unitId: p.unitId,
            amount: p.amount,
            receiptNumber: p.receiptNumber,
            paidAt: p.paidAt,
          });
        }
      }
      break;
    }
    case 'DUE_GENERATED': {
      const p = event.payload;
      // Toplu tahakkuk kalemi: sakine kalem kalem degil, DUES_BATCH_SUMMARY ile tek ozet gider.
      if (p.mode === 'bulk' && p.batchId) break;
      for (const item of p.items) {
        for (const m of current) {
          if (receives(m, item, item.liableParty ?? p.liableParty)) {
            add(m.userId, 'due_generated', {
              unitId: item.unitId,
              amount: item.amount,
              dueDate: p.dueDate,
              description: p.description,
            });
          }
        }
      }
      break;
    }
    case 'DUES_BATCH_SUMMARY': {
      const p = event.payload;
      const perUser = new Map<string, NotificationLine[]>();
      for (const item of p.items) {
        for (const m of current) {
          if (receives(m, item, item.liableParty)) {
            const list = perUser.get(m.userId) ?? [];
            // Ayni kullanici ayni daireyi iki uyelikle gorse de kalem bir kez.
            if (!list.some((l) => l.unitId === item.unitId)) list.push({ unitId: item.unitId, amount: item.amount });
            perUser.set(m.userId, list);
          }
        }
      }
      for (const [userId, items] of perUser) {
        add(userId, 'dues_batch_summary', {
          batchId: p.batchId,
          description: p.description,
          dueDate: p.dueDate,
          total: items.reduce((sum, i) => sum + i.amount, 0),
          items,
        });
      }
      break;
    }
    case 'METER_PERIOD_REVERSED': {
      const p = event.payload;
      const perUser = new Map<string, NotificationLine[]>();
      for (const item of p.items) {
        for (const m of current) {
          if (receives(m, item, item.liableParty)) {
            const list = perUser.get(m.userId) ?? [];
            if (!list.some((l) => l.unitId === item.unitId)) list.push({ unitId: item.unitId, amount: item.amount });
            perUser.set(m.userId, list);
          }
        }
      }
      for (const [userId, items] of perUser) {
        add(userId, 'dues_reversed', { batchId: p.batchId, description: p.description, total: items.reduce((s, i) => s + i.amount, 0), items });
      }
      break;
    }
    case 'LATE_FEE_POSTED': {
      const p = event.payload;
      for (const item of p.items) {
        for (const m of current) {
          if (receives(m, item, item.liableParty)) {
            add(m.userId, 'late_fee_posted', { unitId: item.unitId, amount: item.amount, period: p.period });
          }
        }
      }
      break;
    }
    case 'DUES_REMINDER': {
      const p = event.payload;
      for (const item of p.items) {
        for (const m of current) {
          if (receives(m, item, item.liableParty)) {
            add(m.userId, `dues_reminder_${item.kind}`, { unitId: item.unitId, amount: item.amount, dueDate: item.dueDate });
          }
        }
      }
      break;
    }
    case 'ANNOUNCEMENT_PUBLISHED': {
      const p = event.payload;
      const blocks = new Set(p.blockIds);
      for (const m of current) {
        const blockId = unitBlocks.get(m.unitId);
        if (blocks.size === 0 || (blockId !== undefined && blocks.has(blockId))) {
          add(m.userId, 'announcement_published', { announcementId: p.announcementId, title: p.title });
        }
      }
      break;
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const PROCESSED_TTL_SECONDS = 30 * 24 * 3600;

export type WorkerDeps = {
  memberships: Pick<MembershipRepository, 'list'>;
  core: Pick<CoreRepository, 'listUnits'>;
  /** O1-2: talep olaylarinda yonetim / gorevli alicilari. */
  roles: Pick<ApartmentRoleRepository, 'list'>;
  /** Guvenlik kapisi: kurye kaydinin guncel durumu ve firmasi. */
  gate: Pick<GateRepository, 'get'>;
  /** Rezervasyon: gerekce / not ve ucret iadesinin guncel durumu. */
  reservations: Pick<ReservationRepository, 'getBooking'>;
  notifier: Notifier;
  /** Olay daha once islendi mi? */
  isProcessed: (apartmentId: string, eventId: string) => Promise<boolean>;
  markProcessed: (apartmentId: string, eventId: string, info: { type: EventType; recipients: number }) => Promise<void>;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

const processedKey = (apartmentId: string, eventId: string) => ({
  PK: tenantPk(apartmentId),
  SK: skKey('NOTIF', eventId),
});

export function createNotificationWorker(overrides: Partial<WorkerDeps> = {}) {
  const now = overrides.now ?? (() => new Date());
  const deps: WorkerDeps = {
    memberships: membershipRepository,
    core: coreRepository,
    roles: apartmentRoleRepository,
    gate: gateRepository,
    reservations: reservationRepository,
    notifier: overrides.notifier ?? createNotifierFromEnv(),
    isProcessed: async (apt, id) => Boolean(await getTenantItem(processedKey(apt, id))),
    markProcessed: async (apt, id, info) => {
      try {
        await putNewItem({
          ...processedKey(apt, id),
          entityType: 'NOTIFICATION_LOG',
          eventId: id,
          eventType: info.type,
          recipients: info.recipients,
          processedAt: now().toISOString(),
          ttl: Math.floor(now().getTime() / 1000) + PROCESSED_TTL_SECONDS,
        });
      } catch (err) {
        // Es zamanli ikinci teslim zaten isaretlemis: sorun degil.
        if (err instanceof DataAccessError && err.code === 'conflict') return;
        throw err;
      }
    },
    now,
    log: console,
    ...overrides,
  };

  const today = (): IsoDate =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  type Outcome = { skipped: boolean; recipients: number; sent?: number; skippedRecipients?: Record<string, number> };

  /** Olayin ihtiyac duydugu kayitlar (yalnizca ilgili olay turlerinde okunur). */
  async function recordsFor(event: DomainEvent): Promise<NotificationRecords> {
    if (event.type === 'GATE_COURIER_ARRIVED') {
      const { courierId } = event.payload;
      const c = await deps.gate.get<Courier>(event.apartmentId, gateKeys.courier(event.apartmentId, courierId).SK);
      return { now: deps.now(), courier: c && c.apartmentId === event.apartmentId ? { courierId: c.courierId, unitId: c.unitId, status: c.status, ...(c.company ? { company: c.company } : {}) } : null };
    }
    if (isReservationEvent(event)) {
      const b = await deps.reservations.getBooking(event.apartmentId, event.payload.bookingId);
      return {
        now: deps.now(),
        booking:
          b && b.apartmentId === event.apartmentId
            ? { bookingId: b.bookingId, unitId: b.unitId, feeStatus: b.fee.status, ...(b.decisionNote ? { decisionNote: b.decisionNote } : {}), ...(b.cancelReason ? { cancelReason: b.cancelReason } : {}) }
            : null,
      };
    }
    return { now: deps.now() };
  }

  async function processEvent(event: DomainEvent): Promise<Outcome> {
    if (await deps.isProcessed(event.apartmentId, event.eventId)) {
      return { skipped: true, recipients: 0 };
    }
    const memberships = await deps.memberships.list(event.apartmentId);
    const unitBlocks =
      event.type === 'ANNOUNCEMENT_PUBLISHED' && event.payload.blockIds.length > 0
        ? new Map((await deps.core.listUnits(event.apartmentId)).map((u) => [u.unitId, u.blockId]))
        : new Map<string, string>();

    const roles = isTicketEvent(event) || event.type === 'OPERATIONS_DIGEST' ? await deps.roles.list(event.apartmentId) : [];
    const records = await recordsFor(event);
    const notifications = buildNotifications(event, memberships, unitBlocks, today(), roles, records);
    let sent = 0;
    const skippedRecipients: Record<string, number> = {};
    for (const n of notifications) {
      // Hata firlatirsa olay yeniden denenir (gonderilmis alicilar kanalda atlanir).
      const result: DeliveryResult | void = await deps.notifier.send(n);
      if (!result || result.status === 'sent') sent++;
      else skippedRecipients[result.reason] = (skippedRecipients[result.reason] ?? 0) + 1;
    }
    await deps.markProcessed(event.apartmentId, event.eventId, { type: event.type, recipients: notifications.length });
    return { skipped: false, recipients: notifications.length, sent, skippedRecipients };
  }

  return async (sqsEvent: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: SqsBatchResponse['batchItemFailures'] = [];
    for (const record of sqsEvent.Records ?? []) {
      let event: DomainEvent | undefined;
      try {
        event = parseDomainEvent(record.body);
        const result = await processEvent(event);
        deps.log.info(
          JSON.stringify({
            msg: 'event_processed',
            messageId: record.messageId,
            eventId: event.eventId,
            type: event.type,
            apartmentId: event.apartmentId,
            channel: deps.notifier.channel,
            ...result,
          }),
        );
      } catch (err) {
        deps.log.error(
          JSON.stringify({
            msg: 'event_failed',
            messageId: record.messageId,
            eventId: event?.eventId,
            type: event?.type,
            error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
          }),
        );
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

/** Lambda giris noktasi (Terraform: handler = "notification-worker.handler"). */
export const handler = createNotificationWorker();
