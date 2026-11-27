import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, putNewItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import type { IsoDateTime, TableKeys } from '../core/types.js';
import type { Poll, PollVote } from './types.js';

/** Oylama: `POLL#<pollId>`; oy: `POLLVOTE#<pollId>#<unitId>` (bolum basina tek kayit). */
export const pollKeys = {
  poll: (apartmentId: string, pollId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('POLL', pollId) }),
  vote: (apartmentId: string, pollId: string, unitId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('POLLVOTE', pollId, unitId) }),
};

/** Oy yazimi reddedildi: `poll` oylama artik acik degil, `vote` bolumun oyu bu arada degisti. */
export class PollVoteConflictError extends Error {
  constructor(readonly reason: 'poll' | 'vote') {
    super(reason === 'poll' ? 'Oylama oy kabul etmiyor' : 'Bolumun oyu bu arada degisti');
    this.name = 'PollVoteConflictError';
  }
}

export type PollRepository = {
  get(apartmentId: string, pollId: string): Promise<Poll | undefined>;
  list(apartmentId: string): Promise<Poll[]>;
  create(poll: Poll): Promise<void>;
  /**
   * Surumlu guncelleme. `audit` (yayin / kapatma / iptal) ve `outbox` (POLL_PUBLISHED) ayni
   * `TransactWriteItems` icinde yazilir. Surum veya olay cakismasinda `DataAccessError('conflict')`.
   */
  update(poll: Poll, expectedVersion: number, opts?: { audit?: AuditDraft; outbox?: DomainEvent[] }): Promise<void>;
  getVote(apartmentId: string, pollId: string, unitId: string): Promise<PollVote | undefined>;
  listVotes(apartmentId: string, pollId: string): Promise<PollVote[]>;
  /**
   * Bolumun oyunu yazar: `expectedVersion = 0` ilk oy (`attribute_not_exists`), aksi halde mevcut oyun
   * surumu. Ayni islemde oylamanin `published` ve `opensAt <= now < closesAt` oldugu dogrulanir.
   * Kosul saglanmazsa `PollVoteConflictError`.
   */
  putVote(vote: PollVote, expectedVersion: number, now: IsoDateTime): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function assertPollKeys(p: Poll): void {
  const k = pollKeys.poll(p.apartmentId, p.pollId);
  if (p.PK !== k.PK || p.SK !== k.SK) throw new Error(`Oylama anahtari tutarsiz: ${p.PK}/${p.SK}`);
}

function assertVoteKeys(v: PollVote): void {
  const k = pollKeys.vote(v.apartmentId, v.pollId, v.unitId);
  if (v.PK !== k.PK || v.SK !== k.SK) throw new Error(`Oy anahtari tutarsiz: ${v.PK}/${v.SK}`);
}

const conditionFailedAt = (err: unknown, index: number) =>
  err instanceof TransactionCanceledException && err.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

export function createPollRepository(): PollRepository {
  return {
    get: (apartmentId, pollId) => getTenantItem<Poll>(pollKeys.poll(apartmentId, pollId)),
    async list(apartmentId) {
      const items = await queryTenantAll<Poll>(apartmentId, 'POLL#', { ConsistentRead: true });
      return items.filter((p) => p.entityType === 'POLL' && p.apartmentId === apartmentId);
    },
    async create(poll) {
      assertPollKeys(poll);
      await putNewItem(poll);
    },
    async update(poll, expectedVersion, opts = {}) {
      assertPollKeys(poll);
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          Put: {
            TableName: tableName,
            Item: poll,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': expectedVersion },
          },
        },
        ...toOutboxItems(opts.outbox ?? [], poll.updatedAt, poll.apartmentId).map(
          (item): TransactItem => ({ Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }),
        ),
      ];
      try {
        await sendWithAudit(client, items, opts.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi veya olay zaten kayitli)', { cause: err });
        }
        throw toDataAccessError(err);
      }
    },
    getVote: (apartmentId, pollId, unitId) => getTenantItem<PollVote>(pollKeys.vote(apartmentId, pollId, unitId)),
    async listVotes(apartmentId, pollId) {
      const items = await queryTenantAll<PollVote>(apartmentId, `POLLVOTE#${pollId}#`, { ConsistentRead: true });
      return items.filter((v) => v.entityType === 'POLL_VOTE' && v.apartmentId === apartmentId && v.pollId === pollId);
    },
    async putVote(vote, expectedVersion, now) {
      assertVoteKeys(vote);
      const { client, tableName } = getDynamo();
      const pollKey = pollKeys.poll(vote.apartmentId, vote.pollId);
      const items: TransactItem[] = [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: pollKey,
            ConditionExpression: '#status = :published AND #opensAt <= :now AND #closesAt > :now',
            ExpressionAttributeNames: { '#status': 'status', '#opensAt': 'opensAt', '#closesAt': 'closesAt' },
            ExpressionAttributeValues: { ':published': 'published', ':now': now },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: vote,
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
        // Oylar denetim zincirine YAZILMAZ: zincir yoneticiye aciktir ve gizli oylamada kimin ne
        // zaman oy verdigini ara sonuclarla eslestirmeye yarardi. Cekisme (TransactionConflict)
        // ortak yardimcida ustel beklemeyle tekrar denenir.
        await sendWithAudit(client, items, undefined);
      } catch (err) {
        if (conditionFailedAt(err, 0)) throw new PollVoteConflictError('poll');
        if (conditionFailedAt(err, 1)) throw new PollVoteConflictError('vote');
        throw toDataAccessError(err);
      }
    },
  };
}

export const pollRepository: PollRepository = createPollRepository();
