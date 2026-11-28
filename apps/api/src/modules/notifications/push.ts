import { randomUUID } from 'node:crypto';
import { DataAccessError, putNewItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { categoryOfTemplate } from './categories.js';
import { type DeviceRepository, type PushTarget, createDynamoDeviceRepository } from './devices.js';
import { EXPO_SEND_BATCH, type ExpoClient, type ExpoMessage, type ExpoTicket, PermanentPushError, TransientPushError, createExpoClient } from './expo.js';
import type { Notification } from './notifier.js';
import { type NotificationPreferences, createDynamoPreferencesRepository } from './preferences.js';
import { type PushReceiptStore, type ReceiptTicket, createDynamoReceiptStore } from './push-receipts.js';
import { type PushContent, renderPush } from './push-templates.js';

/**
 * Mobil bildirim (push) kanali: worker'in e-posta icin sectigi AYNI alicilara (ayni bildirimler,
 * ayni kategori) kullanicinin aktif Expo cihazlarina push.
 *
 * Olay basina akis:
 *  1. Alici basina aktif cihazlar (`USER#<id>` / `PUSHDEV#`; en fazla 10, en son gorulen once). Cihazi
 *     olmayan alici icin baska okuma yapilmaz (`no_device`): cihaz yokken kanal maliyetsizdir.
 *  2. Tercih: `push.enabled` ve `push.<kategori>` (e-postadan bagimsiz; kayit yoksa acik) -> `opted_out`.
 *  3. Icerik `renderPush` (kisa Turkce baslik/govde, `data.url` uygulama ici yol, Android `channelId`).
 *  4. Tekrar korumasi: `NOTIFPUSH#<eventId>#<parca>` kayitlarindaki cihazlar atlanir (tek Query). Her
 *     gonderim parcasi (<=100 mesaj, Expo siniri) sonucu ayni kayda yazilir; SQS yeniden teslim ederse
 *     yalnizca sonuclanmamis cihazlar gonderilir.
 *  5. Ticket sonuclari: `ok` -> makbuz kaydi (`push-receipts.ts`); `DeviceNotRegistered` -> cihaz pasife;
 *     `MessageRateExceeded`, ag / 429 / 5xx / 401-403 -> o cihazlar kaydedilmez ve olay sonunda
 *     `TransientPushError` firlatilir (SQS yalnizca onlari tekrar dener); diger hatalar (MessageTooBig,
 *     InvalidCredentials, MismatchSenderId, kalici 4xx) kalici: `push_rejected` hata logu, tekrar yok.
 *
 * Log'a token, baslik veya govde yazilmaz (yalnizca cihaz kimligi = token ozeti ve hata kodu).
 */

const SENT_TTL_SECONDS = 30 * 24 * 3600;
const DEFAULT_CONCURRENCY = 8;

export type PushOutcome = {
  /** Bildirim (alici) sayisi. */
  recipients: number;
  /** Bu denemede gonderilmeye calisilan cihaz. */
  devices: number;
  sent: number;
  deactivated: number;
  rejected: number;
  /** Gecici hatayla tekrar denenecek cihaz. */
  retry: number;
  /** Onceki denemede sonuclanmis cihaz. */
  alreadySent: number;
  /** Alici bazli atlama nedenleri. */
  skipped: Record<string, number>;
};

export type PushChannel = {
  /** Gecici hatada (basarili parcalar kaydedildikten sonra) `TransientPushError` firlatir. */
  deliver(apartmentId: string, eventId: string, notifications: readonly Notification[]): Promise<PushOutcome>;
};

// ---------------------------------------------------------------------------
// Gonderim kaydi (cihaz bazli idempotency)
// ---------------------------------------------------------------------------

export type PushMarkerStore = {
  /** Olay icin daha once sonuclanmis (gonderildi / olu / kalici red) cihazlar. */
  doneDevices(apartmentId: string, eventId: string): Promise<Set<string>>;
  record(apartmentId: string, eventId: string, batch: { deviceIds: string[]; sent: number; deactivated: number; rejected: number }): Promise<void>;
};

export const pushMarkerPrefix = (eventId: string) => `${skKey('NOTIFPUSH', eventId)}#`;

export function createDynamoPushMarkers(now: () => Date = () => new Date()): PushMarkerStore {
  return {
    async doneDevices(apartmentId, eventId) {
      const items = await queryTenantAll<{ deviceIds?: string[] }>(apartmentId, pushMarkerPrefix(eventId), { ProjectionExpression: 'deviceIds', ConsistentRead: true });
      return new Set(items.flatMap((i) => (Array.isArray(i.deviceIds) ? i.deviceIds : [])));
    },
    async record(apartmentId, eventId, batch) {
      try {
        await putNewItem({
          PK: tenantPk(apartmentId),
          SK: skKey('NOTIFPUSH', eventId, randomUUID()),
          entityType: 'NOTIFICATION_PUSH',
          eventId,
          channel: 'push',
          deviceIds: batch.deviceIds,
          sent: batch.sent,
          deactivated: batch.deactivated,
          rejected: batch.rejected,
          at: now().toISOString(),
          ttl: Math.floor(now().getTime() / 1000) + SENT_TTL_SECONDS,
        });
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') return;
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Kanal
// ---------------------------------------------------------------------------

export type PushChannelDeps = {
  devices: Pick<DeviceRepository, 'listActiveForPush' | 'deactivate'>;
  preferences: { get(userId: string): Promise<Partial<Pick<NotificationPreferences, 'push'>>> };
  markers: PushMarkerStore;
  receipts: Pick<PushReceiptStore, 'record'>;
  client: Pick<ExpoClient, 'send'>;
  /** iOS alt basligi (site adi); verilmezse yok. */
  siteName?: (apartmentId: string) => Promise<string | undefined>;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
  /** Alici okumalarinin es zamanlilik siniri. */
  concurrency?: number;
};

type Planned = { order: number; n: Notification; device: PushTarget; content: PushContent };

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Gecici sayilan ticket hatalari (o cihaz tekrar denenir). */
const TRANSIENT_TICKET_ERRORS = new Set(['MessageRateExceeded']);

export function createPushChannel(deps: PushChannelDeps): PushChannel {
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const message = (p: Planned, apartmentId: string, subtitle: string | undefined): ExpoMessage => ({
    to: p.device.token,
    title: p.content.title,
    body: p.content.body,
    ...(subtitle ? { subtitle } : {}),
    data: { url: p.content.path, apartmentId, type: p.n.template, ...(p.content.category ? { category: p.content.category } : {}) },
    sound: 'default',
    channelId: p.content.channelId,
    priority: p.content.priority,
    ...(p.content.ttlSeconds !== undefined ? { ttl: p.content.ttlSeconds } : {}),
  });

  return {
    async deliver(apartmentId, eventId, notifications) {
      const outcome: PushOutcome = { recipients: notifications.length, devices: 0, sent: 0, deactivated: 0, rejected: 0, retry: 0, alreadySent: 0, skipped: {} };
      const skip = (reason: string) => void (outcome.skipped[reason] = (outcome.skipped[reason] ?? 0) + 1);
      const planned: Planned[] = [];

      await mapLimit(notifications, concurrency, async (n, index) => {
        const devices = await deps.devices.listActiveForPush(n.userId);
        if (devices.length === 0) return skip('no_device');
        const push = (await deps.preferences.get(n.userId)).push ?? { enabled: true };
        const category = n.category ?? categoryOfTemplate(n.template);
        if (!push.enabled || (category && push[category] === false)) return skip('opted_out');
        const content = renderPush(n, deps.now());
        if (!content) return skip('no_template');
        devices.forEach((device, i) => planned.push({ order: index * 100 + i, n, device, content }));
      });
      if (planned.length === 0) return outcome;

      // Ayni cihaz (token) olayda bir kez; daha once sonuclanmis cihazlar atlanir.
      const done = await deps.markers.doneDevices(apartmentId, eventId);
      const seen = new Set<string>();
      const todo = planned
        .sort((a, b) => a.order - b.order)
        .filter((p) => {
          if (seen.has(p.device.deviceId)) return false;
          seen.add(p.device.deviceId);
          if (done.has(p.device.deviceId)) {
            outcome.alreadySent++;
            return false;
          }
          return true;
        });
      outcome.devices = todo.length;
      if (todo.length === 0) return outcome;

      const subtitle = deps.siteName ? await deps.siteName(apartmentId).catch(() => undefined) : undefined;
      let transient: Error | undefined;

      for (let i = 0; i < todo.length; i += EXPO_SEND_BATCH) {
        const chunk = todo.slice(i, i + EXPO_SEND_BATCH);
        let tickets: ExpoTicket[];
        try {
          tickets = await deps.client.send(chunk.map((p) => message(p, apartmentId, subtitle)));
        } catch (err) {
          if (err instanceof PermanentPushError) {
            deps.log.error(JSON.stringify({ level: 'error', msg: 'push_rejected', eventId, apartmentId, code: err.code, devices: chunk.length }));
            await deps.markers.record(apartmentId, eventId, { deviceIds: chunk.map((p) => p.device.deviceId), sent: 0, deactivated: 0, rejected: chunk.length });
            outcome.rejected += chunk.length;
            continue;
          }
          // Gecici: bu parca kaydedilmez, diger parcalar denenir; olay sonunda yeniden denenir.
          transient ??= err instanceof Error ? err : new TransientPushError('Expo gonderimi basarisiz');
          outcome.retry += chunk.length;
          continue;
        }

        const finished: string[] = [];
        const okTickets: ReceiptTicket[] = [];
        const dead: PushTarget[] = [];
        let rejected = 0;
        tickets.forEach((t, k) => {
          const p = chunk[k] as Planned;
          if (t.status === 'ok') {
            finished.push(p.device.deviceId);
            if (t.id) okTickets.push({ id: t.id, userId: p.device.userId, deviceId: p.device.deviceId });
            return;
          }
          const code = t.details?.error ?? 'Unknown';
          if (code === 'DeviceNotRegistered') {
            finished.push(p.device.deviceId);
            dead.push(p.device);
          } else if (TRANSIENT_TICKET_ERRORS.has(code)) {
            outcome.retry++;
            transient ??= new TransientPushError(`Expo ticket hatasi: ${code}`);
          } else {
            finished.push(p.device.deviceId);
            rejected++;
            deps.log.error(JSON.stringify({ level: 'error', msg: 'push_rejected', eventId, apartmentId, code, deviceId: p.device.deviceId, platform: p.device.platform }));
          }
        });
        const sent = finished.length - dead.length - rejected;
        if (finished.length) await deps.markers.record(apartmentId, eventId, { deviceIds: finished, sent, deactivated: dead.length, rejected });
        outcome.sent += sent;
        outcome.rejected += rejected;

        if (okTickets.length) {
          // Makbuz kaydi yalnizca olu cihaz temizligi icindir: yazilamazsa gonderim tekrarlanmaz.
          await deps.receipts.record({ apartmentId, eventId, tickets: okTickets }).catch((err: unknown) => {
            deps.log.error(JSON.stringify({ level: 'error', msg: 'push_receipt_record_failed', eventId, apartmentId, error: err instanceof Error ? err.name : 'unknown' }));
          });
        }
        for (const d of dead) {
          try {
            if (await deps.devices.deactivate(d.userId, d.deviceId, 'device_not_registered', deps.now().toISOString())) outcome.deactivated++;
          } catch (err) {
            deps.log.error(JSON.stringify({ level: 'error', msg: 'push_device_deactivate_failed', deviceId: d.deviceId, error: err instanceof Error ? err.name : 'unknown' }));
          }
        }
      }

      if (transient) {
        throw new TransientPushError(`Push gonderimi yarim kaldi (${outcome.retry} cihaz tekrar denenecek): ${transient.message}`, { cause: transient });
      }
      return outcome;
    },
  };
}

/**
 * PUSH_CHANNEL:
 *  - `off` (varsayilan; yerel / test): push yok.
 *  - `expo`: Expo push servisi. EXPO_ACCESS_TOKEN verilirse istekler yetkilendirilir (istege bagli).
 */
export function pushChannelMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'expo' {
  const mode = env.PUSH_CHANNEL || 'off';
  if (mode !== 'off' && mode !== 'expo') throw new Error(`Gecersiz PUSH_CHANNEL: ${mode} (off | expo)`);
  return mode;
}

export function expoClientFromEnv(env: NodeJS.ProcessEnv = process.env): ExpoClient {
  return createExpoClient({ ...(env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {}) });
}

export function createPushChannelFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<PushChannelDeps> & { core?: Pick<CoreRepository, 'getSite'> } = {}): PushChannel | null {
  if (pushChannelMode(env) === 'off') return null;
  const now = overrides.now ?? (() => new Date());
  const core = overrides.core ?? coreRepository;
  return createPushChannel({
    devices: overrides.devices ?? createDynamoDeviceRepository(),
    preferences: overrides.preferences ?? createDynamoPreferencesRepository(),
    markers: overrides.markers ?? createDynamoPushMarkers(now),
    receipts: overrides.receipts ?? createDynamoReceiptStore(now),
    client: overrides.client ?? expoClientFromEnv(env),
    siteName: overrides.siteName ?? (async (apartmentId) => (await core.getSite(apartmentId))?.name),
    now,
    log: overrides.log ?? console,
    ...(overrides.concurrency ? { concurrency: overrides.concurrency } : {}),
  });
}
