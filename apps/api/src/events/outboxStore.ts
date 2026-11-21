import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo, toDataAccessError } from '../config/dynamodb.js';
import { OUTBOX_PENDING_PK, type OutboxItem, outboxKeys } from './outbox.js';

/**
 * Outbox kayitlarinin durum yonetimi (relay ve suprucu).
 *
 * Outbox defter DEGILDIR: yayinlanan kayit guncellenir (`pending -> published`) ve bekleyen
 * dizinden (seyrek GSI1) cikarilir; 30 gun sonra TTL ile silinir. Defter kayitlari (TX/LE)
 * bu depodan asla etkilenmez.
 */

/** Yayinlanmis outbox kaydinin saklanma suresi (gun); sonra TTL ile silinir. */
export const OUTBOX_PUBLISHED_RETENTION_DAYS = 30;

export type MarkPublishedResult = 'updated' | 'already';

export type OutboxStore = {
  /**
   * Kaydi yayinlandi olarak isaretler: `status = published`, `publishedAt`, `ttl`;
   * `GSI1PK/GSI1SK` kaldirilir. Idempotent: kayit zaten yayinlanmissa (veya TTL ile silinmisse)
   * `already` doner ve ilk `publishedAt` korunur.
   */
  markPublished(apartmentId: string, eventId: string, publishedAt: Date): Promise<MarkPublishedResult>;
  /**
   * Bekleyen kayitlar, en eskiden yeniye (GSI1 `OUTBOX#PENDING`). `olderThan` verilirse
   * yalnizca o andan once yazilanlar (suprucu esigi). GSI nihai tutarlidir: yeni yayinlanmis
   * bir kayit kisa sure listede gorunebilir (relay idempotent oldugundan zararsiz).
   */
  listPending(options?: { limit?: number; olderThan?: Date }): Promise<OutboxItem[]>;
};

export function createDynamoOutboxStore(): OutboxStore {
  return {
    async markPublished(apartmentId, eventId, publishedAt) {
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: outboxKeys(apartmentId, eventId),
            UpdateExpression: 'SET #status = :published, #publishedAt = :at, #ttl = :ttl REMOVE #gpk, #gsk',
            // Yalnizca bekleyen kayit: yoksa (TTL ile silinmis) veya zaten yayinlanmissa dokunulmaz.
            ConditionExpression: 'attribute_exists(PK) AND #status = :pending',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#publishedAt': 'publishedAt',
              '#ttl': 'ttl',
              '#gpk': 'GSI1PK',
              '#gsk': 'GSI1SK',
            },
            ExpressionAttributeValues: {
              ':published': 'published',
              ':pending': 'pending',
              ':at': publishedAt.toISOString(),
              ':ttl': Math.floor(publishedAt.getTime() / 1000) + OUTBOX_PUBLISHED_RETENTION_DAYS * 86_400,
            },
          }),
        );
        return 'updated';
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'already';
        throw toDataAccessError(err);
      }
    },

    async listPending(options = {}) {
      const { client, tableName } = getDynamo();
      const limit = options.limit ?? 25;
      const values: Record<string, string> = { ':pk': OUTBOX_PENDING_PK };
      let condition = '#pk = :pk';
      if (options.olderThan) {
        condition += ' AND #sk < :before';
        values[':before'] = options.olderThan.toISOString();
      }
      try {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'GSI1',
            KeyConditionExpression: condition,
            ExpressionAttributeNames: { '#pk': 'GSI1PK', ...(options.olderThan ? { '#sk': 'GSI1SK' } : {}) },
            ExpressionAttributeValues: values,
            ScanIndexForward: true,
            Limit: limit,
          }),
        );
        return (out.Items ?? []) as OutboxItem[];
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
  };
}
