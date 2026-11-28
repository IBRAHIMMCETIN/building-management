/**
 * Adim 2-1: daire bazli tahsilat (makbuz) dizini.
 *
 * Eskiden sakin portali her istekte sitenin TUM `PAY#` kayitlarini okuyup bellekte daireye gore
 * filtreliyordu (300-500 daire x yillar -> on binlerce kayit). Simdi her makbuz kaydi yazilirken
 * seyrek GSI1 anahtarlari alir:
 *   GSI1PK = `UPAY#<apartmentId>#<unitId>`,  GSI1SK = `<paidAt>#<paymentId>`
 * ve portal yalnizca o dairenin makbuzlarini sorgular.
 *
 * Kurallar:
 *  - Makbuz kaydinin icerigi degismez; yalnizca dizin anahtarlari eklenir (defter TX/LE, bakiyeler,
 *    idempotency ve denetim zinciri DEGISMEZ; silme yok).
 *  - Dizin yalnizca site `UPAYSTATE.ready` iken kullanilir (Adim 2 sonrasi acilan site veya
 *    `backfill:unit-payments` ile dogrulanmis site). Aksi halde eski tam tarama yolu - sonuc ayni.
 *  - GSI okumasi nihai tutarlidir (ms mertebesinde gecikme). Yeni yazilmis makbuzu hemen bulmasi
 *    gereken cagiran (`receiptForTransaction`) bulamazsa `consistent: true` ile eski yola duser.
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand, type QueryCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { KEY_SEPARATOR, getDynamo, getTenantItem, queryTenantAll, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import type { TableKeys } from '../core/types.js';
import type { Payment } from './types.js';

export const UNIT_PAYMENT_INDEX_PREFIX = 'UPAY';
export const PAYMENT_PREFIX = `PAY${KEY_SEPARATOR}`;

export const unitPaymentKeys = {
  index: (apartmentId: string, unitId: string, paidAt: string, paymentId: string) => ({
    GSI1PK: `${UNIT_PAYMENT_INDEX_PREFIX}${KEY_SEPARATOR}${apartmentId}${KEY_SEPARATOR}${unitId}`,
    GSI1SK: `${paidAt}${KEY_SEPARATOR}${paymentId}`,
  }),
  state: (apartmentId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: 'UPAYSTATE' }),
};

export type UnitPaymentIndexState = TableKeys & {
  entityType: 'UNIT_PAYMENT_INDEX_STATE';
  siteId: string;
  ready: boolean;
  /** `new_site`: Adim 2 sonrasi acilan site (dizinsiz makbuz yok); `backfill`: betikle dogrulandi. */
  source: 'new_site' | 'backfill';
  readyAt: string;
};

/** Makbuz kaydinin beklenen dizin anahtarlari. */
export function expectedPaymentIndex(p: Pick<Payment, 'siteId' | 'unitId' | 'paidAt' | 'paymentId'>) {
  return unitPaymentKeys.index(p.siteId, p.unitId, p.paidAt, p.paymentId);
}

/**
 * `postBatch` yazimlarinda kullanilir: `PAYMENT` kayitlarina dizin anahtarlarini ekler, diger
 * kayitlari oldugu gibi birakir. Kayit nesnesi kopyalanir (cagiranin nesnesi degismez).
 */
export function withPaymentIndex<T extends { entityType?: unknown }>(record: T): T {
  if (record.entityType !== 'PAYMENT') return record;
  const p = record as unknown as Payment;
  if (!p.siteId || !p.unitId || !p.paidAt || !p.paymentId) return record;
  return { ...record, ...expectedPaymentIndex(p) };
}

export function hasExpectedIndex(item: Payment & { GSI1PK?: string; GSI1SK?: string }): boolean {
  const e = expectedPaymentIndex(item);
  return item.GSI1PK === e.GSI1PK && item.GSI1SK === e.GSI1SK;
}

/** Dizin anahtarlarini cikarir (API yanitlari / esdegerlik karsilastirmasi). */
export function stripIndex<T extends object>(item: T): Omit<T, 'GSI1PK' | 'GSI1SK'> {
  const { GSI1PK: _p, GSI1SK: _s, ...rest } = item as T & { GSI1PK?: string; GSI1SK?: string };
  return rest as Omit<T, 'GSI1PK' | 'GSI1SK'>;
}

