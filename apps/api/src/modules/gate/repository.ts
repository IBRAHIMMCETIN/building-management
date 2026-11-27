import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, QueryCommand, type QueryCommandOutput, type TransactWriteCommandInput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, appendAudit, sendWithAudit } from '../audit/log.js';
import type { ThrottleStore } from './throttle.js';
import type { TableKeys } from '../core/types.js';
import { ValidationError } from '../core/validation.js';

/**
 * Guvenlik kapisi deposu. Tum anahtarlar `APT#<apartmentId>` bolumundedir (JWT claim'i); bir
 * yazimdaki tum ogeler + denetim kaydi tek `TransactWriteItems` ile yazilir. Silme yoktur.
 *
 * Kosullar acik tiplidir (sahte depo ayni anlami birebir uygular):
 *   new     -> attribute_not_exists(PK)                         (yeni kayit, idempotency, gunluk)
 *   match   -> attribute_exists(PK) AND alan = deger ...        (surum + durum: tek girislik gecis)
 *   new_or  -> attribute_not_exists(PK) OR (alan = deger ...)   (plaka bos ya da pasif)
 *   none    -> kosulsuz (yalnizca eklenen isaretciler)
 */
export type GateCondition =
  | { kind: 'new' }
  | { kind: 'match'; fields: Record<string, string | number | boolean> }
  | { kind: 'new_or'; fields: Record<string, string | number | boolean> }
  | { kind: 'none' };

/** Kosul bozulunca hangi is kuralinin cignendigi (servis anlamli hataya cevirir). */
export type GateConflictReason = 'duplicate' | 'version' | 'plate' | 'code' | 'exists' | 'slot';

export type GatePut = { item: TableKeys & Record<string, unknown>; condition: GateCondition; reason: GateConflictReason };
export type GateWrite = { puts: GatePut[]; audit?: AuditDraft };

export class GateConflictError extends Error {
  constructor(readonly reason: GateConflictReason) {
    super(`Kosul saglanmadi: ${reason}`);
    this.name = 'GateConflictError';
  }
}

export type GateQuery = {
  /** `begins_with(SK, prefix)`; ya da `from`/`to` ile `BETWEEN`. */
  prefix?: string;
  from?: string;
  to?: string;
  limit?: number;
  /** En yeni once. */
  desc?: boolean;
  cursor?: string;
};

export type GateRepository = ThrottleStore & {
  get<T>(apartmentId: string, sk: string): Promise<T | undefined>;
  getMany<T>(apartmentId: string, sks: readonly string[]): Promise<T[]>;
  query<T>(apartmentId: string, q: GateQuery): Promise<{ items: T[]; cursor?: string }>;
  write(apartmentId: string, w: GateWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function conditionOf(c: GateCondition) {
  if (c.kind === 'none') return {};
  if (c.kind === 'new') return { ConditionExpression: 'attribute_not_exists(PK)' };
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = Object.entries(c.fields).map(([k, v], i) => {
    names[`#c${i}`] = k;
    values[`:c${i}`] = v;
    return `#c${i} = :c${i}`;
  });
  const fields = parts.join(' AND ');
  return {
    ConditionExpression: c.kind === 'match' ? `attribute_exists(PK) AND ${fields}` : `attribute_not_exists(PK) OR (${fields})`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/** Sayfa imleci: son anahtar (yalnizca bu kiracinin bolumu kabul edilir). */
export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify({ SK: key.SK }), 'utf8').toString('base64url') : undefined;
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { SK?: unknown };
    if (typeof raw.SK === 'string' && raw.SK.length < 300) return raw.SK;
  } catch {
    // asagida
  }
  throw new ValidationError('cursor gecersiz', 'cursor');
}

export function createGateRepository(): GateRepository {
  return {
    get: (apartmentId, sk) => getTenantItem({ PK: tenantPk(apartmentId), SK: sk }),
    async getMany<T>(apartmentId: string, sks: readonly string[]) {
      const pk = tenantPk(apartmentId);
      const unique = [...new Set(sks)];
      const { client, tableName } = getDynamo();
      const out: T[] = [];
      for (let i = 0; i < unique.length; i += 100) {
        let keys: Record<string, unknown>[] = unique.slice(i, i + 100).map((SK) => ({ PK: pk, SK }));
        for (let attempt = 0; keys.length && attempt < 5; attempt++) {
          try {
            const res = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } } }));
            out.push(...((res.Responses?.[tableName] ?? []) as T[]));
            keys = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[];
          } catch (err) {
            throw toDataAccessError(err);
          }
        }
      }
      return out;
    },
    async query<T>(apartmentId: string, q: GateQuery) {
      const pk = tenantPk(apartmentId);
      const start = decodeCursor(q.cursor);
      const { client, tableName } = getDynamo();
      const range = q.prefix !== undefined;
      try {
        const out: QueryCommandOutput = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: range ? '#pk = :pk AND begins_with(#sk, :p)' : '#pk = :pk AND #sk BETWEEN :from AND :to',
            ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: range ? { ':pk': pk, ':p': q.prefix } : { ':pk': pk, ':from': q.from, ':to': q.to },
            ConsistentRead: true,
            ScanIndexForward: !q.desc,
            ...(q.limit ? { Limit: q.limit } : {}),
            ...(start ? { ExclusiveStartKey: { PK: pk, SK: start } } : {}),
          }),
        );
        return { items: (out.Items ?? []) as T[], ...(out.LastEvaluatedKey ? { cursor: encodeCursor(out.LastEvaluatedKey) } : {}) };
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async write(apartmentId, w) {
      const pk = tenantPk(apartmentId);
      if (w.puts.some((p) => p.item.PK !== pk)) throw new Error('Kiraci uyusmazligi');
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = w.puts.map((p) => ({ Put: { TableName: tableName, Item: p.item, ...conditionOf(p.condition) } }));
      try {
        await sendWithAudit(client, items, w.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const failed = (err.CancellationReasons ?? []).findIndex((r) => r.Code === 'ConditionalCheckFailed');
          const put = failed >= 0 ? w.puts[failed] : undefined;
          if (put) throw new GateConflictError(put.reason);
        }
        throw toDataAccessError(err);
      }
    },
    /**
     * Deneme sayaci (throttle.ts): `ADD count :w`, TTL ilk yazimda. `limit` verilirse yalnizca
     * `count < limit` iken; kosul bozulursa `ok: false` (sayac artmaz, kayit buyumez).
     */
    async hit(apartmentId, sk, weight, opts) {
      const { client, tableName } = getDynamo();
      const limited = opts.limit !== undefined;
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: tenantPk(apartmentId), SK: sk },
            UpdateExpression: 'ADD #count :w SET #et = :et, #apt = :apt, #ttl = if_not_exists(#ttl, :ttl)',
            ...(limited ? { ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit' } : {}),
            ExpressionAttributeNames: { '#count': 'count', '#et': 'entityType', '#apt': 'apartmentId', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':w': weight, ':et': 'GATE_THROTTLE', ':apt': apartmentId, ':ttl': opts.ttl, ...(limited ? { ':limit': opts.limit } : {}) },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        return { ok: true, count: Number(out.Attributes?.count ?? weight) };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return { ok: false, count: opts.limit ?? 0 };
        throw toDataAccessError(err);
      }
    },
    async audit(draft) {
      await appendAudit(draft);
    },
  };
}

export const gateRepository: GateRepository = createGateRepository();
