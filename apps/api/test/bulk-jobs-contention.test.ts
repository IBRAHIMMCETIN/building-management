/**
 * Toplu aidat isinin 275 / 303'te takilmasi (dev, Kasim 2026):
 *   DataAccessError: Islem iptal edildi: None,None,None,None,None,TransactionConflict,None,TransactionConflict,ConditionalCheckFailed
 *
 * Oge sirasi (postBatch): 0 idempotency, 1 islem, 2-3 defter satirlari, 4 alt cari, 5 gelir hesabi,
 * 6 outbox, 7 donem kilidi ConditionCheck, 8 denetim kaydi. Eszamanli kalemler ayni gelir hesabina,
 * kilit kaydina ve denetim zincirinin sirasina yarisir: iptal nedenleri KARISIK gelir ve eski kod
 * bunu kalici hata sayiyordu (yalnizca "tek basina denetim cakismasi" tekrar deneniyordu). Idempotency
 * (0) `None`: kalem yazilmamisti; bu ConditionalCheckFailed "zaten islenmis" DEGIL, zincir yarisidir.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DataAccessError } from '../src/config/dynamodb.js';
import { contentionBackoffMs, contentionOnly } from '../src/modules/audit/log.js';
import { createMemoryBulkJobQueue } from '../src/modules/bulkjobs/queue.js';
import { createMemoryBulkJobRepository } from '../src/modules/bulkjobs/repository.js';
import { type BulkJobDeps, createBulkJobService } from '../src/modules/bulkjobs/service.js';
import type { BulkJob } from '../src/modules/bulkjobs/types.js';
import { toKurus } from '../src/modules/core/types.js';
import { FinanceError, type BulkDuesLine, type BulkDuesLineResult, type BulkDuesSpec } from '../src/modules/finance/service.js';

const cancel = (codes: string[]) =>
  new TransactionCanceledException({ message: 'iptal', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });

describe('iptal nedeni siniflandirmasi', () => {
  it('logdaki karisik iptal (cekisme + denetim zinciri yarisi) gecicidir', () => {
    const logged = cancel(['None', 'None', 'None', 'None', 'None', 'TransactionConflict', 'None', 'TransactionConflict', 'ConditionalCheckFailed']);
    expect(contentionOnly(logged, 8)).toBe(true);
  });

  it('veri ogesinde ConditionalCheckFailed (idempotency, surum, kilit) is kuralidir: tekrar denenmez', () => {
    expect(contentionOnly(cancel(['ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'TransactionConflict', 'None', 'None', 'None']), 8)).toBe(false);
    expect(contentionOnly(cancel(['None', 'None', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed', 'ConditionalCheckFailed']), 8)).toBe(false);
    expect(contentionOnly(cancel(['None', 'None']), 1)).toBe(false);
    expect(contentionOnly(new Error('x'), 0)).toBe(false);
  });

  it('bekleme ustel artar, jitter`li ve ust sinirli', () => {
    expect(contentionBackoffMs(1, () => 0)).toBe(10);
    expect(contentionBackoffMs(1, () => 0.999)).toBeLessThan(10 + 40);
    expect(contentionBackoffMs(3, () => 0.999)).toBeGreaterThan(contentionBackoffMs(1, () => 0.999));
    expect(contentionBackoffMs(20, () => 0.999)).toBeLessThanOrEqual(1010);
  });
});

// ---------------------------------------------------------------------------
// Worker: gecici hata tekrar denenir; ust uste kalici gecici hata isi `failed` yapar
// ---------------------------------------------------------------------------

const APT = 'apt-1';
const ctx = { apartmentId: APT, userId: 'mgr-1' };
const SILENT = { info: () => undefined, error: () => undefined };
const UNITS = 303;

function world(opts: { failFor?: (unitId: string, call: number) => Error | undefined } = {}) {
  let t = new Date('2026-11-26T11:00:00.000Z');
  const written = new Map<string, BulkDuesLineResult>();
  const calls = new Map<string, number>();
  const lines: BulkDuesLine[] = Array.from({ length: UNITS }, (_, i) => ({ unitId: `u${i + 1}`, unitNumber: String(i + 1), amount: 100_000, party: 'owner', vacant: false }));
  const spec: BulkDuesSpec = {
    idempotencyKey: '44510bfa-dd1a-40bc-9f23-241173713a0b',
    batchId: 'b1',
    liableParty: 'owner',
    totalAmount: UNITS * 100_000,
    distributionKey: 'equal',
    date: '2026-11-01',
    dueDate: '2026-11-10',
    description: 'Kasım aidatı',
    incomeAccountId: 'income-dues',
    scopeFp: {},
  };
  const finance: BulkJobDeps['finance'] = {
    planBulkJob: (async () => ({ spec, lines, exempt: [], vacant: [], unitCount: UNITS })) as never,
    prepareBulkPosting: async () => undefined,
    recordDuesBatchSummary: (async () => ({})) as never,
    postBulkLine: async (_ctx, _spec, line) => {
      const n = (calls.get(line.unitId) ?? 0) + 1;
      calls.set(line.unitId, n);
      const err = opts.failFor?.(line.unitId, n);
      if (err) throw err;
      // Idempotency: ikinci yazim replay.
      const prev = written.get(line.unitId);
      if (prev) return { ...prev, replayed: true };
      const r: BulkDuesLineResult = { unitId: line.unitId, amount: toKurus(line.amount), transactionId: `tx-${line.unitId}`, replayed: false, liableParty: 'owner', vacant: false };
      written.set(line.unitId, r);
      return r;
    },
  };
  const jobs = createMemoryBulkJobRepository();
  const q = createMemoryBulkJobQueue();
  const service = createBulkJobService({
    repository: jobs.repository,
    queue: q.queue,
    finance,
    now: () => t,
    options: { batchSize: 25, concurrency: 4, maxUnitsPerInvocation: 1000, retryBaseMs: 0 },
    log: SILENT,
  });
  const drain = async (limit = 50) => {
    const errors: unknown[] = [];
    for (let i = 0; q.messages.length > 0; i++) {
      if (i > limit) throw new Error('sonsuz dongu');
      const m = q.messages.shift() as (typeof q.messages)[number];
      try {
        await service.handle(m);
      } catch (err) {
        errors.push(err);
        q.messages.push(m); // SQS tekrar teslimi
      }
    }
    return errors;
  };
  return { service, jobs, q, written, calls, drain, advance: (min: number) => (t = new Date(t.getTime() + min * 60_000)) };
}

const contention = () => new DataAccessError('throttled', 'Islem iptal edildi: None,None,None,None,None,TransactionConflict,None,TransactionConflict,ConditionalCheckFailed');

describe('toplu aidat worker - cekisme', () => {
  it('kalem basina gecici cekisme tekrar denenir; is takilmadan 303/303 tamamlanir', async () => {
    // 276-303 arasi her kalem ilk 3 denemede cekismeye takilir (logdaki 12. paket).
    const w = world({ failFor: (unitId, n) => (Number(unitId.slice(1)) > 275 && n <= 3 ? contention() : undefined) });
    const { job } = await w.service.startDues(ctx, {});
    const errors = await w.drain();
    expect(errors).toEqual([]);
    const done = (await w.service.get(ctx, job.jobId)) as BulkJob;
    expect(done).toMatchObject({ status: 'completed', processed: UNITS, succeeded: UNITS, failed: 0, written: UNITS });
    expect(w.written.size).toBe(UNITS);
  });

  it('kalici gecici hata: 3 ust uste basarisiz cagridan sonra is failed (sonsuz running yok); tekrar dene idempotent tamamlar', async () => {
    let broken = true;
    const w = world({ failFor: (unitId) => (broken && Number(unitId.slice(1)) > 275 ? contention() : undefined) });
    const { job } = await w.service.startDues(ctx, {});
    const errors = await w.drain();
    // Ilk cagri 275'e kadar ilerler ve hata verir (seri 1), sonraki iki teslim ilerlemez (2, 3 -> failed).
    expect(errors).toHaveLength(2);
    const failed = (await w.service.get(ctx, job.jobId)) as BulkJob;
    expect(failed).toMatchObject({ status: 'failed', processed: 275, error: { code: 'transient_exhausted' } });
    expect(failed.leaseUntil).toBeUndefined();
    expect(w.q.messages).toHaveLength(0);

    broken = false;
    await w.service.retry(ctx, job.jobId);
    expect(await w.drain()).toEqual([]);
    const done = (await w.service.get(ctx, job.jobId)) as BulkJob;
    expect(done).toMatchObject({ status: 'completed', processed: UNITS, succeeded: UNITS, failed: 0 });
    // Ilk 275 kalem replay (idempotency); `written` sayaci yeniden denemede sifirlanmaz: 275 + 28.
    // Her bolum TEK kez yazildi.
    expect(done.written).toBe(UNITS);
    expect(w.written.size).toBe(UNITS);
  });

  it('is mantigi hatasi (or. kapali cari) bolumu hatali sayar, is durmaz', async () => {
    const w = world({ failFor: (unitId) => (unitId === 'u290' ? new FinanceError('conflict', 'Bu cari kapatildi') : undefined) });
    const { job } = await w.service.startDues(ctx, {});
    expect(await w.drain()).toEqual([]);
    expect(await w.service.get(ctx, job.jobId)).toMatchObject({ status: 'completed_with_errors', processed: UNITS, failed: 1, succeeded: UNITS - 1 });
  });

  it('takili kalmis running is (mesaj DLQ`ya dustu): tekrar dene imlecten devam eder', async () => {
    const w = world();
    const { job } = await w.service.startDues(ctx, {});
    // Eski davranisi taklit et: is 275'te `running`, kira bos, kuyrukta mesaj yok.
    const cur = w.jobs.jobs.get(`${APT}|${job.jobId}`) ?? [...w.jobs.jobs.values()][0];
    expect(cur).toBeDefined();
    w.q.messages.length = 0;
    const stuck: BulkJob = { ...(cur as BulkJob), status: 'running', cursor: 275, processed: 275, succeeded: 275, updatedAt: '2026-11-26T11:00:00.000Z', version: (cur as BulkJob).version + 1 };
    await w.jobs.repository.update(stuck, (cur as BulkJob).version);

    await expect(w.service.retry(ctx, job.jobId)).rejects.toMatchObject({ httpStatus: 409 }); // henuz takili sayilmaz
    w.advance(20);
    const resumed = await w.service.retry(ctx, job.jobId);
    expect(resumed).toMatchObject({ status: 'pending', cursor: 275 });
    expect(await w.drain()).toEqual([]);
    expect(await w.service.get(ctx, job.jobId)).toMatchObject({ status: 'completed', processed: UNITS });
    // Yalnizca kalan 28 bolum yazildi.
    expect(w.written.size).toBe(28);
  });
});