// ---------------------------------------------------------------------------
// DynamoDB erisimi
// ---------------------------------------------------------------------------

export type UnitPaymentStore = {
  getState(apartmentId: string): Promise<UnitPaymentIndexState | undefined>;
  markReady(apartmentId: string, source: UnitPaymentIndexState['source'], opts?: { onlyIfAbsent?: boolean }): Promise<boolean>;
  /** Eski yol: sitenin tum makbuzlari (tutarli okuma). */
  listAllPayments(apartmentId: string): Promise<(Payment & { GSI1PK?: string; GSI1SK?: string })[]>;
  /** Dizin yolu: dairenin makbuzlari (GSI1, nihai tutarli). */
  queryUnitPayments(apartmentId: string, unitId: string): Promise<Payment[]>;
  /** Backfill: kayda dizin anahtarlarini ekler (yalnizca anahtar yok veya ayniysa; icerik degismez). */
  setPaymentIndex(payment: Payment): Promise<'written' | 'skipped'>;
};

export function createDynamoUnitPaymentStore(): UnitPaymentStore {
  return {
    getState: (apartmentId) => getTenantItem<UnitPaymentIndexState>(unitPaymentKeys.state(apartmentId)),
    async markReady(apartmentId, source, opts = {}) {
      const { client, tableName } = getDynamo();
      const item: UnitPaymentIndexState = {
        ...unitPaymentKeys.state(apartmentId),
        entityType: 'UNIT_PAYMENT_INDEX_STATE',
        siteId: apartmentId,
        ready: true,
        source,
        readyAt: new Date().toISOString(),
      };
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item, ...(opts.onlyIfAbsent ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}) }));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw toDataAccessError(err);
      }
    },
    listAllPayments: (apartmentId) => queryTenantAll<Payment & { GSI1PK?: string; GSI1SK?: string }>(apartmentId, PAYMENT_PREFIX, { ConsistentRead: true }),
    async queryUnitPayments(apartmentId, unitId) {
      const { client, tableName } = getDynamo();
      const pk = unitPaymentKeys.index(apartmentId, unitId, '', '').GSI1PK;
      const items: Payment[] = [];
      let startKey: QueryCommandOutput['LastEvaluatedKey'];
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'GSI1',
              KeyConditionExpression: 'GSI1PK = :pk',
              ExpressionAttributeValues: { ':pk': pk },
              ExclusiveStartKey: startKey,
            }),
          );
          for (const item of out.Items ?? []) {
            // Kiraci izolasyonu: dizin anahtari apartman kimligini icerir; yine de kayit dogrulanir.
            if (item.entityType === 'PAYMENT' && item.siteId === apartmentId && item.unitId === unitId) items.push(stripIndex(item as Payment) as Payment);
          }
          startKey = out.LastEvaluatedKey;
        } while (startKey);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return items;
    },
    async setPaymentIndex(payment) {
      const { client, tableName } = getDynamo();
      const idx = expectedPaymentIndex(payment);
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: payment.PK, SK: payment.SK },
            UpdateExpression: 'SET #gpk = :gpk, #gsk = :gsk',
            // Yalnizca var olan makbuz kaydi; baska amacla dolu GSI1 anahtari ezilmez.
            ConditionExpression: 'attribute_exists(PK) AND #et = :payment AND (attribute_not_exists(#gpk) OR (#gpk = :gpk AND #gsk = :gsk))',
            ExpressionAttributeNames: { '#gpk': 'GSI1PK', '#gsk': 'GSI1SK', '#et': 'entityType' },
            ExpressionAttributeValues: { ':gpk': idx.GSI1PK, ':gsk': idx.GSI1SK, ':payment': 'PAYMENT' },
          }),
        );
        return 'written';
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'skipped';
        throw toDataAccessError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Okuma yolu (portal / belgeler)
// ---------------------------------------------------------------------------

export type UnitPaymentReader = {
  /** `consistent: true`: eski tutarli tam tarama (yeni yazilmis makbuz icin yedek yol). */
  list(apartmentId: string, unitId: string, opts?: { consistent?: boolean }): Promise<Payment[]>;
};

