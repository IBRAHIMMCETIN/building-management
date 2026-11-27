import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, QueryCommand, type QueryCommandOutput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
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

export type GateRepository = {
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
  };
}

export const gateRepository: GateRepository = createGateRepository();
