import { auditedPutNew, auditedPutVersioned } from '../audit/log.js';
import { PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
  getDynamo,
  getTenantItem,
  queryTenantAll,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import type { Block, Site, TableKeys, Unit } from './types.js';

/** Core modulu kayitlarinin DynamoDB anahtarlari (PK = APT#<siteId>). */
export const coreKeys = {
  site: (siteId: string): TableKeys => ({ PK: tenantPk(siteId), SK: 'SITE' }),
  block: (siteId: string, blockId: string): TableKeys => ({
    PK: tenantPk(siteId),
    SK: skKey('BLOCK', blockId),
  }),
  unit: (siteId: string, unitId: string): TableKeys => ({
    PK: tenantPk(siteId),
    SK: skKey('UNIT', unitId),
  }),
};

/**
 * Site dizini (GSI1, seyrek): zamanlanmis gorevler tum apartmanlari bu indeksle listeler.
 *   GSI1PK = `SITE_DIRECTORY`, GSI1SK = `SITE#<siteId>`
 * GSI1'in diger kullanimi `USER#<userId>` anahtarlidir; cakisma yoktur. Tek bolum ilk yillar
 * icin yeterlidir (binlerce site); buyurse GSI1PK `SITE_DIRECTORY#<0-9>` ile bolunur.
 */
export const SITE_DIRECTORY_PK = 'SITE_DIRECTORY';
export const siteDirectoryKeys = (siteId: string) => ({ GSI1PK: SITE_DIRECTORY_PK, GSI1SK: `SITE#${siteId}` });

function withDirectory(site: Site): Site & ReturnType<typeof siteDirectoryKeys> {
  return { ...site, ...siteDirectoryKeys(site.siteId) };
}

function withoutDirectory(item: (Site & { GSI1PK?: string; GSI1SK?: string }) | undefined): Site | undefined {
  if (!item) return undefined;
  const { GSI1PK: _pk, GSI1SK: _sk, ...site } = item;
  return site;
}

async function listSiteIds(): Promise<string[]> {
  const { client, tableName } = getDynamo();
  const ids: string[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'];
  try {
    do {
      const out: QueryCommandOutput = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': SITE_DIRECTORY_PK },
          ProjectionExpression: 'siteId',
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of out.Items ?? []) if (typeof item.siteId === 'string') ids.push(item.siteId);
      startKey = out.LastEvaluatedKey;
    } while (startKey);
  } catch (err) {
    throw toDataAccessError(err);
  }
  return ids.sort();
}

const BLOCK_PREFIX = 'BLOCK#';
const UNIT_PREFIX = 'UNIT#';

/**
 * Tum okuma/yazmalar `apartmentId` ile yapilir; servis katmani bu degeri JWT
 * claim'inden alir. Silme yoktur: kayitlar `status` ile pasife alinir.
 * Guncellemeler `version` ile optimistic locking kullanir.
 */
export type CoreRepository = {
  getSite(apartmentId: string): Promise<Site | undefined>;
  createSite(site: Site): Promise<void>;
  updateSite(site: Site, expectedVersion: number): Promise<void>;
  /** Tum apartman kimlikleri (site dizini). Yalnizca zamanlanmis gorevler kullanir. */
  listSiteIds(): Promise<string[]>;

  getBlock(apartmentId: string, blockId: string): Promise<Block | undefined>;
  listBlocks(apartmentId: string): Promise<Block[]>;
  createBlock(block: Block): Promise<void>;
  updateBlock(block: Block, expectedVersion: number): Promise<void>;

  getUnit(apartmentId: string, unitId: string): Promise<Unit | undefined>;
  listUnits(apartmentId: string): Promise<Unit[]>;
  createUnit(unit: Unit): Promise<void>;
  updateUnit(unit: Unit, expectedVersion: number): Promise<void>;
};

function assertKeys(item: TableKeys, expected: TableKeys): void {
  if (item.PK !== expected.PK || item.SK !== expected.SK) {
    throw new Error(`Anahtar tutarsizligi: ${item.PK}/${item.SK} beklenen ${expected.PK}/${expected.SK}`);
  }
}

/** Site ve ayar degisikligi (ayarlar kisisel veri icermez; boyut siniri denetimde). */
function siteAudit(site: Site, action: string) {
  return {
    apartmentId: site.siteId,
    action,
    target: { type: 'site', id: site.siteId },
    actorId: site.updatedBy,
    details: { name: site.name, status: site.status, version: site.version, settings: site.settings },
  };
}

async function putNew(item: TableKeys, expected: TableKeys): Promise<void> {
  assertKeys(item, expected);
  const { client, tableName } = getDynamo();
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    throw toDataAccessError(err);
  }
}

async function putVersioned(
  item: TableKeys,
  expected: TableKeys,
  expectedVersion: number,
): Promise<void> {
  assertKeys(item, expected);
  const { client, tableName } = getDynamo();
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
      }),
    );
  } catch (err) {
    throw toDataAccessError(err);
  }
}

export function createCoreRepository(): CoreRepository {
  return {
    getSite: async (apartmentId) => withoutDirectory(await getTenantItem<Site>(coreKeys.site(apartmentId))),
    createSite: async (site) => {
      assertKeys(site, coreKeys.site(site.siteId));
      return auditedPutNew(withDirectory(site), siteAudit(site, 'site.create'));
    },
    updateSite: async (site, expectedVersion) => {
      assertKeys(site, coreKeys.site(site.siteId));
      return auditedPutVersioned(withDirectory(site), expectedVersion, siteAudit(site, 'site.update'));
    },
    listSiteIds,

    getBlock: (apartmentId, blockId) => getTenantItem<Block>(coreKeys.block(apartmentId, blockId)),
    listBlocks: (apartmentId) => queryTenantAll<Block>(apartmentId, BLOCK_PREFIX, { ConsistentRead: true }),
    createBlock: (block) => putNew(block, coreKeys.block(block.siteId, block.blockId)),
    updateBlock: (block, expectedVersion) =>
      putVersioned(block, coreKeys.block(block.siteId, block.blockId), expectedVersion),

    getUnit: (apartmentId, unitId) => getTenantItem<Unit>(coreKeys.unit(apartmentId, unitId)),
    listUnits: (apartmentId) => queryTenantAll<Unit>(apartmentId, UNIT_PREFIX, { ConsistentRead: true }),
    createUnit: (unit) => putNew(unit, coreKeys.unit(unit.siteId, unit.unitId)),
    updateUnit: (unit, expectedVersion) =>
      putVersioned(unit, coreKeys.unit(unit.siteId, unit.unitId), expectedVersion),
  };
}

export const coreRepository: CoreRepository = createCoreRepository();
