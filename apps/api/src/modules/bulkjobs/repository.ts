import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, putVersionedItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { BulkDuesLine, BulkDuesLineResult } from '../finance/service.js';
import type { BulkJob, DuesLineChunk, DuesResultChunk, JobOutputChunk } from './types.js';

/**
 * Is kaydi deposu. Tum guncellemeler surum kosullu (`version`): kira alma, ilerleme ve bitis ayni
 * optimistic kilitle yapilir; iki worker ayni isi ayni anda ilerletemez.
 */
export type BulkJobRepository = {
  get(apartmentId: string, jobId: string): Promise<BulkJob | undefined>;
  /** Is kaydi yoksa (kosullu) is + satir kayitlari atomik yazilir; varsa `DataAccessError('conflict')`. */
  create(job: BulkJob, lineChunks: readonly BulkDuesLine[][]): Promise<void>;
  /**
   * `expectedVersion` tutarsa ustune yazar; degilse `DataAccessError('conflict')`. `outbox`: ayni
   * atomik yazimda saklanacak olaylar (bitis ozeti `BULK_JOB_FINISHED`).
   */
  update(job: BulkJob, expectedVersion: number, opts?: { outbox?: DomainEvent[] }): Promise<void>;
  getLines(apartmentId: string, jobId: string, index: number): Promise<BulkDuesLine[]>;
  /** Ayni `start` ile tekrar yazim ayni icerigi yazar (idempotent). */
  putResults(apartmentId: string, jobId: string, start: number, results: readonly BulkDuesLineResult[], ttl: number): Promise<void>;
  listResults(apartmentId: string, jobId: string): Promise<BulkDuesLineResult[]>;
  /** P1-c: kimligi `jobIdPrefix` ile baslayan is kayitlari (satir / sonuc parcalari haric). */
  listByPrefix?(apartmentId: string, jobIdPrefix: string): Promise<BulkJob[]>;
  /** Sayac onizlemesi: is ciktisi (JSON metni parcalari; ayni is icin tekrar yazim ustune yazar). */
  putOutput?(apartmentId: string, jobId: string, chunks: readonly string[], ttl: number): Promise<void>;
  getOutput?(apartmentId: string, jobId: string, count: number): Promise<string[]>;
};

export const bulkJobKeys = {
  job: (apartmentId: string, jobId: string) => ({ PK: tenantPk(apartmentId), SK: skKey('BULKJOB', jobId) }),
  lines: (apartmentId: string, jobId: string, index: number) => ({ PK: tenantPk(apartmentId), SK: `${skKey('BULKJOB', jobId)}#L#${String(index).padStart(4, '0')}` }),
  results: (apartmentId: string, jobId: string, start: number) => ({ PK: tenantPk(apartmentId), SK: `${skKey('BULKJOB', jobId)}#R#${String(start).padStart(5, '0')}` }),
  resultsPrefix: (jobId: string) => `${skKey('BULKJOB', jobId)}#R#`,
  output: (apartmentId: string, jobId: string, index: number) => ({ PK: tenantPk(apartmentId), SK: `${skKey('BULKJOBOUT', jobId)}#${String(index).padStart(4, '0')}` }),
};

/** Ayni bolum birden fazla sonuc parcasinda olabilir (yeniden deneme); son yazilan gecerlidir. */
export function mergeResults(chunks: readonly Pick<DuesResultChunk, 'start' | 'results'>[]): BulkDuesLineResult[] {
  const byUnit = new Map<string, { order: number; result: BulkDuesLineResult }>();
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    chunk.results.forEach((r, i) => byUnit.set(r.unitId, { order: chunk.start + i, result: r }));
  }
  return [...byUnit.values()].sort((a, b) => a.order - b.order).map((x) => x.result);
}

