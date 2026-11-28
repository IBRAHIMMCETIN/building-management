/**
 * Adim 2-3: hesap bazli SINIRLI okumalar (banka mutabakati, tedarikci acik kalemleri).
 *
 * 1) Banka mutabakati: ekstre kapanis / acilis gunundeki defter bakiyesi icin hesabin TUM `LE#`
 *    satirlari okunmaz. `LE#<hesap>#<YYYYMMDD-...>` anahtarlari islem tarihine gore sirali oldugu
 *    icin yalnizca kesim gununden SONRAKI satirlar okunur ve
 *        bakiye(gun sonu D) = hesap bakiyesi - SUM(tarih > D)
 *        bakiye(gun basi F) = hesap bakiyesi - SUM(tarih >= F)
 *    hesaplanir. Geriye tarihli kayit da kendi tarihinin anahtariyla yazildigi icin kacirilmaz.
 *    Es zamanli yazima karsi hesap surumu satirlardan once ve sonra okunur; degistiyse tekrar
 *    denenir, 3 denemede tutmazsa eski tam okuma yoluna dusulur. Sonuc eski yolla kurus kurus aynidir.
 *
 * 2) Tedarikci ozeti (`PSUM#<hesap>`): `payableSummary` sonucu hesap surumune MUHURLU olarak
 *    saklanir (P1-a `FSUM` ile ayni kural). Surum tutuyorsa defter okunmaz; tutmuyorsa (yeni
 *    fatura / odeme / ters kayit) eski yolla bir kez yeniden uretilir. Turetilmis veridir; defter
 *    (TX/LE), bakiyeler, idempotency ve denetim zinciri degismez; silme yoktur.
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import type { IsoDate, TableKeys } from '../core/types.js';
import { type PayableSummary, payableSummary } from './payables.js';
import type { Account, LedgerEntry, Transaction } from './types.js';

const signed = (e: Pick<LedgerEntry, 'side' | 'amount'>) => (e.side === 'debit' ? e.amount : -e.amount);

// ---------------------------------------------------------------------------
// 1) Sinir gunlerindeki bakiye
// ---------------------------------------------------------------------------

export type BoundaryQuery = {
  /** Bu gun SONU (dahil) bakiye. */
  through?: IsoDate;
  /** Bu gun BASI (haric) bakiye. */
  before?: IsoDate;
};

export type BoundaryBalances = { through?: number; before?: number; mode: 'bounded' | 'full'; entriesRead: number; attempts: number };

export type BoundaryDeps = {
  getAccount(apartmentId: string, accountId: string): Promise<Pick<Account, 'balance' | 'version'> | undefined>;
  /** Tarih araligi (dahil) ile hesap satirlari; yoksa tam okuma yolu kullanilir. */
  listAccountEntries?(apartmentId: string, accountId: string, range?: { from?: IsoDate; to?: IsoDate }): Promise<LedgerEntry[]>;
  /** Eski yol: hesabin tum satirlari. */
  listAllEntries(apartmentId: string, accountId: string): Promise<LedgerEntry[]>;
};

/** Eski (tam okuma) hesap: esdegerlik testlerinin referansi. */
export function boundaryBalancesFromAll(entries: readonly LedgerEntry[], accountId: string, q: BoundaryQuery): Pick<BoundaryBalances, 'through' | 'before'> {
  const own = entries.filter((e) => e.accountId === accountId);
  return {
    ...(q.through ? { through: own.filter((e) => e.date <= (q.through as IsoDate)).reduce((t, e) => t + signed(e), 0) } : {}),
    ...(q.before ? { before: own.filter((e) => e.date < (q.before as IsoDate)).reduce((t, e) => t + signed(e), 0) } : {}),
  };
}

const MAX_ATTEMPTS = 3;

export async function boundaryBalances(deps: BoundaryDeps, apartmentId: string, accountId: string, q: BoundaryQuery): Promise<BoundaryBalances> {
  if (!q.through && !q.before) return { mode: 'bounded', entriesRead: 0, attempts: 0 };
  const full = async (attempts: number): Promise<BoundaryBalances> => {
    const all = (await deps.listAllEntries(apartmentId, accountId)).filter((e) => e.siteId === apartmentId && e.accountId === accountId);
    return { ...boundaryBalancesFromAll(all, accountId, q), mode: 'full', entriesRead: all.length, attempts };
  };
  if (!deps.listAccountEntries) return full(0);
  // Kesim: istenen gunlerin en erkeni (through icin ertesi gun yeterli, ama ayni gunu okuyup
  // filtrelemek anahtar araligini basitlestirir).
  const cutoff = [q.through, q.before].filter((d): d is IsoDate => Boolean(d)).sort()[0] as IsoDate;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const before = await deps.getAccount(apartmentId, accountId);
    if (!before || typeof before.version !== 'number') return full(attempt);
    const recent = (await deps.listAccountEntries(apartmentId, accountId, { from: cutoff })).filter((e) => e.siteId === apartmentId && e.accountId === accountId);
    const after = await deps.getAccount(apartmentId, accountId);
    if (!after || after.version !== before.version || after.balance !== before.balance) continue;
    const balance = before.balance;
    return {
      ...(q.through ? { through: balance - recent.filter((e) => e.date > (q.through as IsoDate)).reduce((t, e) => t + signed(e), 0) } : {}),
      ...(q.before ? { before: balance - recent.filter((e) => e.date >= (q.before as IsoDate)).reduce((t, e) => t + signed(e), 0) } : {}),
      mode: 'bounded',
      entriesRead: recent.length,
      attempts: attempt,
    };
  }
  return full(MAX_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// 2) Tedarikci ozeti onbellegi (PSUM)
// ---------------------------------------------------------------------------

/** Ozet bicimi degisirse artirilir (eski kayitlar okunmaz, yeniden uretilir). */
export const PAYABLE_SUMMARY_SCHEMA = 2; // 2: avans mahsubu (`advanceApplied`, hedefli faturalar)
const MAX_PAYABLE_SUMMARY_BYTES = 300_000;

export const payableSummaryKeys = {
  item: (apartmentId: string, accountId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('PSUM', accountId) }),
};

