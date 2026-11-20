import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  DataAccessError,
  getDynamo,
  getTenantItem,
  putNewItem,
  putVersionedItem,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import type { TableKeys } from '../core/types.js';
import {
  type IntentKeyRecord,
  type IntentStatus,
  type PaymentAccount,
  type PaymentIntent,
  type PaymentProviderName,
  REVIEW_QUEUE_STATUSES,
} from './types.js';

/**
 * Platform inceleme kuyrugu (GSI1, seyrek): yalnizca NEEDS_REVIEW / REFUND_PENDING niyetlerde
 *   GSI1PK = `PAYMENT_REVIEW`, GSI1SK = `PI#<intentId>#APT#<apartmentId>` (zamana gore sirali).
 * Niyet bu durumlardan cikinca alanlar yazilmaz ve kayit indeksten duser. GSI1'in diger
 * kullanimlari (`USER#...`, `SITE_DIRECTORY`) ile cakismaz.
 */
export const REVIEW_QUEUE_PK = 'PAYMENT_REVIEW';

type IndexedIntent = PaymentIntent & { GSI1PK?: string; GSI1SK?: string };

/** Yazilacak niyet: kuyruk alanlari durumdan turetilir (asla cagirandan kopyalanmaz). */
export function toStoredIntent(intent: PaymentIntent): PaymentIntent {
  const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = intent as IndexedIntent;
  if (!REVIEW_QUEUE_STATUSES.includes(rest.status)) return rest as PaymentIntent;
  return { ...rest, GSI1PK: REVIEW_QUEUE_PK, GSI1SK: `PI#${rest.intentId}#APT#${rest.apartmentId}` } as PaymentIntent;
}

/** Okunan niyetten indeks alanlari ayiklanir (gorunumlere sizmaz, kopyalanip tasinmaz). */
function fromStored<T extends PaymentIntent | undefined>(item: T): T {
  if (!item) return item;
  const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = item as IndexedIntent;
  return rest as T;
}

export const paymentKeys = {
  intent: (apartmentId: string, intentId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PI', intentId),
  }),
  intentKey: (apartmentId: string, userId: string, idempotencyKey: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PIKEY', userId, idempotencyKey),
  }),
  account: (apartmentId: string, provider: PaymentProviderName): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PAYACCT', provider),
  }),
};

/** Kosullu yazim tutmadi: kayit zaten var veya surum degismis. */
export class PaymentsConflictError extends Error {
  constructor(message = 'Odeme kaydi baska bir istekle degistirilmis') {
    super(message);
    this.name = 'PaymentsConflictError';
  }
}

export class InvalidIntentCursorError extends Error {
  constructor() {
    super('Gecersiz sayfa imleci');
    this.name = 'InvalidIntentCursorError';
  }
}

export type IntentListQuery = { status?: IntentStatus; limit: number; cursor?: string };

export type PaymentsRepository = {
  getIntent(apartmentId: string, intentId: string): Promise<PaymentIntent | undefined>;
  /** Niyet + idempotency anahtari tek atomik yazimla; biri varsa `PaymentsConflictError`. */
  createIntent(intent: PaymentIntent, key: IntentKeyRecord): Promise<void>;
  getIntentKey(apartmentId: string, userId: string, idempotencyKey: string): Promise<IntentKeyRecord | undefined>;
  /** `intent.version === expectedVersion + 1` olmali; surum degismisse `PaymentsConflictError`. */
  updateIntent(intent: PaymentIntent, expectedVersion: number): Promise<void>;
  /** `PI#<fromId>` <= SK <= `PI#<toId>` (zamana gore sirali niyetler). */
  listIntentsBetween(apartmentId: string, fromId: string, toId: string): Promise<PaymentIntent[]>;
  /** Yonetici listesi: en yeni once, opsiyonel durum filtresi, sayfali. */
  listIntents(apartmentId: string, query: IntentListQuery): Promise<{ items: PaymentIntent[]; cursor?: string }>;
  /** Platform inceleme kuyrugu (tum apartmanlar), en eski once. */
  listReviewQueue(limit: number): Promise<PaymentIntent[]>;
  getAccount(apartmentId: string, provider: PaymentProviderName): Promise<PaymentAccount | undefined>;
  /** Yeni hesap (`expectedVersion` yok) veya surum kosullu guncelleme. */
  putAccount(account: PaymentAccount, expectedVersion?: number): Promise<void>;
};

function conflictOr(err: unknown): never {
  const mapped = toDataAccessError(err);
  if (mapped.code === 'conflict' || mapped.code === 'transaction_failed') throw new PaymentsConflictError();
  throw mapped;
}

