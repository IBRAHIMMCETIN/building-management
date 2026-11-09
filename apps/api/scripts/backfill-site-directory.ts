/**
 * Site dizini doldurma (bir defalik): site dizini (GSI1 `SITE_DIRECTORY`) eklenmeden once
 * olusturulan apartmanlari zamanlanmis gorevlerin gorebilmesi icin dizine ekler.
 * Yeni ve guncellenen siteler dizine otomatik girer; bu betik yalnizca eskiler icindir.
 *
 * Tekrar calistirilabilir: zaten dizinde olan site atlanir (kosullu yazim). Yalnizca
 * GSI1PK/GSI1SK eklenir; site kaydinin diger alanlarina ve surumune dokunulmaz.
 * Tablo taramasi (Scan) gerektirir: API/worker rollerinde Scan yetkisi YOKTUR, betik yonetici
 * kimligiyle (aws login) calistirilir.
 *
 *   $env:DYNAMODB_TABLE_NAME = terraform -chdir=../../infra output -raw dynamodb_table_name
 *   npm run backfill:sites -- --dry-run
 *   npm run backfill:sites
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, type ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo } from '../src/config/dynamodb.js';
import { SITE_DIRECTORY_PK, siteDirectoryKeys } from '../src/modules/core/repository.js';

type Client = { send(command: ScanCommand | UpdateCommand): Promise<unknown> };

export async function backfillSiteDirectory(
  deps: { client: Client; tableName: string; log?: Pick<Console, 'info'> },
  options: { dryRun?: boolean } = {},
): Promise<{ found: number; added: number; alreadyListed: number }> {
  const log = deps.log ?? console;
  const result = { found: 0, added: 0, alreadyListed: 0 };
  let startKey: ScanCommandOutput['LastEvaluatedKey'];
  do {
    const page = (await deps.client.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: 'SK = :site AND (attribute_not_exists(GSI1PK) OR GSI1PK <> :dir)',
        ExpressionAttributeValues: { ':site': 'SITE', ':dir': SITE_DIRECTORY_PK },
        ProjectionExpression: 'PK, SK, siteId',
        ExclusiveStartKey: startKey,
      }),
    )) as ScanCommandOutput;
    for (const item of page.Items ?? []) {
      const siteId = typeof item.siteId === 'string' ? item.siteId : String(item.PK).replace(/^APT#/, '');
      result.found++;
      if (options.dryRun) {
        log.info(`[dry-run] dizine eklenecek: ${siteId}`);
        continue;
      }
      const dir = siteDirectoryKeys(siteId);
      try {
        await deps.client.send(
          new UpdateCommand({
            TableName: deps.tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET GSI1PK = :pk, GSI1SK = :sk',
            ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(GSI1PK) OR GSI1PK <> :pk)',
            ExpressionAttributeValues: { ':pk': dir.GSI1PK, ':sk': dir.GSI1SK },
          }),
        );
        result.added++;
        log.info(`dizine eklendi: ${siteId}`);
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          result.alreadyListed++;
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
  const r = await backfillSiteDirectory({ client, tableName }, { dryRun: values['dry-run'] });
  console.info(`Bitti: ${r.found} site bulundu, ${r.added} eklendi, ${r.alreadyListed} zaten dizindeydi.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
