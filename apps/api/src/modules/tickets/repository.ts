import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, queryTenantAll, toDataAccessError } from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import type { TableKeys } from '../core/types.js';
import { TICKET_PREFIX, type Ticket, type TicketEvent, type TicketIndex, ticketKeys } from './types.js';

/**
 * Faz 3 (O1) - Talep deposu. Talep, zaman cizelgesi olaylari, indeksler, sayac, idempotency kaydi,
 * outbox olaylari ve denetim kaydi tek `TransactWriteItems` ile yazilir.
 */
export class TicketConflictError extends Error {
  constructor(
    readonly reason: 'version' | 'duplicate' | 'counter',
    message = 'Talep başka bir işlemle değişti; sayfayı yenileyin',
  ) {
    super(message);
    this.name = 'TicketConflictError';
  }
}

export type TicketIdempotency = TableKeys & { entityType: 'TICKET_IDEMPOTENCY'; apartmentId: string; ticketId: string; fingerprint: string; createdAt: string };

export type TicketWrite = {
  /** Talep kaydi degisiyorsa yeni hali. Yalnizca olay ekleniyorsa (yorum) verilmez; `exists` kontrol edilir. */
  ticket?: Ticket;
  /** 0: yeni talep. */
  expectedVersion?: number;
  /** `ticket` verilmediginde talebin var oldugu kontrol edilir. */
  exists?: TableKeys;
  /** Zaman damgasi (outbox kayitlari icin). */
  at: string;
  events?: TicketEvent[];
  putIndexes?: TicketIndex[];
  deleteIndexes?: TableKeys[];
  /** Yeni talepte numara sayaci: beklenen mevcut deger. */
  counter?: { expected: number };
  idempotency?: TicketIdempotency;
  outbox?: DomainEvent[];
  audit?: AuditDraft;
};

export type TicketRepository = {
  get(apartmentId: string, ticketId: string): Promise<Ticket | undefined>;
  list(apartmentId: string): Promise<Ticket[]>;
  getMany(apartmentId: string, ticketIds: readonly string[]): Promise<Ticket[]>;
  /** Indeks on ekine gore talep kimlikleri (TKASSIGN#/TKUNIT#/TKUSER#). */
  listIndexed(apartmentId: string, prefix: string): Promise<string[]>;
  listEvents(apartmentId: string, ticketId: string): Promise<TicketEvent[]>;
  getIdempotency(apartmentId: string, key: string): Promise<TicketIdempotency | undefined>;
  getCounter(apartmentId: string): Promise<number>;
  write(apartmentId: string, w: TicketWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export function createTicketRepository(): TicketRepository {
  const repo: TicketRepository = {
    get: (apartmentId, ticketId) => getTenantItem<Ticket>(ticketKeys.ticket(apartmentId, ticketId)),
    async list(apartmentId) {
      const items = await queryTenantAll<Ticket>(apartmentId, TICKET_PREFIX, { ConsistentRead: true });
      return items.filter((t) => t.entityType === 'TICKET' && t.apartmentId === apartmentId);
    },
    async getMany(apartmentId, ticketIds) {
      const ids = [...new Set(ticketIds)];
      const { client, tableName } = getDynamo();
      const out: Ticket[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Record<string, unknown>[] = ids.slice(i, i + 100).map((id) => ticketKeys.ticket(apartmentId, id));
        for (let attempt = 0; keys.length && attempt < 5; attempt++) {
          try {
            const res = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } } }));
            out.push(...((res.Responses?.[tableName] ?? []) as Ticket[]));
            keys = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[];
          } catch (err) {
            throw toDataAccessError(err);
          }
        }
      }
      return out.filter((t) => t.apartmentId === apartmentId);
    },
    async listIndexed(apartmentId, prefix) {
      const items = await queryTenantAll<TicketIndex>(apartmentId, prefix, { ConsistentRead: true });
      return items.map((i) => i.ticketId);
    },
    async listEvents(apartmentId, ticketId) {
      const items = await queryTenantAll<TicketEvent>(apartmentId, ticketKeys.eventPrefix(ticketId), { ConsistentRead: true });
      return items.filter((e) => e.apartmentId === apartmentId).sort((a, b) => a.SK.localeCompare(b.SK));
    },
    getIdempotency: (apartmentId, key) => getTenantItem<TicketIdempotency>(ticketKeys.idempotency(apartmentId, key)),
    async getCounter(apartmentId) {
      const item = await getTenantItem<{ value?: number }>(ticketKeys.counter(apartmentId));
      return item?.value ?? 0;
    },
    async write(apartmentId, w) {
      if (w.ticket && w.ticket.apartmentId !== apartmentId) throw new Error('Kiraci uyusmazligi');
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [];
      const kinds: TicketConflictError['reason'][] = [];
      const add = (kind: TicketConflictError['reason'], item: TransactItem) => {
        items.push(item);
        kinds.push(kind);
      };
      if (w.idempotency) {
        add('duplicate', { Put: { TableName: tableName, Item: w.idempotency, ConditionExpression: 'attribute_not_exists(PK)' } });
      }
      if (w.ticket) {
        const expected = w.expectedVersion ?? 0;
        add('version', {
          Put: {
            TableName: tableName,
            Item: w.ticket,
            ...(expected === 0
              ? { ConditionExpression: 'attribute_not_exists(PK)' }
              : {
                  ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: { ':expected': expected },
                }),
          },
        });
      } else if (w.exists) {
        add('version', { ConditionCheck: { TableName: tableName, Key: { PK: w.exists.PK, SK: w.exists.SK }, ConditionExpression: 'attribute_exists(PK)' } });
      }
      if (w.counter) {
        const expected = w.counter.expected;
        add('counter', {
          Update: {
            TableName: tableName,
            Key: ticketKeys.counter(apartmentId),
            UpdateExpression: 'SET #value = :next, #updatedAt = :now',
            ConditionExpression: expected === 0 ? 'attribute_not_exists(PK)' : '#value = :expected',
            ExpressionAttributeNames: { '#value': 'value', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':next': expected + 1, ':now': w.at, ...(expected === 0 ? {} : { ':expected': expected }) },
          },
        });
      }
      for (const e of w.events ?? []) add('version', { Put: { TableName: tableName, Item: e, ConditionExpression: 'attribute_not_exists(PK)' } });
      for (const i of w.putIndexes ?? []) add('version', { Put: { TableName: tableName, Item: i } });
      for (const k of w.deleteIndexes ?? []) add('version', { Delete: { TableName: tableName, Key: { PK: k.PK, SK: k.SK } } });
      for (const o of toOutboxItems(w.outbox ?? [], w.at, apartmentId)) {
        add('version', { Put: { TableName: tableName, Item: o, ConditionExpression: 'attribute_not_exists(PK)' } });
      }
      try {
        await sendWithAudit(client, items, w.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const reasons = err.CancellationReasons ?? [];
          const failed = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
          if (failed >= 0 && failed < kinds.length) throw new TicketConflictError(kinds[failed] as TicketConflictError['reason']);
        }
        throw toDataAccessError(err);
      }
    },
  };
  return repo;
}

export const ticketRepository: TicketRepository = createTicketRepository();
