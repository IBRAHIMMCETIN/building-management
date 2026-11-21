import { auditedPutNew, auditedPutVersioned, sendWithAudit } from '../audit/log.js';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  DataAccessError,
  getDynamo,
  getTenantItem,
  putNewItem,
  putVersionedItem,
  queryTenantAll,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import type { TableKeys } from '../core/types.js';
import {
  type IntentKeyRecord,
  type IntentRefRecord,
  type IntentStatus,
  type PaymentAccount,
  type PaymentIntent,
  type PaymentProviderName,
  type PaymentSettings,
  type PayoutRefRecord,
  type PayoutTransfer,
  type PlatformInvoice,
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
  /** Saglayici siparis kimligi -> niyet (tenant disi; yalnizca esleme). */
  ref: (provider: PaymentProviderName, reference: string): TableKeys => ({
    PK: ['PAYREF', provider, reference].join('#'),
    SK: 'PAYREF',
  }),
  /** P4: aktarim kaydi ve transfer kimligi -> apartman eslemesi. */
  payout: (apartmentId: string, transferId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PAYOUT', transferId),
  }),
  payoutRef: (provider: PaymentProviderName, reference: string): TableKeys => ({
    PK: ['PAYOUTREF', provider, reference].join('#'),
    SK: 'PAYOUTREF',
  }),
  /** P4: platform komisyon faturasi. */
  invoice: (apartmentId: string, invoiceId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PINV', invoiceId),
  }),
  /** Apartmanin online odeme tercihi (saglayici secimi). */
  settings: (apartmentId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PAYSETTINGS'),
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
  /**
   * Niyet + idempotency anahtari (+ varsa saglayici esleme kaydi) tek atomik yazimla; biri varsa
   * `PaymentsConflictError`.
   */
  createIntent(intent: PaymentIntent, key: IntentKeyRecord, ref?: IntentRefRecord): Promise<void>;
  getIntentRef(provider: PaymentProviderName, reference: string): Promise<IntentRefRecord | undefined>;
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
  getSettings(apartmentId: string): Promise<PaymentSettings | undefined>;
  /** Yeni aktarim kaydi + kimlik eslemesi (atomik); varsa `PaymentsConflictError`. */
  createPayout(payout: PayoutTransfer, ref: PayoutRefRecord): Promise<void>;
  /** Surum kosullu guncelleme (`payout.version === expectedVersion + 1`); ek esleme kaydi opsiyonel. */
  updatePayout(payout: PayoutTransfer, expectedVersion: number, ref?: PayoutRefRecord): Promise<void>;
  getPayout(apartmentId: string, transferId: string): Promise<PayoutTransfer | undefined>;
  getPayoutRef(provider: PaymentProviderName, reference: string): Promise<PayoutRefRecord | undefined>;
  /** Tum apartmanlarin aktarimlari, `sentAt >= fromSentAt` (GSI1, zamana gore). */
  listPayoutsSince(fromSentAt: string): Promise<PayoutTransfer[]>;
  getInvoice(apartmentId: string, invoiceId: string): Promise<PlatformInvoice | undefined>;
  /** Yeni (`expectedVersion` yok) veya surum kosullu. */
  putInvoice(invoice: PlatformInvoice, expectedVersion?: number): Promise<void>;
  listInvoices(apartmentId: string): Promise<PlatformInvoice[]>;
  /** Yeni kayit (`expectedVersion` yok) veya surum kosullu guncelleme; denetim kaydiyla. */
  putSettings(settings: PaymentSettings, expectedVersion?: number): Promise<void>;
};

/**
 * Odeme niyeti denetimi: olusturma ve her durum gecisi (mutabakat, NEEDS_REVIEW karari, iade).
 * Saglayici token'i ve kart verisi tasinmaz; yalnizca durum, tutar ve kararlar.
 */
function intentAudit(intent: PaymentIntent, action: string) {
  return {
    apartmentId: intent.apartmentId,
    action,
    target: { type: 'payment_intent', id: intent.intentId },
    actorId: intent.createdBy,
    reason: intent.resolution?.note,
    details: {
      status: intent.status,
      unitId: intent.unitId,
      amount: intent.amount,
      mode: intent.mode,
      providerPaymentId: intent.providerPaymentId,
      paymentIds: intent.paymentIds,
      failure: intent.failure?.code,
      review: intent.review?.reason,
      resolution: intent.resolution ? { action: intent.resolution.action, by: intent.resolution.by } : undefined,
      refund: intent.refund
        ? { items: intent.refund.items.length, requestedBy: intent.refund.requestedBy, completedAt: intent.refund.completedAt }
        : undefined,
      version: intent.version,
    },
  };
}

