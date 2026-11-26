/**
 * P1-a: alt cari ozetlerini (`FSUM#<hesap>`) doldurur / tazeler ve istenirse eski tam-defter
 * hesabiyla karsilastirir.
 *
 * Ozet turetilmis veridir: defter (TX/LE), hesap bakiyeleri, idempotency ve denetim zinciri
 * DEGISMEZ. Ozet olmadan da sistem dogru calisir (istek yolu eksik/bayat ozeti hesabin kendi
 * satirlarindan uretir); bu betik ilk istegin yuklenmesini onler ve dogrulama saglar.
 *
 * Tekrar calistirilabilir (idempotent): surumu tutan (taze) ozet atlanir; yazim kosulludur
 * (`sourceVersion` daha yeniyse yazilmaz). Her ortamda guvenle calistirilir.
 *
 *   $env:DYNAMODB_TABLE_NAME = terraform -chdir=../../infra output -raw dynamodb_table_name
 *   npm run backfill:finance-summary -w @bm/api -- --dry-run
 *   npm run backfill:finance-summary -w @bm/api
 *   npm run backfill:finance-summary -w @bm/api -- --verify            # eski hesapla birebir karsilastir
 *   npm run backfill:finance-summary -w @bm/api -- --site <apartmentId>
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type CoreRepository, coreRepository } from '../src/modules/core/repository.js';
import type { IsoDate } from '../src/modules/core/types.js';
import { buildDuesStatusFromCores, coreEntries } from '../src/modules/finance/accountSummary.js';
import { type SummaryRepo, loadAccountCores, summarizable } from '../src/modules/finance/accountSummaryStore.js';
import { buildDuesStatus } from '../src/modules/finance/reports.js';
import { type FinanceRepository, financeRepository } from '../src/modules/finance/repository.js';

const DEFAULT_RATE = 500;

export type BackfillFinanceSummaryDeps = {
  core: Pick<CoreRepository, 'listSiteIds' | 'listUnits'> & Partial<Pick<CoreRepository, 'getSite'>>;
  finance: SummaryRepo & Pick<FinanceRepository, 'listAccounts'>;
  today: () => IsoDate;
  log?: Pick<Console, 'info'>;
};

export type BackfillFinanceSummaryResult = {
  sites: number;
  accounts: number;
  fresh: number;
  refreshed: number;
  written: number;
  /** --verify: ozetten uretilen aidat durumu eski tam-defter hesabindan farkli olan siteler. */
  mismatchedSites: string[];
};

export async function backfillFinanceSummary(
  deps: BackfillFinanceSummaryDeps,
  options: { dryRun?: boolean; verify?: boolean; site?: string; concurrency?: number } = {},
): Promise<BackfillFinanceSummaryResult> {
  const log = deps.log ?? console;
  const today = deps.today();
  const siteIds = options.site ? [options.site] : await deps.core.listSiteIds();
  const result: BackfillFinanceSummaryResult = { sites: 0, accounts: 0, fresh: 0, refreshed: 0, written: 0, mismatchedSites: [] };
  for (const siteId of siteIds) {
    const accounts = await deps.finance.listAccounts(siteId);
    const targets = accounts.filter(summarizable);
    const { cores, stats } = await loadAccountCores(deps.finance, siteId, targets, {
      asOf: today,
      today,
      concurrency: options.concurrency ?? 8,
      persist: !options.dryRun,
    });
    result.sites++;
    result.accounts += stats.accounts;
    result.fresh += stats.cached;
    result.refreshed += stats.refreshed;
    result.written += stats.persisted;
    log.info(`${siteId}: ${stats.accounts} alt cari, ${stats.cached} taze, ${stats.refreshed} yeniden uretildi, ${stats.persisted} yazildi${options.dryRun ? ' (dry-run)' : ''}`);

    if (options.verify) {
      const [units, site] = await Promise.all([deps.core.listUnits(siteId), deps.core.getSite ? deps.core.getSite(siteId) : Promise.resolve(undefined)]);
      const rate = site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_RATE;
      // Eski yol (tum defter) - yalnizca dogrulama icin; istek yolunda kullanilmaz.
      const all = (await deps.finance.listTransactions(siteId)).items;
      const receivables = new Set(accounts.filter((a) => a.type === 'receivable').map((a) => a.accountId));
      const legacy = buildDuesStatus(units, all, receivables, today, rate);
      const fromCores = buildDuesStatusFromCores(units, coreEntries(accounts, cores), today, rate);
      if (JSON.stringify(legacy) !== JSON.stringify(fromCores)) {
        result.mismatchedSites.push(siteId);
        log.info(`${siteId}: UYUSMAZLIK - ozetten uretilen aidat durumu eski hesaptan farkli`);
      } else {
        log.info(`${siteId}: dogrulandi (${legacy.length} bagimsiz bolum, ${all.length} defter islemi)`);
      }
    }
  }
  return result;
}

const istanbulToday = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      site: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)) throw new Error('--concurrency 1-64 olmali');
  const r = await backfillFinanceSummary(
    { core: coreRepository, finance: financeRepository, today: istanbulToday },
    { dryRun: values['dry-run'], verify: values.verify, ...(values.site ? { site: values.site } : {}), ...(concurrency ? { concurrency } : {}) },
  );
  console.info(
    `Bitti: ${r.sites} site, ${r.accounts} alt cari, ${r.fresh} taze, ${r.refreshed} yeniden uretildi, ${r.written} yazildi.` +
      (values.verify ? ` Uyusmazlik: ${r.mismatchedSites.length ? r.mismatchedSites.join(', ') : 'yok'}.` : ''),
  );
  if (r.mismatchedSites.length) process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
