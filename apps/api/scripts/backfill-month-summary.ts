/**
 * P1-c: hesap-ay hareket ozeti (`MSUM#<YYYY-MM>#<hesap>`) doldurma ve dogrulama.
 *
 * P1-c sonrasi her defter yazimi ozeti atomik gunceller (canli `d/c/p`) ve islem kaydina `ms: 1`
 * yazar. Bu betik, P1-c ONCESI yazilmis (`ms` isaretsiz) islemlerin toplamlarini ayri eski
 * alanlara (`ld/lc/lp`) `SET` eder, sonra sitenin TUM defterini ozetle karsilastirir; fark yoksa
 * site `MSUMSTATE.ready` isaretlenir ve raporlar acik aylari ozetten okur. Fark varsa site
 * isaretlenmez (raporlar eski, dogru yolda kalir) ve farklar listelenir.
 *
 * Defter (TX/LE), bakiyeler, idempotency ve denetim zinciri DEGISMEZ. Tekrar calistirilabilir
 * (eski kume dondurulmus: ayni degerler yeniden SET edilir). Dagitim TAMAMLANDIKTAN sonra calistirin
 * (eski kodla calisan Lambda kalmadiginda); her ortamda bir kez.
 *
 *   $env:DYNAMODB_TABLE_NAME = terraform -chdir=../../infra output -raw dynamodb_table_name
 *   npm run backfill:month-summary -w @bm/api -- --dry-run
 *   npm run backfill:month-summary -w @bm/api
 *   npm run backfill:month-summary -w @bm/api -- --verify          # yazmaz; farklar ve hazir olmayan siteler
 *   npm run backfill:month-summary -w @bm/api -- --site <apartmentId>
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type CoreRepository, coreRepository } from '../src/modules/core/repository.js';
import { type MonthSummaryRepo, type ReconcileResult, reconcileMonthSummaries } from '../src/modules/finance/monthSummary.js';
import { financeRepository } from '../src/modules/finance/repository.js';
import type { Transaction } from '../src/modules/finance/types.js';

export type BackfillMonthSummaryResult = {
  sites: number;
  ready: number;
  legacyTransactions: number;
  legacyWritten: number;
  /** Dogrulamasi basarisiz (farkli) siteler. */
  mismatchedSites: string[];
  /** --verify: hazir isaretli olmayan siteler. */
  notReady: string[];
};

export async function backfillMonthSummary(
  deps: { core: Pick<CoreRepository, 'listSiteIds'>; finance: MonthSummaryRepo; isCounted?: (tx: Transaction) => boolean; log?: Pick<Console, 'info'> },
  options: { mode: 'apply' | 'dry-run' | 'verify'; site?: string },
): Promise<BackfillMonthSummaryResult> {
  const log = deps.log ?? console;
  const siteIds = options.site ? [options.site] : await deps.core.listSiteIds();
  const out: BackfillMonthSummaryResult = { sites: 0, ready: 0, legacyTransactions: 0, legacyWritten: 0, mismatchedSites: [], notReady: [] };
  for (const siteId of siteIds) {
    const r: ReconcileResult = await reconcileMonthSummaries(deps.finance, siteId, { mode: options.mode, ...(deps.isCounted ? { isCounted: deps.isCounted } : {}) });
    out.sites++;
    out.legacyTransactions += r.legacyTransactions;
    out.legacyWritten += r.legacyWritten;
    const state = await deps.finance.getMonthSummaryState(siteId);
    if (state?.ready) out.ready++;
    else out.notReady.push(siteId);
    if (r.mismatches.length) {
      out.mismatchedSites.push(siteId);
      log.info(`${siteId}: UYUSMAZLIK ${r.mismatches.length} (hesap, ay)`);
      for (const m of r.mismatches.slice(0, 10)) log.info(`  ${m.month} ${m.accountId}: beklenen ${JSON.stringify(m.expected)}, ozet ${JSON.stringify(m.actual)}`);
    } else {
      log.info(`${siteId}: ${r.transactions} islem (${r.legacyTransactions} eski), ${r.legacyWritten} eski toplam yazildi${options.mode === 'dry-run' ? ' (dry-run)' : ''}; ozet defterle birebir${state?.ready ? ', hazir' : ''}`);
    }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, verify: { type: 'boolean', default: false }, site: { type: 'string' } } });
  const mode = values.verify ? 'verify' : values['dry-run'] ? 'dry-run' : 'apply';
  const finance = financeRepository as unknown as MonthSummaryRepo;
  const r = await backfillMonthSummary({ core: coreRepository, finance }, { mode, ...(values.site ? { site: values.site } : {}) });
  console.info(
    `Bitti (${mode}): ${r.sites} site, ${r.ready} hazir, ${r.legacyTransactions} eski islem, ${r.legacyWritten} eski toplam yazildi. ` +
      `Uyusmazlik: ${r.mismatchedSites.length ? r.mismatchedSites.join(', ') : 'yok'}.${mode === 'verify' && r.notReady.length ? ` Hazir olmayan: ${r.notReady.join(', ')}.` : ''}`,
  );
  if (r.mismatchedSites.length || (mode === 'verify' && r.notReady.length)) process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
