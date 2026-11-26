/**
 * P1-a: alt cari ozetlerinin okunmasi / tazelenmesi (I/O).
 *
 * Gecerlilik kurali (eventual inconsistency YOK):
 *  - Her defter yazimi (`postBatch`) satir yazdigi her hesabin `version` alanini, satirlarla AYNI
 *    TransactWriteItems icinde `ADD #version :one` ile arttirir.
 *  - Ozet, uretildigi andaki hesap surumunu (`sourceVersion`) tasir ve yalnizca
 *    `sourceVersion === Account.version` iken kullanilir. Surum, ozetin kaynagi olan satirlar
 *    okunmadan ONCE (tutarli `listAccounts`) alinir; satirlar daha yeni olsa bile ozet eski
 *    surumle etiketlenir ve bir sonraki okumada yeniden uretilir (asla bayat ozet donmez).
 *  - Ters kayit ayni hesaplara yazildigi icin iptaller de surumu arttirir.
 *
 * Bayat / eksik ozet, yalnizca o hesabin kendi defter satirlarindan (`LE#<hesap>#...` + BatchGet)
 * uretilir; sitenin tum defteri okunmaz. Ozet yazimi en iyi caba ile yapilir (basarisizlik sonucu
 * degistirmez). Defter (TX/LE) kayitlarina hic dokunulmaz.
 */
import type { IsoDate } from '../core/types.js';
import { ACCOUNT_SUMMARY_SCHEMA, type AccountSummaryItem, type DuesCore, coreServes, summarizeLines, summaryHorizon } from './accountSummary.js';
import { type FinanceRepository, accountTransactions, financeKeys } from './repository.js';
import { cancelledIn, linesOfAccount } from './subledger.js';
import type { Account } from './types.js';

export type SummaryRepo = Pick<FinanceRepository, 'listTransactions'> &
  Partial<Pick<FinanceRepository, 'listAccountEntries' | 'getTransactions' | 'listAccountSummaries' | 'putAccountSummary'>>;

export type CoreLoadStats = {
  /** summary: saklanan ozet + hesap kapsamli tazeleme; scan: depo hesap okuyucusu yok (tek tam tarama). */
  mode: 'summary' | 'scan';
  accounts: number;
  cached: number;
  refreshed: number;
  persisted: number;
};

export type CoreLoadOptions = {
  /** Sorgulanacak en eski gun (tazminat asOf); ozet ufku bundan sonra olamaz. */
  asOf: IsoDate;
  /** Bugun (Istanbul); saklanacak ozetin ufku bundan turetilir. */
  today: IsoDate;
  computedAt?: string;
  /** Es zamanli hesap okumasi (varsayilan 16). */
  concurrency?: number;
  /** false: ozet yazilmaz (salt okunur cagiran). Varsayilan true. */
  persist?: boolean;
};

/** Daireye bagli alacak hesaplari (ozet yalnizca bunlar icin tutulur). */
export const summarizable = (a: Account): boolean => a.type === 'receivable' && Boolean(a.unitId) && Boolean(a.liableParty);

export function isFreshSummary(item: AccountSummaryItem | undefined, account: Account, asOf: IsoDate): item is AccountSummaryItem {
  return (
    !!item &&
    item.schema === ACCOUNT_SUMMARY_SCHEMA &&
    item.siteId === account.siteId &&
    item.accountId === account.accountId &&
    typeof account.version === 'number' &&
    item.sourceVersion === account.version &&
    coreServes(item.core, asOf)
  );
}

export function toSummaryItem(account: Account, core: DuesCore, computedAt: string): AccountSummaryItem {
  return {
    ...financeKeys.accountSummary(account.siteId, account.accountId),
    entityType: 'ACCOUNT_SUMMARY',
    schema: ACCOUNT_SUMMARY_SCHEMA,
    siteId: account.siteId,
    accountId: account.accountId,
    sourceVersion: account.version,
    computedAt,
    core,
  };
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Verilen hesaplarin ozetleri. `accounts` cagiranin AZ ONCE (tutarli) okudugu hesaplar olmalidir:
 * gecerlilik onlarin `version` alanina gore denetlenir.
 */
export async function loadAccountCores(
  repo: SummaryRepo,
  apartmentId: string,
  accounts: readonly Account[],
  opts: CoreLoadOptions,
): Promise<{ cores: Map<string, DuesCore>; stats: CoreLoadStats }> {
  const targets = accounts.filter((a) => a.siteId === apartmentId);
  const cores = new Map<string, DuesCore>();
  const stats: CoreLoadStats = { mode: 'summary', accounts: targets.length, cached: 0, refreshed: 0, persisted: 0 };
  if (targets.length === 0) return { cores, stats };

  if (!repo.listAccountEntries || !repo.getTransactions) {
    // Hesap okuyucusu olmayan depo (eski test sahteleri): tek tam tarama, ozet yazilmaz.
    const all = (await repo.listTransactions(apartmentId)).items;
    const cancelled = cancelledIn(all);
    for (const a of targets) cores.set(a.accountId, summarizeLines(linesOfAccount(a.accountId, all), cancelled));
    return { cores, stats: { ...stats, mode: 'scan', refreshed: targets.length } };
  }

  const stored = new Map<string, AccountSummaryItem>();
  if (repo.listAccountSummaries) {
    for (const item of await repo.listAccountSummaries(apartmentId)) {
      if (item.siteId === apartmentId) stored.set(item.accountId, item);
    }
  }
  const stale: Account[] = [];
  for (const a of targets) {
    const item = stored.get(a.accountId);
    if (isFreshSummary(item, a, opts.asOf)) {
      cores.set(a.accountId, item.core);
      stats.cached++;
    } else stale.push(a);
  }

  const horizon = summaryHorizon(opts.today, opts.asOf);
  const computedAt = opts.computedAt ?? new Date().toISOString();
  const persist = opts.persist !== false && Boolean(repo.putAccountSummary);
  await mapLimit(stale, opts.concurrency ?? 16, async (a) => {
    // Yalnizca bu hesabin satirlari (LE# + BatchGet); ters kayitlar da ayni hesaba yazilir.
    const txs = await accountTransactions(repo, apartmentId, [a.accountId]);
    const core = summarizeLines(linesOfAccount(a.accountId, txs), undefined, horizon);
    cores.set(a.accountId, core);
    stats.refreshed++;
    if (persist && typeof a.version === 'number') {
      try {
        if (await repo.putAccountSummary?.(toSummaryItem(a, core, computedAt))) stats.persisted++;
      } catch {
        // En iyi caba: ozet yazilamadiysa sonuc yine dogrudur; sonraki okuma yeniden uretir.
      }
    }
  });
  return { cores, stats };
}

/**
 * Sitenin tum alt cari ozetlerini tazeler (bayat olanlari yeniden uretir ve yazar). Toplu tahakkuk,
 * gecikme tazminati kesinlestirmesi ve backfill betigi sonrasinda cagrilir; istek yolu boylece
 * yalnizca son tazelemeden beri degisen hesaplari okur.
 */
export async function refreshAccountSummaries(
  repo: SummaryRepo & Pick<FinanceRepository, 'listAccounts'>,
  apartmentId: string,
  opts: { today: IsoDate; computedAt?: string; concurrency?: number },
): Promise<CoreLoadStats> {
  const accounts = (await repo.listAccounts(apartmentId)).filter(summarizable);
  const { stats } = await loadAccountCores(repo, apartmentId, accounts, { asOf: opts.today, today: opts.today, computedAt: opts.computedAt, concurrency: opts.concurrency });
  return stats;
}
