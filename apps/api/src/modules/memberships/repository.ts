import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { auditedPutNew, auditedPutVersioned, sendWithAudit } from '../audit/log.js';
import {
  DataAccessError,
  KEY_SEPARATOR,
  getDynamo,
  getTenantItem,
  queryTenantAll,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
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
  /**
   * `outbox`: ayni atomik yazimda saklanacak domain olaylari (kapi devami: `MEMBERSHIP_ENDED`).
   * Surum uyusmazsa `DataAccessError('conflict')`.
   */
  update(membership: UnitMembership, expectedVersion: number, opts?: { outbox?: DomainEvent[] }): Promise<void>;
};

function assertKeys(m: UnitMembership): void {
  const expected = membershipKeys.membership(m.apartmentId, m.userId, m.unitId);
  if (m.PK !== expected.PK || m.SK !== expected.SK) {
    throw new Error(`Uyelik anahtari tutarsiz: ${m.PK}/${m.SK}`);
  }
}

/** Denetim kaydi: kimlik, iliski ve gecerlilik (kisisel veri yok). */
function membershipAudit(m: UnitMembership, action: string) {
  return {
    apartmentId: m.apartmentId,
    action,
    target: { type: 'membership', id: `${m.userId}:${m.unitId}` },
    actorId: m.updatedBy,
    details: {
      userId: m.userId,
      unitId: m.unitId,
      relation: m.relation,
      residesInUnit: m.residesInUnit,
      status: m.status,
      startDate: m.startDate,
      endDate: m.endDate,
      version: m.version,
    },
  };
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
      await auditedPutNew({ ...stripIndex(membership), ...membershipGsi1(membership) }, membershipAudit(membership, 'membership.create'));
    },

    async update(membership, expectedVersion, opts = {}) {
      assertKeys(membership);
      const item = { ...stripIndex(membership), ...membershipGsi1(membership) };
      const draft = membershipAudit(membership, 'membership.update');
      if (!opts.outbox?.length) {
        await auditedPutVersioned(item, expectedVersion, draft);
        return;
      }
      // Uyelik + outbox olay(lar)i + denetim kaydi tek TransactWriteItems (denetim kapaliysa ikisi).
      const { client, tableName } = getDynamo();
      try {
        await sendWithAudit(
          client,
          [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
              },
            },
            ...toOutboxItems(opts.outbox, membership.updatedAt, membership.apartmentId).map((o) => ({
              Put: { TableName: tableName, Item: o, ConditionExpression: 'attribute_not_exists(PK)' },
            })),
          ],
          draft,
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi)', { cause: err });
        }
        throw toDataAccessError(err);
      }
    },
  };
}

export const membershipRepository: MembershipRepository = createMembershipRepository();
