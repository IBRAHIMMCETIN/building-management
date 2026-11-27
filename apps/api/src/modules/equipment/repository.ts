import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, queryTenantAll, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import { EQUIPMENT_PREFIX, type Equipment, equipmentKeys } from './types.js';

/**
 * Ariza & bakim v2 - Ekipman deposu. Her yazim surum kosullu (`0`: yeni kayit) ve denetim
 * kaydiyla ayni `TransactWriteItems` icindedir. Silme yok.
 */
export class EquipmentConflictError extends Error {
  constructor(message = 'Ekipman kaydı başka bir işlemle değişti; sayfayı yenileyin') {
    super(message);
    this.name = 'EquipmentConflictError';
  }
}

export type EquipmentWrite = { item: Equipment; expectedVersion: number; audit?: AuditDraft };

export type EquipmentRepository = {
  get(apartmentId: string, equipmentId: string): Promise<Equipment | undefined>;
  list(apartmentId: string): Promise<Equipment[]>;
  write(apartmentId: string, w: EquipmentWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export function createEquipmentRepository(): EquipmentRepository {
  return {
    async get(apartmentId, equipmentId) {
      const item = await getTenantItem<Equipment>(equipmentKeys.equipment(apartmentId, equipmentId));
      return item?.entityType === 'EQUIPMENT' && item.apartmentId === apartmentId ? item : undefined;
    },
    async list(apartmentId) {
      const items = await queryTenantAll<Equipment>(apartmentId, EQUIPMENT_PREFIX, { ConsistentRead: true });
      return items.filter((e) => e.entityType === 'EQUIPMENT' && e.apartmentId === apartmentId);
    },
    async write(apartmentId, w) {
      if (w.item.apartmentId !== apartmentId) throw new Error('Kiraci uyusmazligi');
      const { client, tableName } = getDynamo();
      const put: TransactItem = {
        Put: {
          TableName: tableName,
          Item: w.item,
          ...(w.expectedVersion === 0
            ? { ConditionExpression: 'attribute_not_exists(PK)' }
            : {
                ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expected': w.expectedVersion },
              }),
        },
      };
      try {
        await sendWithAudit(client, [put], w.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new EquipmentConflictError();
        }
        throw toDataAccessError(err);
      }
    },
  };
}

export const equipmentRepository: EquipmentRepository = createEquipmentRepository();
