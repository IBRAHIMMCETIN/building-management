import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, queryTenantAll, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { AuditChainBusyError, type AuditDraft, WriteContentionError, sendWithAudit } from '../audit/log.js';
import { type Tender, type TenderComment, type TenderIdempotency, type TenderStatus, tenderKeys } from './types.js';

/**
 * Ihale deposu. Ihale (teklifler kaydin icinde), yorum, idempotency ve denetim kaydi tek
 * `TransactWriteItems` ile yazilir. Hicbir oge silinmez (Lambda'larin DeleteItem yetkisi yok):
 * iptal ve geri cekme durum alanidir.
 */
export class TenderConflictError extends Error {
  constructor(
    /** `duplicate`: idempotency anahtari kullanilmis; `version`: ihale degisti; `status`: yorum icin ihale artik yayinda degil. */
    readonly reason: 'duplicate' | 'version' | 'status',
    message = 'İhale başka bir işlemle değişti; sayfayı yenileyin',
  ) {
    super(message);
    this.name = 'TenderConflictError';
  }
}

export type TenderWrite = {
  /** 0: yeni ihale. */
  tender?: { item: Tender; expectedVersion: number };
  /** Yeni yorum; ayni yazimda ihalenin verilen durumda oldugu kontrol edilir. */
  comment?: { item: TenderComment; requireStatus: TenderStatus };
  idempotency?: TenderIdempotency;
  audit?: AuditDraft;
};

export type TenderRepository = {
  get(apartmentId: string, tenderId: string): Promise<Tender | undefined>;
  list(apartmentId: string): Promise<Tender[]>;
  listComments(apartmentId: string, tenderId: string): Promise<TenderComment[]>;
  getIdempotency(apartmentId: string, key: string): Promise<TenderIdempotency | undefined>;
  write(apartmentId: string, w: TenderWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export function createTenderRepository(): TenderRepository {
  return {
    async get(apt, id) {
      const t = await getTenantItem<Tender>(tenderKeys.tender(apt, id));
      return t?.entityType === 'TENDER' && t.apartmentId === apt ? t : undefined;
    },
    async list(apt) {
      const items = await queryTenantAll<Tender>(apt, tenderKeys.tenderPrefix, { ConsistentRead: true });
      return items.filter((t) => t.entityType === 'TENDER' && t.apartmentId === apt);
    },
    async listComments(apt, tenderId) {
      const items = await queryTenantAll<TenderComment>(apt, tenderKeys.commentPrefix(tenderId), { ConsistentRead: true });
      return items.filter((c) => c.entityType === 'TENDER_COMMENT' && c.apartmentId === apt && c.tenderId === tenderId);
    },
    getIdempotency: (apt, key) => getTenantItem<TenderIdempotency>(tenderKeys.idempotency(apt, key)),
    async write(apt, w) {
      const pk = tenantPk(apt);
      for (const doc of [w.tender?.item, w.comment?.item, w.idempotency]) {
        if (doc && doc.PK !== pk) throw new Error('Kiraci uyusmazligi');
      }
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [];
      const kinds: TenderConflictError['reason'][] = [];
      const add = (kind: TenderConflictError['reason'], item: TransactItem) => {
        items.push(item);
        kinds.push(kind);
      };
      if (w.idempotency) add('duplicate', { Put: { TableName: tableName, Item: w.idempotency, ConditionExpression: 'attribute_not_exists(PK)' } });
      if (w.tender) {
        const expected = w.tender.expectedVersion;
        add('version', {
          Put: {
            TableName: tableName,
            Item: w.tender.item,
            ...(expected === 0
              ? { ConditionExpression: 'attribute_not_exists(PK)' }
              : {
                  ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: { ':expected': expected },
                }),
          },
        });
      }
      if (w.comment) {
        add('status', {
          ConditionCheck: {
            TableName: tableName,
            Key: tenderKeys.tender(apt, w.comment.item.tenderId),
            ConditionExpression: 'attribute_exists(PK) AND #status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':status': w.comment.requireStatus },
          },
        });
        add('duplicate', { Put: { TableName: tableName, Item: w.comment.item, ConditionExpression: 'attribute_not_exists(PK)' } });
      }
      try {
        await sendWithAudit(client, items, w.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const failed = (err.CancellationReasons ?? []).findIndex((r) => r.Code === 'ConditionalCheckFailed');
          if (failed >= 0 && failed < kinds.length) throw new TenderConflictError(kinds[failed] as TenderConflictError['reason']);
        }
        // Tekrar denemeleri tukenmis cekisme: istemci guncel kaydi okuyup yeniden denemeli.
        if (err instanceof WriteContentionError || err instanceof AuditChainBusyError) throw new TenderConflictError('version');
        throw toDataAccessError(err);
      }
    },
  };
}

export const tenderRepository: TenderRepository = createTenderRepository();
