import { PutCommand } from '@aws-sdk/lib-dynamodb';
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
    getSite: (apartmentId) => getTenantItem<Site>(coreKeys.site(apartmentId)),
    createSite: (site) => putNew(site, coreKeys.site(site.siteId)),
    updateSite: (site, expectedVersion) =>
      putVersioned(site, coreKeys.site(site.siteId), expectedVersion),

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
