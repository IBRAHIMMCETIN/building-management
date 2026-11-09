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
import type { ApartmentRole } from './types.js';

export const apartmentRoleKeys = {
  role: (apartmentId: string, userId: string, role: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('ROLE', userId, role),
  }),
};

/** GSI1: kullanici -> apartman yetkileri (Pre Token Generation Lambda). */
export function apartmentRoleGsi1(r: Pick<ApartmentRole, 'userId' | 'apartmentId' | 'role'>) {
  return {
    GSI1PK: `USER${KEY_SEPARATOR}${r.userId}`,
    GSI1SK: ['APT', r.apartmentId, 'ROLE', r.role].join(KEY_SEPARATOR),
  };
}

function stripIndex<T extends object | undefined>(item: T): T {
  if (!item) return item;
  const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = item as T & { GSI1PK?: string; GSI1SK?: string };
  return rest as T;
}

function assertKeys(r: ApartmentRole): void {
  const expected = apartmentRoleKeys.role(r.apartmentId, r.userId, r.role);
  if (r.PK !== expected.PK || r.SK !== expected.SK) {
    throw new Error(`Rol kaydi anahtari tutarsiz: ${r.PK}/${r.SK}`);
  }
}

export type ApartmentRoleRepository = {
  get(apartmentId: string, userId: string, role: string): Promise<ApartmentRole | undefined>;
  list(apartmentId: string): Promise<ApartmentRole[]>;
  create(record: ApartmentRole): Promise<void>;
  update(record: ApartmentRole, expectedVersion: number): Promise<void>;
};

export function createApartmentRoleRepository(): ApartmentRoleRepository {
  return {
    get: async (apartmentId, userId, role) =>
      stripIndex(await getTenantItem<ApartmentRole>(apartmentRoleKeys.role(apartmentId, userId, role))),
    list: async (apartmentId) =>
      (await queryTenantAll<ApartmentRole>(apartmentId, 'ROLE#', { ConsistentRead: true })).map((r) => stripIndex(r)),
    async create(record) {
      assertKeys(record);
      await putNewItem({ ...stripIndex(record), ...apartmentRoleGsi1(record) });
    },
    async update(record, expectedVersion) {
      assertKeys(record);
      await putVersionedItem({ ...stripIndex(record), ...apartmentRoleGsi1(record) }, expectedVersion);
    },
  };
}

export const apartmentRoleRepository: ApartmentRoleRepository = createApartmentRoleRepository();
