import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { KEY_SEPARATOR, getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import type { DeviceRepository } from './devices.js';
import { EXPO_RECEIPTS_BATCH, type ExpoClient } from './expo.js';

/**
 * Expo push makbuzlari (receipts). Gonderimdeki "ticket" yalnizca Expo'nun mesaji aldigini soyler;
 * APNs / FCM'in sonucu (ozellikle `DeviceNotRegistered`: uygulama silinmis) ~15 dk sonra makbuzla
 * gelir ve Expo makbuzu en az 24 saat tutar.
 *
 *   PK = `PUSHRCPT#<YYYY-MM-DDTHH>` (UTC saat kovasi), SK = `B#<uuid>`   gonderim parcasinin ticket'lari
 *                                                                        { id, userId, deviceId }[] (3 gun TTL)
 *   PK = `PUSHRCPT#CURSOR`,          SK = `CURSOR`                      islenen son kova
 *
 * Zamanlanmis `push_receipts` isi (saatte bir) imlecten sonraki, kapanisindan en az 15 dk gecmis
 * kovalari sirayla isler (en fazla son 24 saat): makbuzlari 1000'lik parcalarla sorgular,
 * `DeviceNotRegistered` cihazlari (gonderimden sonra yeniden gorulmediyse: `lastSeenAt` ticket zamanindan
 * eski) pasife alir ve her kova bitince imleci ilerletir. Gecici Expo
 * hatasi firlatilir (imlec ilerlemez, SQS tekrar dener); tekrar islemek zararsizdir.
 * Ham token bu kayitlarda YOKTUR (yalnizca cihaz kimligi = token ozeti).
 */

export const RECEIPT_TTL_SECONDS = 3 * 24 * 3600;
/** Expo: makbuzu gonderimden en az 15 dk sonra sorgulayin. */
export const RECEIPT_DELAY_MS = 15 * 60_000;
/** Expo makbuzlari en az 24 saat tutar; daha eski kovalar atlanir. */
export const RECEIPT_LOOKBACK_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

/** `sentAt`: gonderim parcasinin zamani (kovadan okunurken doldurulur). */
export type ReceiptTicket = { id: string; userId: string; deviceId: string; sentAt?: string };

export const hourBucket = (d: Date) => d.toISOString().slice(0, 13);
const nextBucket = (b: string) => hourBucket(new Date(Date.parse(`${b}:00:00.000Z`) + HOUR_MS));

export const receiptKeys = {
  batch: (bucket: string, id: string) => ({ PK: `PUSHRCPT${KEY_SEPARATOR}${bucket}`, SK: `B${KEY_SEPARATOR}${id}` }),
  cursor: { PK: `PUSHRCPT${KEY_SEPARATOR}CURSOR`, SK: 'CURSOR' },
};

export type PushReceiptStore = {
  record(entry: { apartmentId: string; eventId: string; tickets: ReceiptTicket[] }): Promise<void>;
  listBucket(bucket: string): Promise<ReceiptTicket[]>;
  getCursor(): Promise<string | undefined>;
  setCursor(bucket: string): Promise<void>;
};

export function createDynamoReceiptStore(now: () => Date = () => new Date()): PushReceiptStore {
  return {
    async record(entry) {
      const at = now();
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              ...receiptKeys.batch(hourBucket(at), randomUUID()),
              entityType: 'PUSH_RECEIPT_BATCH',
              apartmentId: entry.apartmentId,
              eventId: entry.eventId,
              tickets: entry.tickets.map((t) => ({ id: t.id, userId: t.userId, deviceId: t.deviceId })),
              at: at.toISOString(),
              ttl: Math.floor(at.getTime() / 1000) + RECEIPT_TTL_SECONDS,
            },
          }),
        );
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async listBucket(bucket) {
      const { client, tableName } = getDynamo();
      const out: ReceiptTicket[] = [];
      let start: Record<string, unknown> | undefined;
      try {
        do {
          const page = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: 'PK = :pk',
              ExpressionAttributeValues: { ':pk': receiptKeys.batch(bucket, 'x').PK },
              ProjectionExpression: 'tickets, #at',
              ExpressionAttributeNames: { '#at': 'at' },
              ...(start ? { ExclusiveStartKey: start } : {}),
            }),
          );
          for (const item of page.Items ?? []) {
            const sentAt = typeof item.at === 'string' ? item.at : undefined;
            for (const t of (item.tickets as ReceiptTicket[] | undefined) ?? []) {
              if (t && typeof t.id === 'string' && t.id && typeof t.userId === 'string' && typeof t.deviceId === 'string') {
                out.push({ id: t.id, userId: t.userId, deviceId: t.deviceId, ...(sentAt ? { sentAt } : {}) });
              }
            }
          }
          start = page.LastEvaluatedKey;
        } while (start);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return out;
    },
    async getCursor() {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: receiptKeys.cursor, ConsistentRead: true }));
        return typeof out.Item?.bucket === 'string' ? out.Item.bucket : undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async setCursor(bucket) {
      const { client, tableName } = getDynamo();
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: { ...receiptKeys.cursor, entityType: 'PUSH_RECEIPT_CURSOR', bucket, updatedAt: now().toISOString() } }));
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
  };
}

