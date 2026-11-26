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
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, type ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo } from '../src/config/dynamodb.js';
import { financeKeys } from '../src/modules/finance/repository.js';

type Client = { send(command: ScanCommand | UpdateCommand): Promise<unknown> };

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
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  const { client, tableName } = getDynamo();
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
