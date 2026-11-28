import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { type AuditDraft, auditedPut, auditedPutVersioned } from '../audit/log.js';
import { getDynamo, getTenantItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { coreKeys, coreRepository, siteDirectoryKeys } from '../core/repository.js';
import type { Site } from '../core/types.js';
import type { FeatureKey } from './catalog.js';

/**
 * Yoneticinin "acilmasini istiyorum" talebi.
 *   PK = `APT#<siteId>`, SK = `FEATREQ#<anahtar>`   (ozellik basina tek acik talep)
 *   GSI1 (seyrek, yalnizca bekleyen talepler): GSI1PK = `FEATURE_REQUEST`, GSI1SK = `<createdAt>#<siteId>`
 * Kapatilan talep GSI anahtarlari olmadan yeniden yazilir (silme yok); platform listesi bu
 * sayede yalnizca bekleyenleri tarar.
 */
export const FEATURE_REQUEST_INDEX_PK = 'FEATURE_REQUEST';

export type FeatureRequestStatus = 'pending' | 'enabled' | 'dismissed';

export type FeatureRequest = {
  PK: string;
  SK: string;
  entityType: 'FEATURE_REQUEST';
  apartmentId: string;
  feature: FeatureKey;
  status: FeatureRequestStatus;
  note?: string;
  requestedBy: string;
  requestedAt: string;
  /** Kac kez istendi (bekleyen talep tekrar gonderildiginde artmaz; kapanip yeniden acilinca artar). */
  count: number;
  closedAt?: string;
  closedBy?: string;
  closeReason?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  GSI1PK?: string;
  GSI1SK?: string;
};

export const featureRequestKeys = (apartmentId: string, feature: FeatureKey) => ({
  PK: tenantPk(apartmentId),
  SK: skKey('FEATREQ', feature),
});

export type FeatureRepository = {
  getSite(apartmentId: string): Promise<Site | undefined>;
  /** Site kaydini (yalnizca `settings.features` degismis) surum kosulu + denetim kaydiyla yazar. */
  saveSiteFeatures(site: Site, expectedVersion: number, audit: AuditDraft): Promise<void>;
  getRequest(apartmentId: string, feature: FeatureKey): Promise<FeatureRequest | undefined>;
  /** Yeni / yeniden acilan talep: kosulsuz yazim + denetim kaydi (ayni atomik islem). */
  putRequest(request: FeatureRequest, audit: AuditDraft): Promise<void>;
  /** Talep kapatma (surum kosullu) + denetim kaydi. */
  closeRequest(request: FeatureRequest, expectedVersion: number, audit: AuditDraft): Promise<void>;
  listPendingRequests(): Promise<FeatureRequest[]>;
  /** Bir sitenin tum talepleri (SK onekiyle tek sorgu). */
  listSiteRequests(apartmentId: string): Promise<FeatureRequest[]>;
};

async function listPendingRequests(): Promise<FeatureRequest[]> {
  const { client, tableName } = getDynamo();
  const items: FeatureRequest[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'];
  try {
    do {
      const out: QueryCommandOutput = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': FEATURE_REQUEST_INDEX_PK },
          ScanIndexForward: false,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of out.Items ?? []) if (item.entityType === 'FEATURE_REQUEST') items.push(item as FeatureRequest);
      startKey = out.LastEvaluatedKey;
    } while (startKey && items.length < 1000);
  } catch (err) {
    throw toDataAccessError(err);
  }
  return items.filter((r) => r.status === 'pending');
}

export function createFeatureRepository(): FeatureRepository {
  return {
    getSite: (apartmentId) => coreRepository.getSite(apartmentId),
    saveSiteFeatures: async (site, expectedVersion, audit) => {
      const keys = coreKeys.site(site.siteId);
      if (site.PK !== keys.PK || site.SK !== keys.SK) throw new Error('Anahtar tutarsizligi (site)');
      // Site dizini (GSI1 SITE_DIRECTORY) anahtarlari korunur: zamanlanmis isler siteyi bulmaya devam eder.
      await auditedPutVersioned({ ...site, ...siteDirectoryKeys(site.siteId) }, expectedVersion, audit);
    },
    getRequest: (apartmentId, feature) => getTenantItem<FeatureRequest>(featureRequestKeys(apartmentId, feature)),
    putRequest: (request, audit) => auditedPut(request, audit),
    closeRequest: (request, expectedVersion, audit) => auditedPutVersioned(request, expectedVersion, audit),
    listPendingRequests,
    listSiteRequests: (apartmentId) => queryTenantAll<FeatureRequest>(apartmentId, 'FEATREQ#', { ConsistentRead: true }),
  };
}

export const featureRepository: FeatureRepository = createFeatureRepository();