/** Aktarim indeksi (tum apartmanlar). */
export const PAYOUT_INDEX_PK = 'PAYOUT';
const MAX_PAYOUT_SCAN = 5_000;

export function toStoredPayout(p: PayoutTransfer): PayoutTransfer {
  return { ...p, GSI1PK: PAYOUT_INDEX_PK, GSI1SK: `${p.sentAt}#${p.transferId}#APT#${p.apartmentId}` } as PayoutTransfer;
}

function fromStoredPayout<T extends PayoutTransfer | undefined>(item: T): T {
  if (!item) return item;
  const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = item as PayoutTransfer & { GSI1PK?: string; GSI1SK?: string };
  return rest as T;
}

/** Aktarim denetimi: IBAN yok, yalnizca maskeli hali ve durum. */
function payoutAudit(p: PayoutTransfer, action: string) {
  return {
    apartmentId: p.apartmentId,
    action,
    target: { type: 'payout_transfer', id: p.transferId },
    actorId: p.resend?.requestedBy,
    reason: p.resend?.note,
    details: { status: p.status, intentId: p.intentId, amount: p.amount, ibanMasked: p.ibanMasked, returnedRef: p.returned?.refNo, version: p.version },
  };
}

function conflictOr(err: unknown): never {
  const mapped = toDataAccessError(err);
  if (mapped.code === 'conflict' || mapped.code === 'transaction_failed') throw new PaymentsConflictError();
  throw mapped;
}

