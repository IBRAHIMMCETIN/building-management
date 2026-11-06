import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
  KEY_SEPARATOR,
  getDynamo,
  queryTenantAll,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import { financeKeys } from '../finance/repository.js';
import type { LedgerEntry, Payment, Transaction } from '../finance/types.js';
import type { TableKeys } from '../core/types.js';
import type { Announcement, UnitMembership } from './types.js';

/**
 * Portal yalnizca OKUR. Tum sorgular `apartmentId` (JWT claim) ile tenant'a kilitlidir;
 * daire filtresi servis katmaninda uyelik dogrulandiktan sonra uygulanir.
 */
export type PortalRepository = {
  listMemberships(apartmentId: string, userId: string): Promise<UnitMembership[]>;
  /** Bir hesabin tum defter satirlari (`LE#<accountId>#...`). */
  listLedgerEntries(apartmentId: string, accountId: string): Promise<LedgerEntry[]>;
  getTransactions(apartmentId: string, transactionIds: string[]): Promise<Transaction[]>;
  listUnitPayments(apartmentId: string, unitId: string): Promise<Payment[]>;
  listPublishedAnnouncements(apartmentId: string): Promise<Announcement[]>;
};

export const portalKeys = {
  membership: (apartmentId: string, userId: string, unitId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('MEMBER', userId, unitId),
  }),
};

const BATCH_SIZE = 100;
const MAX_BATCH_ROUNDS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function batchGetTransactions(apartmentId: string, ids: string[]): Promise<Transaction[]> {
  const { client, tableName } = getDynamo();
  const out: Transaction[] = [];
  const unique = [...new Set(ids)];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    let keys: Record<string, unknown>[] | undefined = unique
      .slice(i, i + BATCH_SIZE)
      .map((id) => financeKeys.transaction(apartmentId, id));

    for (let round = 0; keys && keys.length > 0; round++) {
      if (round >= MAX_BATCH_ROUNDS) {
        throw toDataAccessError(new Error('BatchGet islenemeyen anahtarlar kaldi'));
      }
      if (round > 0) await sleep(50 * 2 ** round);
      let res: BatchGetCommandOutput;
      try {
        res = await client.send(
          new BatchGetCommand({
            RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } },
          }),
        );
      } catch (err) {
        throw toDataAccessError(err);
      }
      out.push(...((res.Responses?.[tableName] ?? []) as Transaction[]));
      keys = res.UnprocessedKeys?.[tableName]?.Keys;
    }
  }
  // Savunma: baska tenant'a ait kayit asla donmez (anahtar zaten tenant'tan turetildi).
  return out.filter((tx) => tx.siteId === apartmentId);
}

export function createPortalRepository(): PortalRepository {
  return {
    listMemberships: (apartmentId, userId) =>
      queryTenantAll<UnitMembership>(apartmentId, skKey('MEMBER', userId) + KEY_SEPARATOR, {
        ConsistentRead: true,
      }),

    listLedgerEntries: (apartmentId, accountId) =>
      queryTenantAll<LedgerEntry>(apartmentId, skKey('LE', accountId) + KEY_SEPARATOR, {
        ConsistentRead: true,
      }),

    getTransactions: batchGetTransactions,

    // TODO(olcek): buyuk sitelerde `unitId` GSI'i ile dogrudan sorgu.
    listUnitPayments: (apartmentId, unitId) =>
      queryTenantAll<Payment>(apartmentId, 'PAY#', {
        FilterExpression: '#unitId = :unitId',
        filterNames: { '#unitId': 'unitId' },
        filterValues: { ':unitId': unitId },
      }),

    listPublishedAnnouncements: (apartmentId) =>
      queryTenantAll<Announcement>(apartmentId, 'ANN#', {
        ScanIndexForward: false,
        FilterExpression: '#status = :published',
        filterNames: { '#status': 'status' },
        filterValues: { ':published': 'published' },
      }),
  };
}

export const portalRepository: PortalRepository = createPortalRepository();