export function createPaymentsRepository(): PaymentsRepository {
  return {
    getIntent: async (apartmentId, intentId) => fromStored(await getTenantItem<PaymentIntent>(paymentKeys.intent(apartmentId, intentId))),

    async createIntent(intent, key) {
      if (intent.PK !== key.PK || intent.PK !== tenantPk(intent.apartmentId)) {
        throw new Error('Niyet ve anahtar ayni tenant olmali');
      }
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: tableName, Item: key, ConditionExpression: 'attribute_not_exists(PK)' } },
              { Put: { TableName: tableName, Item: intent, ConditionExpression: 'attribute_not_exists(PK)' } },
            ],
          }),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const reasons = err.CancellationReasons ?? [];
          if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) throw new PaymentsConflictError();
        }
        throw toDataAccessError(err);
      }
    },

    getIntentKey: (apartmentId, userId, idempotencyKey) =>
      getTenantItem<IntentKeyRecord>(paymentKeys.intentKey(apartmentId, userId, idempotencyKey)),

    async updateIntent(intent, expectedVersion) {
      if (intent.version !== expectedVersion + 1) throw new Error('Niyet surumu bir artirilmali');
      try {
        await putVersionedItem(toStoredIntent(intent), expectedVersion);
      } catch (err) {
        conflictOr(err);
      }
    },

    async listIntentsBetween(apartmentId, fromId, toId) {
      const { client, tableName } = getDynamo();
      const pk = tenantPk(apartmentId);
      const items: PaymentIntent[] = [];
      let startKey: QueryCommandOutput['LastEvaluatedKey'];
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
              ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
              ExpressionAttributeValues: { ':pk': pk, ':lo': `PI#${fromId}`, ':hi': `PI#${toId}` },
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          items.push(...((out.Items ?? []) as PaymentIntent[]));
          startKey = out.LastEvaluatedKey;
        } while (startKey);
      } catch (err) {
        throw toDataAccessError(err);
      }
      // Savunma: yalnizca bu tenant'in niyetleri.
      return items.filter((i) => i.entityType === 'PAYMENT_INTENT' && i.apartmentId === apartmentId).map(fromStored);
    },

    async listIntents(apartmentId, q) {
      const { client, tableName } = getDynamo();
      const pk = tenantPk(apartmentId);
      let startKey: Record<string, unknown> | undefined;
      if (q.cursor) {
        try {
          const key = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
          // Imlec istemciden gelir: baska apartmanin veya baska kayit turunun anahtari kabul edilmez.
          if (key.PK !== pk || typeof key.SK !== 'string' || !key.SK.startsWith('PI#')) throw new Error('tenant');
          startKey = { PK: key.PK, SK: key.SK };
        } catch {
          throw new InvalidIntentCursorError();
        }
      }
      const items: PaymentIntent[] = [];
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :pfx)',
              ...(q.status ? { FilterExpression: '#status = :status' } : {}),
              ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK', ...(q.status ? { '#status': 'status' } : {}) },
              ExpressionAttributeValues: { ':pk': pk, ':pfx': 'PI#', ...(q.status ? { ':status': q.status } : {}) },
              ScanIndexForward: false,
              Limit: q.limit - items.length,
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          items.push(...((out.Items ?? []) as PaymentIntent[]));
          startKey = out.LastEvaluatedKey;
        } while (startKey && items.length < q.limit);
      } catch (err) {
        throw toDataAccessError(err);
      }
      const cursor = startKey ? Buffer.from(JSON.stringify(startKey)).toString('base64url') : undefined;
      return {
        items: items.filter((i) => i.entityType === 'PAYMENT_INTENT' && i.apartmentId === apartmentId).map(fromStored),
        cursor,
      };
    },

    async listReviewQueue(limit) {
      const { client, tableName } = getDynamo();
      const items: PaymentIntent[] = [];
      let startKey: QueryCommandOutput['LastEvaluatedKey'];
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'GSI1',
              KeyConditionExpression: 'GSI1PK = :pk',
              ExpressionAttributeValues: { ':pk': REVIEW_QUEUE_PK },
              Limit: limit - items.length,
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          items.push(...((out.Items ?? []) as PaymentIntent[]));
          startKey = out.LastEvaluatedKey;
        } while (startKey && items.length < limit);
      } catch (err) {
        throw toDataAccessError(err);
      }
      // Indeks ayni anda eventual consistent: durum yeniden kontrol edilir.
      return items
        .filter((i) => i.entityType === 'PAYMENT_INTENT' && REVIEW_QUEUE_STATUSES.includes(i.status))
        .map(fromStored);
    },

    getAccount: (apartmentId, provider) => getTenantItem<PaymentAccount>(paymentKeys.account(apartmentId, provider)),

    async putAccount(account, expectedVersion) {
      try {
        if (expectedVersion === undefined) await putNewItem(account);
        else await putVersionedItem(account, expectedVersion);
      } catch (err) {
        if (err instanceof DataAccessError && err.code !== 'conflict') throw err;
        conflictOr(err);
      }
    },
  };
}

export const paymentsRepository: PaymentsRepository = createPaymentsRepository();