export type ReceiptCheckResult = {
  buckets: number;
  tickets: number;
  ok: number;
  /** Makbuzu henuz / artik olmayan ticket'lar. */
  missing: number;
  errors: Record<string, number>;
  deactivated: number;
  cursor?: string;
};

export type ReceiptCheckDeps = {
  store: PushReceiptStore;
  client: Pick<ExpoClient, 'getReceipts'>;
  devices: Pick<DeviceRepository, 'deactivate'>;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

/** Islenecek kovalar: imlecten sonra, [simdi - 24 sa, simdi - 1 sa - 15 dk] araliginda. */
export function pendingBuckets(now: Date, cursor: string | undefined, max = 30): string[] {
  const newest = hourBucket(new Date(now.getTime() - HOUR_MS - RECEIPT_DELAY_MS));
  const oldest = hourBucket(new Date(now.getTime() - RECEIPT_LOOKBACK_MS));
  let b = cursor && cursor >= oldest ? nextBucket(cursor) : oldest;
  const out: string[] = [];
  while (b <= newest && out.length < max) {
    out.push(b);
    b = nextBucket(b);
  }
  return out;
}

export async function checkPushReceipts(deps: ReceiptCheckDeps): Promise<ReceiptCheckResult> {
  const cursor = await deps.store.getCursor();
  const result: ReceiptCheckResult = { buckets: 0, tickets: 0, ok: 0, missing: 0, errors: {}, deactivated: 0, ...(cursor ? { cursor } : {}) };
  const done = new Set<string>();
  for (const bucket of pendingBuckets(deps.now(), cursor)) {
    const tickets = await deps.store.listBucket(bucket);
    result.tickets += tickets.length;
    for (let i = 0; i < tickets.length; i += EXPO_RECEIPTS_BATCH) {
      const chunk = tickets.slice(i, i + EXPO_RECEIPTS_BATCH);
      // Gecici hata firlatilir: imlec bu kovada kalir, is tekrar denenir.
      const receipts = await deps.client.getReceipts(chunk.map((t) => t.id));
      for (const t of chunk) {
        const r = receipts[t.id];
        if (!r) result.missing++;
        else if (r.status === 'ok') result.ok++;
        else {
          const code = r.details?.error ?? 'Unknown';
          result.errors[code] = (result.errors[code] ?? 0) + 1;
          const key = `${t.userId}|${t.deviceId}`;
          if (code === 'DeviceNotRegistered' && !done.has(key)) {
            done.add(key);
            // Gonderimden sonra yeniden kaydedilen (lastSeenAt daha yeni) cihaz pasife alinmaz.
            const seenBefore = t.sentAt ?? `${bucket}:00:00.000Z`;
            if (await deps.devices.deactivate(t.userId, t.deviceId, 'device_not_registered', deps.now().toISOString(), { seenBefore })) result.deactivated++;
          }
        }
      }
    }
    await deps.store.setCursor(bucket);
    result.buckets++;
    result.cursor = bucket;
  }
  // Olu cihaz disindaki hatalar (InvalidCredentials, MessageTooBig...) yapilandirma / icerik sorunudur: tek satir.
  const other = Object.fromEntries(Object.entries(result.errors).filter(([code]) => code !== 'DeviceNotRegistered'));
  if (Object.keys(other).length) deps.log.error(JSON.stringify({ level: 'error', msg: 'push_receipt_errors', errors: other }));
  return result;
}
