import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, type QueryCommandOutput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, putNewItem, queryTenantAll, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import type { DomainEvent } from '../../events/publisher.js';
import { toOutboxItems } from '../../events/outbox.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import type { IsoDate } from '../core/types.js';
import { type MaintenanceTask, type MaintenanceTemplate, TASK_PREFIX, TEMPLATE_PREFIX, maintenanceKeys } from './types.js';

/**
 * Faz 3 (O1-3) - Bakim deposu. Sablon ve gorev yazimlari surum kosullu; birden fazla kayit tek
 * `TransactWriteItems` ile. Gorev uretimi tek tek `attribute_not_exists` ile (var olan gorev diger
 * gorevlerin uretimini engellemesin). Silme yok.
 */
export class MaintenanceConflictError extends Error {
  constructor(message = 'Kayıt başka bir işlemle değişti; sayfayı yenileyin') {
    super(message);
    this.name = 'MaintenanceConflictError';
  }
}

export type MaintenanceWrite = {
  at: string;
  template?: { item: MaintenanceTemplate; expectedVersion: number };
  tasks?: { item: MaintenanceTask; expectedVersion: number }[];
  outbox?: DomainEvent[];
  audit?: AuditDraft;
};

export type MaintenanceRepository = {
  getTemplate(apartmentId: string, templateId: string): Promise<MaintenanceTemplate | undefined>;
  listTemplates(apartmentId: string): Promise<MaintenanceTemplate[]>;
  getTask(apartmentId: string, dueDate: IsoDate, templateId: string): Promise<MaintenanceTask | undefined>;
  /** Vade araligindaki gorevler (dahil), vadeye gore artan. */
  listTasks(apartmentId: string, from: IsoDate, to: IsoDate): Promise<MaintenanceTask[]>;
  /** Yoksa yazar; varsa false (idempotent uretim). */
  createTaskIfAbsent(task: MaintenanceTask): Promise<boolean>;
  write(apartmentId: string, w: MaintenanceWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const versioned = (tableName: string, item: Record<string, unknown>, expected: number): TransactItem => ({
  Put: {
    TableName: tableName,
    Item: item,
    ...(expected === 0
      ? { ConditionExpression: 'attribute_not_exists(PK)' }
      : { ConditionExpression: 'attribute_exists(PK) AND #version = :expected', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': expected } }),
  },
});

export function createMaintenanceRepository(): MaintenanceRepository {
  return {
    getTemplate: (apartmentId, templateId) => getTenantItem<MaintenanceTemplate>(maintenanceKeys.template(apartmentId, templateId)),
    async listTemplates(apartmentId) {
      const items = await queryTenantAll<MaintenanceTemplate>(apartmentId, TEMPLATE_PREFIX, { ConsistentRead: true });
      return items.filter((t) => t.entityType === 'MAINT_TEMPLATE' && t.apartmentId === apartmentId);
    },
    getTask: (apartmentId, dueDate, templateId) => getTenantItem<MaintenanceTask>(maintenanceKeys.task(apartmentId, dueDate, templateId)),
    async listTasks(apartmentId, from, to) {
      const { client, tableName } = getDynamo();
      const items: MaintenanceTask[] = [];
      let startKey: Record<string, unknown> | undefined;
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
              ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
              ExpressionAttributeValues: { ':pk': tenantPk(apartmentId), ':lo': `${TASK_PREFIX}${from}`, ':hi': `${TASK_PREFIX}${to}~` },
              ConsistentRead: true,
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          items.push(...((out.Items ?? []) as MaintenanceTask[]));
          startKey = out.LastEvaluatedKey;
        } while (startKey);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return items.filter((t) => t.entityType === 'MAINT_TASK' && t.apartmentId === apartmentId);
    },
    async createTaskIfAbsent(task) {
      try {
        await putNewItem(task);
        return true;
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') return false;
        throw err;
      }
    },
    async write(apartmentId, w) {
      const all = [...(w.template ? [w.template.item] : []), ...(w.tasks ?? []).map((t) => t.item)];
      if (all.some((x) => x.apartmentId !== apartmentId)) throw new Error('Kiraci uyusmazligi');
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [];
      if (w.template) items.push(versioned(tableName, w.template.item, w.template.expectedVersion));
      for (const t of w.tasks ?? []) items.push(versioned(tableName, t.item, t.expectedVersion));
      for (const o of toOutboxItems(w.outbox ?? [], w.at, apartmentId)) items.push({ Put: { TableName: tableName, Item: o, ConditionExpression: 'attribute_not_exists(PK)' } });
      if (items.length + (w.audit ? 1 : 0) > 100) throw new Error('Atomik yazim 100 ogeyi asamaz');
      try {
        await sendWithAudit(client, items, w.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new MaintenanceConflictError();
        }
        throw toDataAccessError(err);
      }
    },
  };
}

export const maintenanceRepository: MaintenanceRepository = createMaintenanceRepository();
