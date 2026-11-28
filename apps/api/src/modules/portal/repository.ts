import { KEY_SEPARATOR, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { batchGetTransactions } from '../finance/repository.js';
import { type UnitPaymentReader, createDynamoUnitPaymentStore, createUnitPaymentReader } from '../finance/unitPayments.js';
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
  /**
   * Dairenin makbuzlari. Adim 2-1: site hazirsa daire dizininden (GSI1 `UPAY#`, nihai tutarli),
   * degilse eski tam taramadan. `consistent: true` her zaman eski tutarli yolu kullanir.
   */
  listUnitPayments(apartmentId: string, unitId: string, opts?: { consistent?: boolean }): Promise<Payment[]>;
  listPublishedAnnouncements(apartmentId: string): Promise<Announcement[]>;
};

export const portalKeys = {
  membership: (apartmentId: string, userId: string, unitId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('MEMBER', userId, unitId),
  }),
};

export function createPortalRepository(deps: { unitPayments?: UnitPaymentReader } = {}): PortalRepository {
  const unitPayments = deps.unitPayments ?? createUnitPaymentReader(createDynamoUnitPaymentStore());
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

    listUnitPayments: (apartmentId, unitId, opts) => unitPayments.list(apartmentId, unitId, opts),

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
