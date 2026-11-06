import { DataAccessError, getTenantItem, putNewItem, skKey, tenantPk } from '../config/dynamodb.js';
import { type DomainEvent, EVENT_TYPES, type EventType } from '../events/publisher.js';
import { type CoreRepository, coreRepository } from '../modules/core/repository.js';
import type { IsoDate, LiableParty } from '../modules/core/types.js';
import { type MembershipRepository, membershipRepository } from '../modules/memberships/repository.js';
import { type UnitMembership, visibleParties } from '../modules/portal/types.js';

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
 *       ANNOUNCEMENT_PUBLISHED -> apartmandaki (blok hedefliyse o bloklardaki) tum uyeler
 *  4. Her aliciya `Notifier` ile bildirim gonderilir. Su an kanal `log` (yapilandirilmis log);
 *     SMS / WhatsApp / e-posta saglayicilari ayni arayuzle eklenecek.
 *  5. Basariyla islenen olay icin `NOTIF#` kaydi yazilir (30 gun TTL).
 * Hatali mesajlar `batchItemFailures` ile yalnizca kendileri yeniden denenir; 5 denemeden
 * sonra DLQ'ya duser (Terraform: maxReceiveCount = 5) ve alarm uretir.
 *
 * Bilinen sinir: bir alici icin gonderim basarisiz olursa olay yeniden denenir ve onceki
 * alicilara bildirim tekrar gidebilir. Gercek SMS saglayicisi eklenirken alici bazli
 * idempotency kaydi eklenmelidir.
 */

// ---------------------------------------------------------------------------
// SQS olay tipleri (yalnizca kullanilan alanlar)
// ---------------------------------------------------------------------------

export type SqsRecord = { messageId: string; body: string; receiptHandle?: string };
export type SqsEvent = { Records: SqsRecord[] };
export type SqsBatchResponse = { batchItemFailures: { itemIdentifier: string }[] };

// ---------------------------------------------------------------------------
// Bildirim modeli ve kanallar
// ---------------------------------------------------------------------------

export type NotificationTemplate = 'due_generated' | 'payment_received' | 'announcement_published';

export type Notification = {
  eventId: string;
  apartmentId: string;
  userId: string;
  template: NotificationTemplate;
  /** Sablon degiskenleri; kisisel veri icermez (ad/telefon kanal adaptorunde cozulur). */
  data: Record<string, string | number | undefined>;
};

export type Notifier = { readonly channel: string; send(n: Notification): Promise<void> };

/** Varsayilan kanal: CloudWatch'a yapilandirilmis log (saglayici entegrasyonuna kadar). */
export function createLogNotifier(log: Pick<Console, 'info'> = console): Notifier {
  return {
    channel: 'log',
    async send(n) {
      log.info(JSON.stringify({ msg: 'notification', channel: 'log', ...n }));
    },
  };
}

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

/** Olaydan alici bazli bildirimleri uretir (ayni kullaniciya ayni olay icin tek bildirim). */
export function buildNotifications(
  event: DomainEvent,
  memberships: UnitMembership[],
  unitBlocks: Map<string, string>,
  day: IsoDate,
): Notification[] {
  const current = memberships.filter((m) => m.apartmentId === event.apartmentId && isCurrent(m, day));
  const out = new Map<string, Notification>();
  const add = (userId: string, template: NotificationTemplate, data: Notification['data']) => {
    if (!out.has(userId)) {
      out.set(userId, { eventId: event.eventId, apartmentId: event.apartmentId, userId, template, data });
    }
  };

  switch (event.type) {
    case 'PAYMENT_RECEIVED': {
      const p = event.payload;
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
      for (const item of p.items) {
        for (const m of current) {
          if (m.unitId === item.unitId && seesParty(m, p.liableParty)) {
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
    notifier: createLogNotifier(),
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

  async function processEvent(event: DomainEvent): Promise<{ skipped: boolean; recipients: number }> {
    if (await deps.isProcessed(event.apartmentId, event.eventId)) {
      return { skipped: true, recipients: 0 };
    }
    const memberships = await deps.memberships.list(event.apartmentId);
    const unitBlocks =
      event.type === 'ANNOUNCEMENT_PUBLISHED' && event.payload.blockIds.length > 0
        ? new Map((await deps.core.listUnits(event.apartmentId)).map((u) => [u.unitId, u.blockId]))
        : new Map<string, string>();

    const notifications = buildNotifications(event, memberships, unitBlocks, today());
    for (const n of notifications) await deps.notifier.send(n);
    await deps.markProcessed(event.apartmentId, event.eventId, { type: event.type, recipients: notifications.length });
    return { skipped: false, recipients: notifications.length };
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
