import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, putNewItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import type { TableKeys } from '../core/types.js';
import type { Assembly, AssemblyAttendance } from './types.js';

export const assemblyKeys = {
  assembly: (apartmentId: string, assemblyId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASSEMBLY', assemblyId) }),
  attendance: (apartmentId: string, assemblyId: string, unitId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMATT', assemblyId, unitId) }),
};

export type AssemblyRepository = {
  get(apartmentId: string, assemblyId: string): Promise<Assembly | undefined>;
  list(apartmentId: string): Promise<Assembly[]>;
  create(a: Assembly): Promise<void>;
  /** Surum kosullu; `audit` ayni atomik yazimda. Cakismada `DataAccessError('conflict')`. */
  update(a: Assembly, expectedVersion: number, audit?: AuditDraft): Promise<void>;
  listAttendance(apartmentId: string, assemblyId: string): Promise<AssemblyAttendance[]>;
  getAttendance(apartmentId: string, assemblyId: string, unitId: string): Promise<AssemblyAttendance | undefined>;
  /**
   * Bolumun katilimi: `expectedVersion = 0` ilk kayit. Ayni islemde toplantinin `planned` oldugu
   * dogrulanir. Kosul saglanmazsa `DataAccessError('conflict')`.
   */
  putAttendance(att: AssemblyAttendance, expectedVersion: number, audit: AuditDraft): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const conditionFailed = (err: unknown) =>
  err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');

function assertKeys(item: TableKeys, expected: TableKeys): void {
  if (item.PK !== expected.PK || item.SK !== expected.SK) throw new Error(`Genel kurul anahtari tutarsiz: ${item.PK}/${item.SK}`);
}

export function createAssemblyRepository(): AssemblyRepository {
  return {
    get: (apartmentId, id) => getTenantItem<Assembly>(assemblyKeys.assembly(apartmentId, id)),
    async list(apartmentId) {
      const items = await queryTenantAll<Assembly>(apartmentId, 'ASSEMBLY#', { ConsistentRead: true });
      return items.filter((a) => a.entityType === 'ASSEMBLY' && a.apartmentId === apartmentId);
    },
    async create(a) {
      assertKeys(a, assemblyKeys.assembly(a.apartmentId, a.assemblyId));
      await putNewItem(a);
    },
    async update(a, expectedVersion, audit) {
      assertKeys(a, assemblyKeys.assembly(a.apartmentId, a.assemblyId));
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          Put: {
            TableName: tableName,
            Item: a,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': expectedVersion },
          },
        },
      ];
      try {
        await sendWithAudit(client, items, audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi)', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async listAttendance(apartmentId, assemblyId) {
      const items = await queryTenantAll<AssemblyAttendance>(apartmentId, `ASMATT#${assemblyId}#`, { ConsistentRead: true });
      return items.filter((x) => x.entityType === 'ASSEMBLY_ATTENDANCE' && x.apartmentId === apartmentId && x.assemblyId === assemblyId);
    },
    getAttendance: (apartmentId, assemblyId, unitId) => getTenantItem<AssemblyAttendance>(assemblyKeys.attendance(apartmentId, assemblyId, unitId)),
    async putAttendance(att, expectedVersion, audit) {
      assertKeys(att, assemblyKeys.attendance(att.apartmentId, att.assemblyId, att.unitId));
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: assemblyKeys.assembly(att.apartmentId, att.assemblyId),
            ConditionExpression: '#status = :planned',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':planned': 'planned' },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: att,
            ...(expectedVersion === 0
              ? { ConditionExpression: 'attribute_not_exists(PK)' }
              : {
                  ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: { ':expected': expectedVersion },
                }),
          },
        },
      ];
      try {
        await sendWithAudit(client, items, audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kosul saglanmadi (toplanti iptal veya kayit degisti)', { cause: err });
        throw toDataAccessError(err);
      }
    },
  };
}

export const assemblyRepository: AssemblyRepository = createAssemblyRepository();