/**
 * Site hazirsa dizinden, degilse eski yoldan okur. `ready` durumu kalicidir (geri alinmaz):
 * konteyner icinde yalnizca olumlu sonuc onbelleklenir.
 */
export function createUnitPaymentReader(store: Pick<UnitPaymentStore, 'getState' | 'listAllPayments' | 'queryUnitPayments'>): UnitPaymentReader {
  const readySites = new Set<string>();
  async function isReady(apartmentId: string): Promise<boolean> {
    if (readySites.has(apartmentId)) return true;
    const state = await store.getState(apartmentId);
    if (state?.ready) readySites.add(apartmentId);
    return Boolean(state?.ready);
  }
  return {
    async list(apartmentId, unitId, opts = {}) {
      if (!opts.consistent && (await isReady(apartmentId))) return store.queryUnitPayments(apartmentId, unitId);
      return (await store.listAllPayments(apartmentId)).filter((p) => p.unitId === unitId).map((p) => stripIndex(p) as Payment);
    },
  };
}

// ---------------------------------------------------------------------------
// Backfill / dogrulama (scripts/backfill-unit-payments.ts)
// ---------------------------------------------------------------------------

export type UnitPaymentReconcileResult = {
  payments: number;
  missing: number;
  written: number;
  /** Baska amacla dolu GSI1 anahtari olan (yazilamayan) makbuzlar. */
  conflicts: string[];
  /** --verify: dizin sorgusu ile eski yolun daire bazli uyusmadigi daireler. */
  unitMismatches: { unitId: string; legacy: number; indexed: number; legacyTotal: number; indexedTotal: number }[];
  ready: boolean;
};

const fingerprint = (list: Payment[]) =>
  list
    .map((p) => `${p.paymentId}|${p.amount}|${p.paidAt}|${p.liableParty}|${p.transactionId}`)
    .sort()
    .join('\n');

/**
 * Bir sitenin makbuzlarini dizinle esitler.
 *  - `dry-run`: yazmaz; eksik anahtar sayisini raporlar.
 *  - `apply`: eksik anahtarlari yazar; hepsi beklenen anahtara sahipse site `ready` isaretlenir.
 *  - `verify`: yazmaz; ayrica her daire icin dizin sorgusunu eski yolla kurus kurus karsilastirir.
 */
export async function reconcileUnitPayments(
  store: UnitPaymentStore,
  apartmentId: string,
  mode: 'apply' | 'dry-run' | 'verify',
): Promise<UnitPaymentReconcileResult> {
  const all = await store.listAllPayments(apartmentId);
  const out: UnitPaymentReconcileResult = { payments: all.length, missing: 0, written: 0, conflicts: [], unitMismatches: [], ready: false };
  for (const p of all) {
    if (hasExpectedIndex(p)) continue;
    out.missing++;
    if (mode !== 'apply') continue;
    if ((await store.setPaymentIndex(stripIndex(p) as Payment)) === 'written') out.written++;
    else out.conflicts.push(p.paymentId);
  }
  if (mode === 'apply' && out.conflicts.length === 0) {
    // Yazilanlar tutarli okumayla yeniden dogrulanir; eksik kalmadiysa site hazir.
    const after = await store.listAllPayments(apartmentId);
    if (after.every(hasExpectedIndex)) {
      await store.markReady(apartmentId, 'backfill');
    }
  }
  if (mode === 'verify') {
    const byUnit = new Map<string, Payment[]>();
    for (const p of all) byUnit.set(p.unitId, [...(byUnit.get(p.unitId) ?? []), stripIndex(p) as Payment]);
    for (const [unitId, legacy] of byUnit) {
      const indexed = await store.queryUnitPayments(apartmentId, unitId);
      const legacyTotal = legacy.reduce((s, p) => s + p.amount, 0);
      const indexedTotal = indexed.reduce((s, p) => s + p.amount, 0);
      if (fingerprint(legacy) !== fingerprint(indexed) || legacyTotal !== indexedTotal) {
        out.unitMismatches.push({ unitId, legacy: legacy.length, indexed: indexed.length, legacyTotal, indexedTotal });
      }
    }
  }
  out.ready = Boolean((await store.getState(apartmentId))?.ready);
  return out;
}