export type PayableSummaryItem = TableKeys & {
  entityType: 'PAYABLE_SUMMARY';
  schema: number;
  siteId: string;
  accountId: string;
  /** Ozetin uretildigi andaki hesap surumu (`Account.version`; satirlardan ONCE okunur). */
  sourceVersion: number;
  computedAt: string;
  summary: PayableSummary;
};

export type PayableSummaryStore = {
  get(apartmentId: string, accountId: string): Promise<PayableSummaryItem | undefined>;
  /** Yalnizca kayit yoksa veya saklanan daha eski/ayni surumdeyse; cok buyukse yazmaz (false). */
  put(item: PayableSummaryItem): Promise<boolean>;
};

export function createDynamoPayableSummaryStore(): PayableSummaryStore {
  return {
    get: (apartmentId, accountId) => getTenantItem<PayableSummaryItem>(payableSummaryKeys.item(apartmentId, accountId)),
    async put(item) {
      const keys = payableSummaryKeys.item(item.siteId, item.accountId);
      if (item.PK !== keys.PK || item.SK !== keys.SK) throw new Error('Tedarikci ozeti anahtari tenant/hesapla uyusmuyor');
      if (Buffer.byteLength(JSON.stringify(item)) > MAX_PAYABLE_SUMMARY_BYTES) return false;
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK) OR #sv <= :sv',
            ExpressionAttributeNames: { '#sv': 'sourceVersion' },
            ExpressionAttributeValues: { ':sv': item.sourceVersion },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw toDataAccessError(err);
      }
    },
  };
}

export type PayableSummaryDeps = {
  store?: PayableSummaryStore;
  listAllEntries(apartmentId: string, accountId: string): Promise<LedgerEntry[]>;
  getTransactions(apartmentId: string, ids: string[]): Promise<Transaction[]>;
  now?: () => Date;
  log?: Pick<Console, 'warn'>;
};

/** Eski yol: hesabin tum satirlari + islem basliklari (referans hesap). */
export async function computePayableSummaryFull(deps: Pick<PayableSummaryDeps, 'listAllEntries' | 'getTransactions'>, apartmentId: string, accountId: string): Promise<PayableSummary> {
  const entries = (await deps.listAllEntries(apartmentId, accountId)).filter((e) => e.siteId === apartmentId && e.accountId === accountId);
  const ids = [...new Set(entries.map((e) => e.transactionId))];
  const txs = ids.length ? await deps.getTransactions(apartmentId, ids) : [];
  return payableSummary(accountId, entries, new Map(txs.map((t) => [t.transactionId, t])));
}

/**
 * Tedarikci ozeti. `account` cagiran tarafindan defter satirlarindan ONCE (tutarli) okunmus
 * olmalidir: saklanan ozet yalnizca `sourceVersion === account.version` ise kullanilir; yeni
 * uretilen ozet bu surumle etiketlenir (satirlar daha yeniyse bir sonraki okumada tazelenir).
 */
export async function loadPayableSummary(
  deps: PayableSummaryDeps,
  account: Pick<Account, 'siteId' | 'accountId' | 'version'>,
): Promise<{ summary: PayableSummary; source: 'cache' | 'computed' }> {
  const { siteId, accountId } = account;
  const version = typeof account.version === 'number' ? account.version : undefined;
  if (deps.store && version !== undefined) {
    const cached = await deps.store.get(siteId, accountId).catch(() => undefined);
    if (cached && cached.schema === PAYABLE_SUMMARY_SCHEMA && cached.siteId === siteId && cached.accountId === accountId && cached.sourceVersion === version) {
      return { summary: cached.summary, source: 'cache' };
    }
  }
  const summary = await computePayableSummaryFull(deps, siteId, accountId);
  if (deps.store && version !== undefined) {
    const item: PayableSummaryItem = {
      ...payableSummaryKeys.item(siteId, accountId),
      entityType: 'PAYABLE_SUMMARY',
      schema: PAYABLE_SUMMARY_SCHEMA,
      siteId,
      accountId,
      sourceVersion: version,
      computedAt: (deps.now ?? (() => new Date()))().toISOString(),
      summary,
    };
    // En iyi caba: yazim basarisizligi sonucu degistirmez.
    await deps.store.put(item).catch((err: unknown) => (deps.log ?? console).warn(JSON.stringify({ level: 'warn', msg: 'payable_summary_put_failed', siteId, accountId, error: String(err) })));
  }
  return { summary, source: 'computed' };
}
