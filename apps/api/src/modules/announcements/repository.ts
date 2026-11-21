import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  DataAccessError,
  getDynamo,
  getTenantItem,
  putNewItem,
  putVersionedItem,
  queryTenantAll,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { TableKeys } from '../core/types.js';
import type { Announcement } from '../portal/types.js';

/** Duyurular: PK = `APT#<apartmentId>`, SK = `ANN#<announcementId>`. */
export const announcementKeys = {
  announcement: (apartmentId: string, announcementId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('ANN', announcementId),
  }),
};

export type AnnouncementRepository = {
  get(apartmentId: string, announcementId: string): Promise<Announcement | undefined>;
  list(apartmentId: string): Promise<Announcement[]>;
  create(announcement: Announcement): Promise<void>;
  /**
   * Surumlu guncelleme. `outbox` verilirse olaylar ayni `TransactWriteItems` icinde
   * `OUTBOX#<eventId>` olarak yazilir (yayin onayi + ANNOUNCEMENT_PUBLISHED atomik).
   * Surum veya olay cakismasinda `DataAccessError('conflict')`.
   */
  update(announcement: Announcement, expectedVersion: number, outbox?: DomainEvent[]): Promise<void>;
};

function assertKeys(a: Announcement): void {
  const expected = announcementKeys.announcement(a.apartmentId, a.announcementId);
  if (a.PK !== expected.PK || a.SK !== expected.SK) {
    throw new Error(`Duyuru anahtari tutarsiz: ${a.PK}/${a.SK}`);
  }
}

export function createAnnouncementRepository(): AnnouncementRepository {
  return {
    get: (apartmentId, id) => getTenantItem<Announcement>(announcementKeys.announcement(apartmentId, id)),
    list: (apartmentId) => queryTenantAll<Announcement>(apartmentId, 'ANN#', { ConsistentRead: true }),
    async create(a) {
      assertKeys(a);
      await putNewItem(a);
    },
    async update(a, expectedVersion, outbox = []) {
      assertKeys(a);
      if (outbox.length === 0) {
        await putVersionedItem(a, expectedVersion);
        return;
      }
      const outboxItems = toOutboxItems(outbox, a.updatedAt, a.apartmentId);
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: a,
                  ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
                },
              },
              ...outboxItems.map((item) => ({
                Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' },
              })),
            ],
          }),
        );
      } catch (err) {
        if (
          err instanceof TransactionCanceledException &&
          (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')
        ) {
          throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi veya olay zaten kayitli)', { cause: err });
        }
        throw toDataAccessError(err);
      }
    },
  };
}

export const announcementRepository: AnnouncementRepository = createAnnouncementRepository();
