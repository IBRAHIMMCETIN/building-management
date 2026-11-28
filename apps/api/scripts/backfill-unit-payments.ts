/**
 * Adim 2-1: daire makbuz dizini (GSI1 `UPAY#<apartmentId>#<unitId>`) doldurma ve dogrulama.
 *
 * Adim 2 sonrasi her makbuz kaydi dizin anahtarlariyla yazilir. Bu betik, ONCESINDE yazilmis
 * makbuzlara yalnizca dizin anahtarlarini ekler (kosullu `SET`; makbuz icerigi, defter TX/LE,
 * bakiyeler, idempotency ve denetim zinciri DEGISMEZ; silme yok). Tum makbuzlar beklenen anahtara
 * sahipse site `UPAYSTATE.ready` isaretlenir ve sakin portali makbuzlari daire dizininden okur.
 * Isaretlenmeyen site eski (tam tarama) yolda kalir; sonuc ayni, yalnizca yavas.
 *
 * Tekrar calistirilabilir. Dagitim TAMAMLANDIKTAN sonra (eski kodla calisan Lambda kalmadiginda)
 * her ortamda bir kez calistirin; aksi halde eski kodun yazdigi dizinsiz makbuz `ready` sonrasi
 * portalda gorunmez.
 *
 *   $env:DYNAMODB_TABLE_NAME = terraform -chdir=../../infra output -raw dynamodb_table_name
 *   npm run backfill:unit-payments -w @bm/api -- --dry-run
 *   npm run backfill:unit-payments -w @bm/api
 *   npm run backfill:unit-payments -w @bm/api -- --verify        # yazmaz; daire bazli dizin = eski yol (kurus)
 *   npm run backfill:unit-payments -w @bm/api -- --site <apartmentId>
 *
 * Cikis kodu: 0 basarili; 2 eksik anahtar / cakisma / uyusmazlik / hazir olmayan site (verify).
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type CoreRepository, coreRepository } from '../src/modules/core/repository.js';
import { type UnitPaymentStore, createDynamoUnitPaymentStore, reconcileUnitPayments } from '../src/modules/finance/unitPayments.js';

export type BackfillUnitPaymentsResult = {
  sites: number;
  ready: number;
  payments: number;
  missing: number;
  written: number;
  conflictSites: string[];
  mismatchedSites: string[];
  notReady: string[];
};

export async function backfillUnitPayments(
  deps: { core: Pick<CoreRepository, 'listSiteIds'>; store: UnitPaymentStore; log?: Pick<Console, 'info'> },
  options: { mode: 'apply' | 'dry-run' | 'verify'; site?: string },
): Promise<BackfillUnitPaymentsResult> {
  const log = deps.log ?? console;
  const siteIds = options.site ? [options.site] : await deps.core.listSiteIds();
  const out: BackfillUnitPaymentsResult = { sites: 0, ready: 0, payments: 0, missing: 0, written: 0, conflictSites: [], mismatchedSites: [], notReady: [] };
  for (const siteId of siteIds) {
    const r = await reconcileUnitPayments(deps.store, siteId, options.mode);
    out.sites++;
    out.payments += r.payments;
    out.missing += r.missing;
    out.written += r.written;
    if (r.ready) out.ready++;
    else out.notReady.push(siteId);
    if (r.conflicts.length) {
      out.conflictSites.push(siteId);
      log.info(`${siteId}: ${r.conflicts.length} makbuzda GSI1 baska amacla dolu (yazilmadi): ${r.conflicts.slice(0, 10).join(', ')}`);
    }
    if (r.unitMismatches.length) {
      out.mismatchedSites.push(siteId);
      log.info(`${siteId}: UYUSMAZLIK ${r.unitMismatches.length} daire`);
      for (const m of r.unitMismatches.slice(0, 10)) log.info(`  ${m.unitId}: eski ${m.legacy} makbuz / ${m.legacyTotal} kurus, dizin ${m.indexed} / ${m.indexedTotal} kurus`);
    }
    log.info(
      `${siteId}: ${r.payments} makbuz, ${r.missing} dizinsiz${options.mode === 'apply' ? `, ${r.written} yazildi` : ''}${r.ready ? ', hazir' : ''}${options.mode === 'dry-run' ? ' (dry-run)' : ''}`,
    );
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, verify: { type: 'boolean', default: false }, site: { type: 'string' } } });
  const mode = values.verify ? 'verify' : values['dry-run'] ? 'dry-run' : 'apply';
  const r = await backfillUnitPayments({ core: coreRepository, store: createDynamoUnitPaymentStore() }, { mode, ...(values.site ? { site: values.site } : {}) });
  console.info(
    `Bitti (${mode}): ${r.sites} site, ${r.ready} hazir, ${r.payments} makbuz, ${r.missing} dizinsiz, ${r.written} yazildi. ` +
      `Cakisma: ${r.conflictSites.length ? r.conflictSites.join(', ') : 'yok'}. Uyusmazlik: ${r.mismatchedSites.length ? r.mismatchedSites.join(', ') : 'yok'}.` +
      `${r.notReady.length ? ` Hazir olmayan: ${r.notReady.join(', ')}.` : ''}`,
  );
  const failed = r.conflictSites.length > 0 || r.mismatchedSites.length > 0 || (mode !== 'dry-run' && r.notReady.length > 0) || (mode === 'verify' && r.missing > 0);
  if (failed) process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
