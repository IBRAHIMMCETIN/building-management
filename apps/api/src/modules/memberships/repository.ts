import {
  KEY_SEPARATOR,
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

/**
 * GSI1: kullanici -> tum apartman yetkileri (Pre Token Generation Lambda tek sorguda okur).
 *   GSI1PK = `USER#<userId>`, GSI1SK = `APT#<apartmentId>#UNIT#<unitId>`
 */
export function membershipGsi1(m: Pick<UnitMembership, 'userId' | 'apartmentId' | 'unitId'>) {
  return {
    GSI1PK: `USER${KEY_SEPARATOR}${m.userId}`,
    GSI1SK: ['APT', m.apartmentId, 'UNIT', m.unitId].join(KEY_SEPARATOR),
  };
}

/** Okunan kayittan indeks alanlarini ayiklar (domain nesnesine sizmasin). */
function stripIndex<T extends object | undefined>(item: T): T {
  if (!item) return item;
  const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = item as T & { GSI1PK?: string; GSI1SK?: string };
  return rest as T;
}

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
    get: async (apartmentId, userId, unitId) =>
      stripIndex(await getTenantItem<UnitMembership>(membershipKeys.membership(apartmentId, userId, unitId))),

    list: async (apartmentId, filter = {}) =>
      (await queryTenantAll<UnitMembership>(apartmentId, MEMBER_PREFIX, {
        ConsistentRead: true,
        ...(filter.unitId
          ? {
              FilterExpression: '#unitId = :unitId',
              filterNames: { '#unitId': 'unitId' },
              filterValues: { ':unitId': filter.unitId },
            }
          : {}),
      })).map((m) => stripIndex(m)),

    async create(membership) {
      assertKeys(membership);
      await putNewItem({ ...stripIndex(membership), ...membershipGsi1(membership) });
    },

    async update(membership, expectedVersion) {
      assertKeys(membership);
      await putVersionedItem({ ...stripIndex(membership), ...membershipGsi1(membership) }, expectedVersion);
    },
  };
}

export const membershipRepository: MembershipRepository = createMembershipRepository();
