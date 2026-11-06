import {
  getTenantItem,
  putNewItem,
  putVersionedItem,
  queryTenantAll,
  skKey,
  tenantPk,
} from '../../config/dynamodb.js';
import type { TableKeys } from '../core/types.js';
import type { UnitMembership } from '../portal/types.js';

/**
 * Daire uyelikleri: PK = `APT#<apartmentId>`, SK = `MEMBER#<userId>#<unitId>`.
 * Ayni kullanici + daire icin tek kayit vardir; tasinma/devir `endDate` ile, iptal
 * `status: 'inactive'` ile yapilir (silme yok).
 */
export const membershipKeys = {
  membership: (apartmentId: string, userId: string, unitId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('MEMBER', userId, unitId),
  }),
};

const MEMBER_PREFIX = 'MEMBER#';

export type MembershipRepository = {
  get(apartmentId: string, userId: string, unitId: string): Promise<UnitMembership | undefined>;
  /** Apartmandaki tum uyelikler; `unitId` verilirse yalnizca o daire. */
  list(apartmentId: string, filter?: { unitId?: string }): Promise<UnitMembership[]>;
  create(membership: UnitMembership): Promise<void>;
  update(membership: UnitMembership, expectedVersion: number): Promise<void>;
};

function assertKeys(m: UnitMembership): void {
  const expected = membershipKeys.membership(m.apartmentId, m.userId, m.unitId);
  if (m.PK !== expected.PK || m.SK !== expected.SK) {
    throw new Error(`Uyelik anahtari tutarsiz: ${m.PK}/${m.SK}`);
  }
}

export function createMembershipRepository(): MembershipRepository {
  return {
    get: (apartmentId, userId, unitId) =>
      getTenantItem<UnitMembership>(membershipKeys.membership(apartmentId, userId, unitId)),

    list: (apartmentId, filter = {}) =>
      queryTenantAll<UnitMembership>(apartmentId, MEMBER_PREFIX, {
        ConsistentRead: true,
        ...(filter.unitId
          ? {
              FilterExpression: '#unitId = :unitId',
              filterNames: { '#unitId': 'unitId' },
              filterValues: { ':unitId': filter.unitId },
            }
          : {}),
      }),

    async create(membership) {
      assertKeys(membership);
      await putNewItem(membership);
    },

    async update(membership, expectedVersion) {
      assertKeys(membership);
      await putVersionedItem(membership, expectedVersion);
    },
  };
}

export const membershipRepository: MembershipRepository = createMembershipRepository();
