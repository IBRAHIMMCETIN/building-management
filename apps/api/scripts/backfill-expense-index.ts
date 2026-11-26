/**
 * Gider tarih dizini doldurma (bir defalik): tarih dizini (GSI1 `EXPDATE#<apartmentId>`)
 * eklenmeden once yazilan gider kayitlarina dizin anahtarlarini ekler. Yeni giderler dizine
 * yazim aninda girer; bu betik yalnizca eskiler icindir. Dizinde olmayan gider, gider
 * secicilerinde (sayac donemi faturasi, talep masrafi baglama) gorunmez.
 *
 * Tekrar calistirilabilir: dizin anahtari olan kayit atlanir (kosullu yazim). Yalnizca
 * GSI1PK/GSI1SK eklenir; giderin diger alanlarina dokunulmaz (defter TX/LE kayitlari etkilenmez).
 * Tablo taramasi (Scan) gerektirir: betik yonetici kimligiyle (aws login) calistirilir.
 *
 *   $env:DYNAMODB_TABLE_NAME = terraform -chdir=../../infra output -raw dynamodb_table_name
 *   npm run backfill:expense-index -- --dry-run
 *   npm run backfill:expense-index
 *   npm run backfill:expense-index -- --verify   # P1-b: tum giderlerin dizin anahtarlari dogru mu (yazmaz)
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, type ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo } from '../src/config/dynamodb.js';
import { financeKeys } from '../src/modules/finance/repository.js';

type Client = { send(command: ScanCommand | UpdateCommand): Promise<unknown> };

export type ExpenseIndexVerifyResult = {
  /** Taranan gider kaydi. */
  scanned: number;
  /** Dizin anahtari dogru (`EXPDATE#<site>` + `<tarih>#<gider>`). */
  ok: number;
  /** Dizin anahtari yok (backfill gerekir). */
  missing: number;
  /** Dizin anahtari var ama beklenenden farkli (tarih/site/kimlik uyusmuyor). */
  mismatched: number;
  /** Gecerli tarihi olmayan kayit (dizine giremez). */
  undated: number;
  /** Ilk birkac sorunlu kayit (site/gider). */
  samples: string[];
};

/**
 * P1-b `--verify`: tum gider kayitlarini tarar ve dizin anahtarlarini beklenen degerle karsilastirir.
 * Hicbir sey yazmaz. Tarih aralikli gider sorgusu (`GET /api/finance/expenses`) yalnizca dizindeki
 * kayitlari gorur; `missing + mismatched = 0` olmadan aralik sorgusu eksik sonuc verebilir.
 */
export async function verifyExpenseIndex(deps: { client: Client; tableName: string; log?: Pick<Console, 'info'> }): Promise<ExpenseIndexVerifyResult> {
  const log = deps.log ?? console;
  const r: ExpenseIndexVerifyResult = { scanned: 0, ok: 0, missing: 0, mismatched: 0, undated: 0, samples: [] };
  let startKey: ScanCommandOutput['LastEvaluatedKey'];
  do {
    const page = (await deps.client.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: 'entityType = :t',
        ExpressionAttributeValues: { ':t': 'EXPENSE' },
        ProjectionExpression: 'PK, SK, siteId, expenseId, #date, GSI1PK, GSI1SK',
        ExpressionAttributeNames: { '#date': 'date' },
        ExclusiveStartKey: startKey,
      }),
    )) as ScanCommandOutput;
    for (const item of page.Items ?? []) {
      r.scanned++;
      const siteId = typeof item.siteId === 'string' ? item.siteId : String(item.PK).replace(/^APT#/, '');
      const expenseId = typeof item.expenseId === 'string' ? item.expenseId : String(item.SK).replace(/^EXP#/, '');
      const date = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : undefined;
      const note = (kind: string) => {
        if (r.samples.length < 20) r.samples.push(`${kind}: ${siteId}/${expenseId}`);
      };
      if (!date) {
        r.undated++;
        note('tarihsiz');
        continue;
      }
      const idx = financeKeys.expenseIndex(siteId, date, expenseId);
      if (item.GSI1PK === undefined) {
        r.missing++;
        note('dizinsiz');
      } else if (item.GSI1PK !== idx.GSI1PK || item.GSI1SK !== idx.GSI1SK) {
        r.mismatched++;
        note('uyusmuyor');
      } else r.ok++;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  log.info(`Dogrulama: ${r.scanned} gider, ${r.ok} dogru, ${r.missing} dizinsiz, ${r.mismatched} uyusmuyor, ${r.undated} tarihsiz.`);
  for (const x of r.samples) log.info(`  ${x}`);
  return r;
}

export async function backfillExpenseIndex(
  deps: { client: Client; tableName: string; log?: Pick<Console, 'info'> },
  options: { dryRun?: boolean } = {},
): Promise<{ found: number; added: number; alreadyIndexed: number; skipped: number }> {
  const log = deps.log ?? console;
  const result = { found: 0, added: 0, alreadyIndexed: 0, skipped: 0 };
  let startKey: ScanCommandOutput['LastEvaluatedKey'];
  do {
    const page = (await deps.client.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: 'entityType = :t AND attribute_not_exists(GSI1PK)',
        ExpressionAttributeValues: { ':t': 'EXPENSE' },
        ProjectionExpression: 'PK, SK, siteId, expenseId, #date',
        ExpressionAttributeNames: { '#date': 'date' },
        ExclusiveStartKey: startKey,
      }),
    )) as ScanCommandOutput;
    for (const item of page.Items ?? []) {
      const siteId = typeof item.siteId === 'string' ? item.siteId : String(item.PK).replace(/^APT#/, '');
      const expenseId = typeof item.expenseId === 'string' ? item.expenseId : String(item.SK).replace(/^EXP#/, '');
      const date = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : undefined;
      result.found++;
      if (!date) {
        result.skipped++;
        log.info(`tarihsiz gider atlandi: ${siteId}/${expenseId}`);
        continue;
      }
      if (options.dryRun) {
        log.info(`[dry-run] dizine eklenecek: ${siteId}/${expenseId} (${date})`);
        continue;
      }
      const idx = financeKeys.expenseIndex(siteId, date, expenseId);
      try {
        await deps.client.send(
          new UpdateCommand({
            TableName: deps.tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET GSI1PK = :pk, GSI1SK = :sk',
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(GSI1PK)',
            ExpressionAttributeValues: { ':pk': idx.GSI1PK, ':sk': idx.GSI1SK },
          }),
        );
        result.added++;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          result.alreadyIndexed++;
          continue;
        }
        throw err;
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, verify: { type: 'boolean', default: false } } });
  const { client, tableName } = getDynamo();
  if (values.verify) {
    console.info(`Tablo: ${tableName} (verify)`);
    const v = await verifyExpenseIndex({ client, tableName });
    if (v.missing + v.mismatched > 0) process.exit(2);
    return;
  }
  console.info(`Tablo: ${tableName}${values['dry-run'] ? ' (dry-run)' : ''}`);
  const r = await backfillExpenseIndex({ client, tableName }, { dryRun: values['dry-run'] });
  console.info(`Bitti: ${r.found} gider bulundu, ${r.added} dizine eklendi, ${r.alreadyIndexed} zaten dizindeydi, ${r.skipped} atlandi.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