export function createDynamoBulkJobRepository(): BulkJobRepository {
  return {
    async get(apartmentId, jobId) {
      return getTenantItem<BulkJob>(bulkJobKeys.job(apartmentId, jobId));
    },
    async listByPrefix(apartmentId, jobIdPrefix) {
      const items = await queryTenantAll<BulkJob>(apartmentId, `BULKJOB#${jobIdPrefix}`, { ConsistentRead: true });
      return items.filter((j) => j.entityType === 'BULK_JOB');
    },
    async create(job, lineChunks) {
      const { client, tableName } = getDynamo();
      // Is + en fazla 99 satir parcasi tek islemde (5.000 bolum = 20 parca).
      if (lineChunks.length > 99) throw new DataAccessError('internal', 'Toplu is satir parcasi siniri asildi');
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: tableName, Item: job, ConditionExpression: 'attribute_not_exists(PK)' } },
              ...lineChunks.map((lines, index) => {
                const item: DuesLineChunk = { ...bulkJobKeys.lines(job.apartmentId, job.jobId, index), entityType: 'BULK_JOB_LINES', jobId: job.jobId, index, lines: [...lines], ttl: job.ttl };
                return { Put: { TableName: tableName, Item: item } };
              }),
            ],
          }),
        );
      } catch (err) {
        const mapped = toDataAccessError(err);
        // Islem iptalinin tek kosulu is kaydinin var olmasidir.
        if (mapped.code === 'transaction_failed' && /ConditionalCheckFailed/.test(mapped.message)) {
          throw new DataAccessError('conflict', 'Toplu is zaten var', { cause: err });
        }
        throw mapped;
      }
    },
    async update(job, expectedVersion, opts = {}) {
      if (!opts.outbox?.length) {
        await putVersionedItem(job, expectedVersion);
        return;
      }
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: job,
                  ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
                },
              },
              ...toOutboxItems(opts.outbox, job.updatedAt, job.apartmentId).map((o) => ({ Put: { TableName: tableName, Item: o, ConditionExpression: 'attribute_not_exists(PK)' } })),
            ],
          }),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi)', { cause: err });
        }
        throw toDataAccessError(err);
      }
    },
    async getLines(apartmentId, jobId, index) {
      const item = await getTenantItem<DuesLineChunk>(bulkJobKeys.lines(apartmentId, jobId, index));
      if (!item) throw new DataAccessError('not_found', `Toplu is satir parcasi bulunamadi (${index})`);
      return item.lines;
    },
    async putResults(apartmentId, jobId, start, results, ttl) {
      const { client, tableName } = getDynamo();
      const item: DuesResultChunk = { ...bulkJobKeys.results(apartmentId, jobId, start), entityType: 'BULK_JOB_RESULTS', jobId, start, results: [...results], ttl };
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item }));
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async listResults(apartmentId, jobId) {
      const items = await queryTenantAll<DuesResultChunk>(apartmentId, bulkJobKeys.resultsPrefix(jobId), { ConsistentRead: true });
      return mergeResults(items);
    },
    async putOutput(apartmentId, jobId, chunks, ttl) {
      const { client, tableName } = getDynamo();
      try {
        // Parca basina tek oge (her biri 400 KB altinda); is bitisi ancak tumu yazildiktan sonra.
        for (const [index, data] of chunks.entries()) {
          const item: JobOutputChunk = { ...bulkJobKeys.output(apartmentId, jobId, index), entityType: 'BULK_JOB_OUTPUT', jobId, index, data, ttl };
          await client.send(new PutCommand({ TableName: tableName, Item: item }));
        }
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async getOutput(apartmentId, jobId, count) {
      const items = await queryTenantAll<JobOutputChunk>(apartmentId, `${skKey('BULKJOBOUT', jobId)}#`, { ConsistentRead: true });
      const parts = items.filter((i) => i.entityType === 'BULK_JOB_OUTPUT' && i.jobId === jobId && i.index < count).sort((a, b) => a.index - b.index);
      if (parts.length !== count) throw new DataAccessError('not_found', 'Onizleme ciktisi eksik');
      return parts.map((p) => p.data);
    },
  };
}

/** Bellek ici depo (testler). Kayitlar kopyalanarak saklanir. */
export function createMemoryBulkJobRepository() {
  const jobs = new Map<string, BulkJob>();
  const lines = new Map<string, BulkDuesLine[]>();
  const results = new Map<string, DuesResultChunk>();
  /** Is kaydiyla ayni yazimda saklanan olaylar (yazim sirasiyla). */
  const outbox: DomainEvent[] = [];
  const outputs = new Map<string, string[]>();
  const k = (apartmentId: string, jobId: string) => `${apartmentId}|${jobId}`;
  const clone = <T>(v: T): T => structuredClone(v);
  const repository: BulkJobRepository = {
    async get(apartmentId, jobId) {
      const j = jobs.get(k(apartmentId, jobId));
      return j ? clone(j) : undefined;
    },
    async listByPrefix(apartmentId, jobIdPrefix) {
      return [...jobs.values()].filter((j) => j.apartmentId === apartmentId && j.jobId.startsWith(jobIdPrefix)).map(clone);
    },
    async create(job, chunks) {
      if (jobs.has(k(job.apartmentId, job.jobId))) throw new DataAccessError('conflict', 'Toplu is zaten var');
      jobs.set(k(job.apartmentId, job.jobId), clone(job));
      chunks.forEach((c, i) => lines.set(`${k(job.apartmentId, job.jobId)}|${i}`, clone([...c])));
    },
    async update(job, expectedVersion, opts = {}) {
      const cur = jobs.get(k(job.apartmentId, job.jobId));
      if (!cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'Kosul saglanmadi (kayit mevcut veya surum catismasi)');
      if (opts.outbox?.some((e) => outbox.some((o) => o.eventId === e.eventId))) throw new DataAccessError('conflict', 'Olay zaten var');
      jobs.set(k(job.apartmentId, job.jobId), clone(job));
      outbox.push(...(opts.outbox ?? []).map(clone));
    },
    async getLines(apartmentId, jobId, index) {
      const l = lines.get(`${k(apartmentId, jobId)}|${index}`);
      if (!l) throw new DataAccessError('not_found', `Toplu is satir parcasi bulunamadi (${index})`);
      return clone(l);
    },
    async putResults(apartmentId, jobId, start, rs, ttl) {
      results.set(`${k(apartmentId, jobId)}|${start}`, { ...bulkJobKeys.results(apartmentId, jobId, start), entityType: 'BULK_JOB_RESULTS', jobId, start, results: clone([...rs]), ttl });
    },
    async listResults(apartmentId, jobId) {
      const prefix = `${k(apartmentId, jobId)}|`;
      return mergeResults([...results.entries()].filter(([key]) => key.startsWith(prefix)).map(([, v]) => v));
    },
    async putOutput(apartmentId, jobId, chunks) {
      outputs.set(k(apartmentId, jobId), [...chunks]);
    },
    async getOutput(apartmentId, jobId, count) {
      const parts = outputs.get(k(apartmentId, jobId)) ?? [];
      if (parts.length < count) throw new DataAccessError('not_found', 'Onizleme ciktisi eksik');
      return parts.slice(0, count);
    },
  };
  return { repository, jobs, lines, results, outbox, outputs };
}