export function createPaymentsRepository(): PaymentsRepository {
  return {
    getIntent: async (apartmentId, intentId) => fromStored(await getTenantItem<PaymentIntent>(paymentKeys.intent(apartmentId, intentId))),

    async createIntent(intent, key, ref) {
      if (intent.PK !== key.PK || intent.PK !== tenantPk(intent.apartmentId)) {
        throw new Error('Niyet ve anahtar ayni tenant olmali');
      }
      if (ref && (ref.apartmentId !== intent.apartmentId || ref.intentId !== intent.intentId)) {
        throw new Error('Esleme kaydi niyetle eslesmeli');
      }
      const { client, tableName } = getDynamo();
      try {
        await sendWithAudit(
          client,
          [
            { Put: { TableName: tableName, Item: key, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: tableName, Item: intent, ConditionExpression: 'attribute_not_exists(PK)' } },
            ...(ref ? [{ Put: { TableName: tableName, Item: ref, ConditionExpression: 'attribute_not_exists(PK)' } }] : []),
          ],
          intentAudit(intent, 'payment.intent.create'),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const reasons = err.CancellationReasons ?? [];
          if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) throw new PaymentsConflictError();
        }
        throw toDataAccessError(err);
      }
    },

    getIntentRef: (provider, reference) => getTenantItem<IntentRefRecord>(paymentKeys.ref(provider, reference)),

    getIntentKey: (apartmentId, userId, idempotencyKey) =>
      getTenantItem<IntentKeyRecord>(paymentKeys.intentKey(apartmentId, userId, idempotencyKey)),

    async updateIntent(intent, expectedVersion) {
      if (intent.version !== expectedVersion + 1) throw new Error('Niyet surumu bir artirilmali');
      try {
        await auditedPutVersioned(toStoredIntent(intent), expectedVersion, intentAudit(intent, `payment.intent.${intent.status.toLowerCase()}`));
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
        const audit = {
          apartmentId: account.apartmentId,
          action: expectedVersion === undefined ? 'payment.account.create' : 'payment.account.update',
          target: { type: 'payment_account', id: account.provider },
          actorId: account.updatedBy,
          details: { status: account.status, subMerchantType: account.subMerchantType, platformFeeBasisPoints: account.platformFeeBasisPoints },
        };
        if (expectedVersion === undefined) await auditedPutNew(account, audit);
        else await auditedPutVersioned(account, expectedVersion, audit);
      } catch (err) {
        if (err instanceof DataAccessError && err.code !== 'conflict') throw err;
        conflictOr(err);
      }
    },

    getSettings: (apartmentId) => getTenantItem<PaymentSettings>(paymentKeys.settings(apartmentId)),

    async createPayout(payout, ref) {
      const { client, tableName } = getDynamo();
      try {
        await sendWithAudit(
          client,
          [
            { Put: { TableName: tableName, Item: toStoredPayout(payout), ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: tableName, Item: ref, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
          payoutAudit(payout, 'payment.payout.sent'),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new PaymentsConflictError();
        }
        throw toDataAccessError(err);
      }
    },

    async updatePayout(payout, expectedVersion, ref) {
      if (payout.version !== expectedVersion + 1) throw new Error('Aktarim surumu bir artirilmali');
      const { client, tableName } = getDynamo();
      try {
        await sendWithAudit(
          client,
          [
            {
              Put: {
                TableName: tableName,
                Item: toStoredPayout(payout),
                ConditionExpression: '#v = :v',
                ExpressionAttributeNames: { '#v': 'version' },
                ExpressionAttributeValues: { ':v': expectedVersion },
              },
            },
            ...(ref ? [{ Put: { TableName: tableName, Item: ref, ConditionExpression: 'attribute_not_exists(PK)' } }] : []),
          ],
          payoutAudit(payout, `payment.payout.${payout.status.toLowerCase()}`),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new PaymentsConflictError();
        }
        throw toDataAccessError(err);
      }
    },

    getPayout: async (apartmentId, transferId) =>
      fromStoredPayout(await getTenantItem<PayoutTransfer>(paymentKeys.payout(apartmentId, transferId))),

    getPayoutRef: (provider, reference) => getTenantItem<PayoutRefRecord>(paymentKeys.payoutRef(provider, reference)),

    async listPayoutsSince(fromSentAt) {
      const { client, tableName } = getDynamo();
      const items: PayoutTransfer[] = [];
      let startKey: QueryCommandOutput['LastEvaluatedKey'];
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'GSI1',
              KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK >= :from',
              ExpressionAttributeValues: { ':pk': PAYOUT_INDEX_PK, ':from': fromSentAt },
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          items.push(...((out.Items ?? []) as PayoutTransfer[]));
          startKey = out.LastEvaluatedKey;
        } while (startKey && items.length < MAX_PAYOUT_SCAN);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return items.filter((p) => p.entityType === 'PAYOUT_TRANSFER').map((p) => fromStoredPayout(p) as PayoutTransfer);
    },

    getInvoice: (apartmentId, invoiceId) => getTenantItem<PlatformInvoice>(paymentKeys.invoice(apartmentId, invoiceId)),

    async putInvoice(invoice, expectedVersion) {
      try {
        const audit = {
          apartmentId: invoice.apartmentId,
          action: `payment.invoice.${invoice.status.toLowerCase()}`,
          target: { type: 'platform_invoice', id: invoice.invoiceId },
          actorId: invoice.issuedBy,
          details: { netAmount: invoice.netAmount, vatAmount: invoice.vatAmount, totalAmount: invoice.totalAmount, lines: invoice.lines.length, invoiceNumber: invoice.invoiceNumber, version: invoice.version },
        };
        if (expectedVersion === undefined) await auditedPutNew(invoice, audit);
        else await auditedPutVersioned(invoice, expectedVersion, audit);
      } catch (err) {
        if (err instanceof DataAccessError && err.code !== 'conflict') throw err;
        conflictOr(err);
      }
    },

    listInvoices: (apartmentId) =>
      queryTenantAll<PlatformInvoice>(apartmentId, 'PINV#').then((items) => items.filter((i) => i.entityType === 'PLATFORM_INVOICE')),

    async putSettings(settings, expectedVersion) {
      try {
        const audit = {
          apartmentId: settings.apartmentId,
          action: 'payment.settings.update',
          target: { type: 'payment_settings', id: settings.apartmentId },
          actorId: settings.updatedBy,
          details: { paymentProvider: settings.paymentProvider ?? null, version: settings.version },
        };
        if (expectedVersion === undefined) await auditedPutNew(settings, audit);
        else await auditedPutVersioned(settings, expectedVersion, audit);
      } catch (err) {
        if (err instanceof DataAccessError && err.code !== 'conflict') throw err;
        conflictOr(err);
      }
    },
  };
}

export const paymentsRepository: PaymentsRepository = createPaymentsRepository();
