import { GetCommand, PutCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { ValidationError } from '../core/validation.js';
import { type AuditEntry, type ChainFinding, type ChainTail, auditTable, seqKey, verifyChain } from './log.js';

/**
 * Denetim gunlugu okuma (listeleme, zincir dogrulamasi) ve dogrulama kontrol noktasi.
 * Bu modul denetim tablosuna YAZMAZ (yazim yalnizca `log.ts`'teki atomik yardimcilarla).
 * Kontrol noktasi ana tabloda tutulur: `PK = <kapsam>`, `SK = AUDITCHECK`.
 */

export type AuditListQuery = {
  limit: number;
  cursor?: string;
  /** ISO tarih-saat, dahil. */
  from?: string;
  to?: string;
  action?: string;
  actorId?: string;
};

export type AuditPage = { items: AuditEntry[]; cursor?: string };

export type AuditReader = {
  list(scope: string, query: AuditListQuery): Promise<AuditPage>;
  /** `afterSeq`'ten sonraki kayitlar, artan sirada (dogrulama). */
  listAfter(scope: string, afterSeq: number, limit?: number): Promise<AuditEntry[]>;
  get(scope: string, seq: number): Promise<AuditEntry | undefined>;
};

export class InvalidAuditCursorError extends ValidationError {
  constructor() {
    super('Gecersiz sayfa imleci', 'cursor');
  }
}

const encodeCursor = (key: Record<string, unknown>) => Buffer.from(JSON.stringify({ PK: key.PK, SK: key.SK }), 'utf8').toString('base64url');

function decodeCursor(cursor: string, scope: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    // Imlec istemciden gelir: baska kapsamin anahtari kabul edilmez (tenant izolasyonu).
    if (key.PK !== scope || typeof key.SK !== 'string' || !key.SK.startsWith('SEQ#')) throw new Error('scope');
    return { PK: key.PK, SK: key.SK };
  } catch {
    throw new InvalidAuditCursorError();
  }
}

export function createAuditReader(): AuditReader {
  const table = () => auditTable();
  return {
    async list(scope, q) {
      const t = table();
      if (!t) return { items: [] };
      const { client } = getDynamo();
      const names: Record<string, string> = { '#pk': 'PK', '#sk': 'SK' };
      const values: Record<string, unknown> = { ':pk': scope, ':seq': 'SEQ#' };
      const filters: string[] = [];
      if (q.from) {
        filters.push('#at >= :from');
        names['#at'] = 'at';
        values[':from'] = q.from;
      }
      if (q.to) {
        filters.push('#at <= :to');
        names['#at'] = 'at';
        values[':to'] = q.to;
      }
      if (q.action) {
        filters.push('begins_with(#action, :action)');
        names['#action'] = 'action';
        values[':action'] = q.action;
      }
      if (q.actorId) {
        filters.push('#actor.#uid = :uid');
        names['#actor'] = 'actor';
        names['#uid'] = 'userId';
        values[':uid'] = q.actorId;
      }
      const items: AuditEntry[] = [];
      let startKey: Record<string, unknown> | undefined = q.cursor ? decodeCursor(q.cursor, scope) : undefined;
      let rounds = 0;
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: t,
              KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :seq)',
              ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
              ScanIndexForward: false,
              Limit: Math.max(q.limit - items.length, 1) * (filters.length ? 4 : 1),
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          for (const item of (out.Items ?? []) as AuditEntry[]) {
            if (items.length < q.limit) items.push(item);
          }
          startKey = out.LastEvaluatedKey;
          if (items.length >= q.limit) {
            const last = items[items.length - 1];
            startKey = last ? { PK: last.PK, SK: last.SK } : startKey;
            break;
          }
        } while (startKey && ++rounds < 10);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return { items, ...(startKey ? { cursor: encodeCursor(startKey) } : {}) };
    },

    async listAfter(scope, afterSeq, limit = 1000) {
      const t = table();
      if (!t) return [];
      const { client } = getDynamo();
      const items: AuditEntry[] = [];
      let startKey: Record<string, unknown> | undefined;
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: t,
              KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
              ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
              ExpressionAttributeValues: { ':pk': scope, ':lo': seqKey(afterSeq + 1), ':hi': 'SEQ#~' },
              ScanIndexForward: true,
              ConsistentRead: true,
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          items.push(...((out.Items ?? []) as AuditEntry[]));
          startKey = out.LastEvaluatedKey;
        } while (startKey && items.length < limit);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return items.slice(0, limit);
    },

    async get(scope, seq) {
      const t = table();
      if (!t) return undefined;
      const { client } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: t, Key: { PK: scope, SK: seqKey(seq) }, ConsistentRead: true }));
        return out.Item as AuditEntry | undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Artimli zincir dogrulamasi (gecelik `ledger_audit`)
// ---------------------------------------------------------------------------

export type Checkpoint = ChainTail & { verifiedAt: string };

export type CheckpointStore = {
  get(scope: string): Promise<Checkpoint | undefined>;
  put(scope: string, checkpoint: Checkpoint): Promise<void>;
};

const checkpointKey = (scope: string) => ({ PK: scope, SK: 'AUDITCHECK' });

export function createDynamoCheckpointStore(): CheckpointStore {
  return {
    async get(scope) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: checkpointKey(scope), ConsistentRead: true }));
        const item = out.Item as (Checkpoint & { seq: number }) | undefined;
        return item ? { seq: item.seq, hash: item.hash, verifiedAt: item.verifiedAt } : undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async put(scope, cp) {
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new PutCommand({ TableName: tableName, Item: { ...checkpointKey(scope), entityType: 'AUDIT_CHECKPOINT', scope, ...cp } }),
        );
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
  };
}

export type ChainVerification = { scope: string; checked: number; findings: ChainFinding[]; last?: ChainTail };

/**
 * Kontrol noktasindan sonraki kayitlari dogrular. Kontrol noktasindaki kayit hala ayni hash'e
 * sahip olmali (sonradan ustune yazilmissa yakalanir). Bulgu yoksa kontrol noktasi ilerler;
 * bulgu varsa ilerlemez (ertesi gece yeniden raporlanir).
 */
export async function verifyAuditScope(
  scope: string,
  deps: { reader: Pick<AuditReader, 'listAfter' | 'get'>; checkpoints: CheckpointStore; now: () => Date },
): Promise<ChainVerification> {
  const cp = await deps.checkpoints.get(scope);
  const findings: ChainFinding[] = [];
  let start: ChainTail | undefined;
  if (cp) {
    const anchor = await deps.reader.get(scope, cp.seq);
    // TTL ile silinmis (10 yil) kontrol noktasi kaydi bulgu degildir; varsa ayni olmali.
    if (anchor && anchor.hash !== cp.hash) findings.push({ code: 'audit_checkpoint_mismatch', scope, seq: cp.seq });
    start = { seq: cp.seq, hash: cp.hash };
  }
  const entries = await deps.reader.listAfter(scope, cp?.seq ?? 0);
  const result = verifyChain(scope, entries, start);
  findings.push(...result.findings);
  if (findings.length === 0 && result.last && (!cp || result.last.seq > cp.seq)) {
    await deps.checkpoints.put(scope, { ...result.last, verifiedAt: deps.now().toISOString() });
  }
  return { scope, checked: entries.length, findings, ...(result.last ? { last: result.last } : {}) };
}
