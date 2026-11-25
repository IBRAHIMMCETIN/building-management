/**
 * Faz 1 - Alacak hesabi adi duzeltme (bir defalik, tekrar calistirilabilir).
 *
 * Faz 1 oncesi acilan daire alt carilerinin adinda ham daire kimligi (UUID) vardi:
 *   "Daire 17e1ba48-... - Kat Maliki"          -> "Daire 5 - Kat Maliki"
 *   "Daire 17e1ba48-... - Kiraci/Sakin"        -> "Daire 5 - Kiracı/Sakin"
 *   "Daire 17e1ba48-... - Kat Maliki (paydaş)" -> "Daire 5 - Kat Maliki (paydaş)"
 *
 * YALNIZCA hesap kaydinin `name` alani degisir (+ `version`, `updatedAt`, `updatedBy`); defter
 * kayitlarina (TX#, LE#) ve gecmis islem aciklamalarina dokunulmaz (append-only). Yazim
 * kosulludur: ad hala eski degerse yazilir; ikinci calistirmada eslesen kayit kalmaz.
 * Daire bulunamazsa hesap atlanir ve raporlanir.
 *
 * Tablo taramasi (Scan) gerektirir: API/worker rollerinde Scan yetkisi YOKTUR, betik yonetici
 * kimligiyle (aws login) calistirilir.
 *
 *   $env:DYNAMODB_TABLE_NAME = terraform -chdir=../../infra output -raw dynamodb_table_name
 *   npm run fix:receivable-names -- --dry-run
 *   npm run fix:receivable-names
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, type GetCommandOutput, ScanCommand, type ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo } from '../src/config/dynamodb.js';
import { coreKeys } from '../src/modules/core/repository.js';

type Client = { send(command: ScanCommand | GetCommand | UpdateCommand): Promise<unknown> };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Eski ad bicimi: `Daire <unitId> - <taraf>`. */
const LEGACY_NAME = new RegExp(`^Daire (${UUID}) - (Kat Maliki \\(paydaş\\)|Kat Maliki|Kiraci/Sakin|Kiracı/Sakin)$`);

export const FIX_ACTOR = 'script:fix-receivable-names';

/** Eski addan yeni adi uretir; bicim taninmazsa `undefined`. */
export function fixedReceivableName(name: string, unitNumber: string): string | undefined {
  const m = LEGACY_NAME.exec(name);
  if (!m) return undefined;
  const party = m[2] === 'Kiraci/Sakin' ? 'Kiracı/Sakin' : m[2];
  return `Daire ${unitNumber} - ${party}`;
}

export function legacyUnitIdOf(name: string): string | undefined {
  return LEGACY_NAME.exec(name)?.[1];
}

export type FixResult = { scanned: number; fixed: number; skippedNoUnit: number; alreadyFixed: number };

export async function fixReceivableNames(
  deps: { client: Client; tableName: string; now?: () => Date; log?: Pick<Console, 'info' | 'warn'> },
  options: { dryRun?: boolean } = {},
): Promise<FixResult> {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());
  const result: FixResult = { scanned: 0, fixed: 0, skippedNoUnit: 0, alreadyFixed: 0 };
  const unitNumbers = new Map<string, string | null>();

  async function unitNumber(apartmentId: string, unitId: string): Promise<string | undefined> {
    const key = `${apartmentId}|${unitId}`;
    if (!unitNumbers.has(key)) {
      const out = (await deps.client.send(new GetCommand({ TableName: deps.tableName, Key: coreKeys.unit(apartmentId, unitId) }))) as GetCommandOutput;
      const n = out.Item?.number;
      unitNumbers.set(key, typeof n === 'string' && n ? n : null);
    }
    return unitNumbers.get(key) ?? undefined;
  }

  let startKey: ScanCommandOutput['LastEvaluatedKey'];
  do {
    const page = (await deps.client.send(
      new ScanCommand({
        TableName: deps.tableName,
        // Kaba on-filtre; kesin eslesme asagida duzenli ifadeyle.
        FilterExpression: 'begins_with(SK, :acct) AND #type = :recv AND begins_with(#name, :daire)',
        ExpressionAttributeNames: { '#type': 'type', '#name': 'name' },
        ExpressionAttributeValues: { ':acct': 'ACCT#', ':recv': 'receivable', ':daire': 'Daire ' },
        ProjectionExpression: 'PK, SK, siteId, accountId, unitId, #name',
        ExclusiveStartKey: startKey,
      }),
    )) as ScanCommandOutput;

    for (const item of page.Items ?? []) {
      const name = String(item.name ?? '');
      const legacyUnit = legacyUnitIdOf(name);
      if (!legacyUnit) continue;
      result.scanned++;
      const apartmentId = typeof item.siteId === 'string' ? item.siteId : String(item.PK).replace(/^APT#/, '');
      const unitId = typeof item.unitId === 'string' ? item.unitId : legacyUnit;
      const number = await unitNumber(apartmentId, unitId);
      if (!number) {
        result.skippedNoUnit++;
        log.warn(`daire bulunamadi, atlandi: ${apartmentId} / ${String(item.accountId)} (${name})`);
        continue;
      }
      const next = fixedReceivableName(name, number) as string;
      if (options.dryRun) {
        log.info(`[dry-run] ${apartmentId} / ${String(item.accountId)}: "${name}" -> "${next}"`);
        result.fixed++;
        continue;
      }
      try {
        await deps.client.send(
          new UpdateCommand({
            TableName: deps.tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET #name = :next, #updatedAt = :now, #updatedBy = :by ADD #version :one',
            ConditionExpression: 'attribute_exists(PK) AND #name = :old',
            ExpressionAttributeNames: { '#name': 'name', '#updatedAt': 'updatedAt', '#updatedBy': 'updatedBy', '#version': 'version' },
            ExpressionAttributeValues: { ':next': next, ':old': name, ':now': now().toISOString(), ':by': FIX_ACTOR, ':one': 1 },
          }),
        );
        result.fixed++;
        log.info(`duzeltildi: ${apartmentId} / ${String(item.accountId)} -> "${next}"`);
      } catch (err) {
        // Arada baska bir islem adi degistirdi: yeni ad korunur.
        if (err instanceof ConditionalCheckFailedException) {
          result.alreadyFixed++;
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
  const r = await fixReceivableNames({ client, tableName }, { dryRun: values['dry-run'] });
  console.info(
    `Bitti: ${r.scanned} eski adli hesap, ${r.fixed} ${values['dry-run'] ? 'duzeltilecek' : 'duzeltildi'}, ${r.skippedNoUnit} daire bulunamadi, ${r.alreadyFixed} arada degismis.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
