/**
 * Arka plan toplu islemleri: buyuk toplu aidat tahakkuku ve sayac donemi onayi.
 *
 * Akis:
 *  1. API (`startDues` / `startMeterPosting`) plani dogrular, is kaydini (`pending`) acar, kuyruga
 *     mesaj birakir ve hemen 202 doner. Aidatta paylar ve borclu taraf bu anda dondurulur
 *     (satir kayitlari); sayacta dagitim satirlari zaten donemin `MDLINE` kayitlaridir.
 *  2. Worker (`handle`) isi kiralar (surum kosullu `leaseUntil`), bolumleri `batchSize`'lik alt
 *     parcalarla ve parca icinde sinirli eszamanlilikla yazar; her alt parcadan sonra ilerlemeyi
 *     kaydeder. Lambda suresi azalinca (veya cagri basina ust sinira ulasinca) kirayi birakir ve
 *     isi kuyruga yeniden birakir (continuation).
 *  3. Tum kalemler yazilinca ozet bildirim (deterministik kimlik) ve is `completed`.
 *
 * Garantiler: kalem yazimlari mevcut idempotency anahtarlariyla (`<key>_<unitId>`,
 * `MDP_<periodId>_<unitId>`) yapilir; ayni parca iki kez islense de ikinci kayit olusmaz. Kurus
 * mutabakati planda (aidat: paylar toplami = tutar; sayac: her adimda `assertReconciled`)
 * korunur. Gecici hata (DynamoDB kisitlamasi, ag) mesaji SQS'e geri birakir; is mantigi hatasi
 * (kapali donem, kapatilmis cari...) bolumu "hatali" sayar (aidat) veya isi `failed` yapar (sayac,
 * donem `posting` kalir ve "Tekrar dene" kaldigi yerden devam eder).
 */
import { createHash, randomUUID } from 'node:crypto';
import { DataAccessError } from '../../config/dynamodb.js';
import { type BulkJobFinishedPayload, type DomainEvent, buildEvent } from '../../events/publisher.js';
import { SYSTEM_ACTOR } from '../finance/service.js';
import { contentionBackoffMs } from '../audit/log.js';
import { mapLimit } from '../core/concurrency.js';
import { ValidationError } from '../core/validation.js';
import type { Role } from '../../auth/claims.js';
import type { BulkDuesLine, BulkDuesLineResult, FinanceService } from '../finance/service.js';
import { MeterError } from '../meters/errors.js';
import type { MeterPostingService } from '../meters/posting.js';
import type { MeterReversalService } from '../meters/reversal.js';
import { BulkJobError } from './errors.js';
import type { BulkJobQueue } from './queue.js';
import type { BulkJobRepository } from './repository.js';
import {
  type BulkJob,
  type BulkJobMessage,
  type DuesJobParams,
  JOB_TTL_DAYS,
  LINE_CHUNK,
  MAX_FAILURE_SAMPLES,
  type MeterCalcJobParams,
  type MeterJobParams,
  type MeterReversalJobParams,
  OUTPUT_CHUNK_CHARS,
  isTerminal,
} from './types.js';

/** Onizleme isinin kayit suresi (cikti buyuk, kisa omurlu; onaydan once yeniden hesaplanir). */
const CALC_JOB_TTL_DAYS = 7;

export type BulkJobContext = { apartmentId: string; userId: string; role?: Role };

export type BulkJobOptions = {
  /** Alt parca: bu kadar bolum yazildiktan sonra ilerleme kaydedilir. */
  batchSize: number;
  /** Alt parca icinde ayni anda yazilan bolum (sicak gelir hesabi cakismasi depoda tekrar denenir). */
  concurrency: number;
  /** Tek worker cagrisinda en fazla islenecek bolum (sonra continuation). */
  maxUnitsPerInvocation: number;
  /** Kalan Lambda suresi bunun altina dusunce yeni alt parcaya gecilmez. */
  safetyMs: number;
  /** Kira suresi (Lambda zaman asimi + pay). */
  leaseSeconds: number;
  /** Bolum basina deneme (is mantigi hatasi deterministiktir; gecici hata icin). */
  attemptsPerUnit: number;
  /** Bolum denemeleri arasi bekleme carpani (ms; ustel + jitter). Testte 0. */
  retryBaseMs: number;
  /**
   * Ust uste bu kadar worker cagrisi gecici hatayla biterse is `failed` olur. SQS
   * `maxReceiveCount` (5) altinda tutulur ki mesaj DLQ'ya gitmeden is durumu kesinlessin.
   */
  maxTransientFailures: number;
  /** Kirasi olmayan `running`/`pending` is bu kadar dakikadir ilerlemiyorsa takili sayilir (tekrar dene). */
  staleMinutes: number;
};

export const DEFAULT_BULK_JOB_OPTIONS: BulkJobOptions = {
  batchSize: 25,
  concurrency: 4,
  maxUnitsPerInvocation: 1000,
  safetyMs: 60_000,
  leaseSeconds: 360,
  attemptsPerUnit: 5,
  retryBaseMs: 1,
  maxTransientFailures: 3,
  staleMinutes: 15,
};

export type BulkJobDeps = {
  repository: BulkJobRepository;
  queue: BulkJobQueue;
  finance: Pick<FinanceService, 'planBulkJob' | 'postBulkLine' | 'prepareBulkPosting' | 'recordDuesBatchSummary'> &
    Partial<Pick<FinanceService, 'refreshSummaries'>>;
  meters?: Pick<MeterPostingService, 'prepareApproval' | 'postStep' | 'finalizePosting' | 'getPeriod'> & Partial<Pick<MeterPostingService, 'calculate'>>;
  /** P1-b: buyuk sayac doneminin toplu geri alinmasi. */
  meterReversal?: Pick<MeterReversalService, 'beginReversal' | 'reverseStep' | 'finalizeReversal' | 'getPeriod' | 'parseReverseBody'>;
  now?: () => Date;
  newToken?: () => string;
  options?: Partial<BulkJobOptions>;
  log?: Pick<Console, 'info' | 'error'>;
};

/** Bitisinde baslatana ozet bildirimi giden is turleri (defter yazan isler). */
export const NOTIFY_KINDS: readonly BulkJob['kind'][] = ['dues_bulk', 'meter_posting', 'meter_reversal'];

/** Worker'in kalan suresi (Lambda `context.getRemainingTimeInMillis`). */
export type Budget = { remainingMs(): number };
const UNLIMITED: Budget = { remainingMs: () => Number.POSITIVE_INFINITY };

/** Kira baska worker'a gecti / is disaridan degisti: bu cagri sessizce durur. */
class LeaseLostError extends Error {
  constructor() {
    super('Toplu is kirasi kaybedildi');
    this.name = 'LeaseLostError';
  }
}

/** Is mantigi hatasi (tekrar denemek sonucu degistirmez). Depo/ag hatalari gecicidir. */
export function isBusinessError(err: unknown): boolean {
  if (err instanceof DataAccessError) return false;
  if (err instanceof ValidationError) return true;
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;
const errorDetails = (err: unknown): Record<string, unknown> | undefined =>
  err instanceof MeterError || err instanceof BulkJobError ? err.details : undefined;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** Istemciye: anahtarlar ve kira bilgisi gizlenir. */
export function jobView(job: BulkJob) {
  const { PK: _pk, SK: _sk, leaseToken: _t, leaseUntil: _l, ttl: _ttl, fingerprint: _fp, params, ...rest } = job;
  const percent = job.total > 0 ? Math.min(100, Math.floor((job.processed / job.total) * 100)) : isTerminal(job.status) ? 100 : 0;
  const p =
    job.kind === 'dues_bulk'
      ? (() => {
          const d = params as DuesJobParams;
          return { batchId: d.spec.batchId, description: d.spec.description, date: d.spec.date, dueDate: d.spec.dueDate, totalAmount: d.spec.totalAmount, unitCount: d.unitCount, exemptCount: d.exemptCount, vacantCount: d.vacantCount };
        })()
      : (() => {
          const m = params as MeterJobParams | MeterReversalJobParams;
          return { periodId: m.periodId, ...(m.periodName ? { periodName: m.periodName } : {}) };
        })();
  return { ...rest, params: p, percent };
}
export type BulkJobView = ReturnType<typeof jobView>;

export { BulkJobError };

export function createBulkJobService(deps: BulkJobDeps) {
  const repo = deps.repository;
  const now = deps.now ?? (() => new Date());
  const newToken = deps.newToken ?? randomUUID;
  const opt: BulkJobOptions = { ...DEFAULT_BULK_JOB_OPTIONS, ...deps.options };
  const log = deps.log ?? console;
  const stamp = () => now().toISOString();
  const ttl = () => Math.floor(now().getTime() / 1000) + JOB_TTL_DAYS * 86_400;

  function baseJob(ctx: BulkJobContext, jobId: string, kind: BulkJob['kind'], params: BulkJob['params'], total: number, fingerprint: string): BulkJob {
    const at = stamp();
    return {
      PK: `APT#${ctx.apartmentId}`,
      SK: `BULKJOB#${jobId}`,
      entityType: 'BULK_JOB',
      apartmentId: ctx.apartmentId,
      jobId,
      kind,
      status: 'pending',
      ...(kind !== 'dues_bulk' ? { phase: 'prepare' as const } : {}),
      total,
      processed: 0,
      succeeded: 0,
      failed: 0,
      written: 0,
      failures: [],
      cursor: 0,
      params,
      fingerprint,
      invocations: 0,
      createdAt: at,
      createdBy: ctx.userId,
      ...(ctx.role ? { createdByRole: ctx.role } : {}),
      updatedAt: at,
      version: 1,
      ttl: ttl(),
    };
  }

  /**
   * `BULK_JOB_FINISHED` (bitis ozeti): kimlik is surumunden (yeniden denenen is yeniden bildirir,
   * ayni bitis iki kez yazilamaz). Sistemin baslattigi is (aylik otomatik aidat) icin olay yok.
   */
  function finishedEvent(job: BulkJob): DomainEvent | undefined {
    if (!isTerminal(job.status) || !NOTIFY_KINDS.includes(job.kind) || !job.createdBy || job.createdBy === SYSTEM_ACTOR) return undefined;
    const p = jobView(job).params as { periodId?: string; periodName?: string; description?: string };
    const label = (p.periodName ?? p.description)?.slice(0, 120);
    return buildEvent(
      {
        eventId: `BULK_JOB_FINISHED:${job.jobId}:${job.version}`,
        type: 'BULK_JOB_FINISHED',
        apartmentId: job.apartmentId,
        actorId: SYSTEM_ACTOR,
        payload: {
          jobId: job.jobId,
          kind: job.kind,
          status: job.status as BulkJobFinishedPayload['status'],
          startedBy: job.createdBy,
          total: job.total,
          succeeded: job.succeeded,
          failed: job.failed,
          written: job.written,
          ...(p.periodId ? { periodId: p.periodId } : {}),
          ...(label ? { label } : {}),
          ...(job.status === 'failed' && job.error?.message ? { errorMessage: job.error.message.slice(0, 200) } : {}),
        },
      },
      now,
    );
  }

  async function enqueue(job: BulkJob, seq = 0) {
    await deps.queue.send({ type: 'bulk_job', apartmentId: job.apartmentId, jobId: job.jobId, seq });
  }

  /**
   * Var olan is: ayni icerikse aynen doner (istemci tekrar denemesi); basarisiz / hatali bitmisse
   * yeniden kuyruga alinir. Farkli icerikle ayni anahtar 409.
   */
  async function reuse(existing: BulkJob, fingerprint: string, conflictMessage: string) {
    if (existing.fingerprint !== fingerprint) throw new BulkJobError('conflict', conflictMessage);
    if (existing.status === 'failed' || existing.status === 'completed_with_errors') return { job: await restart(existing), created: false };
    if (existing.status === 'pending') await enqueue(existing); // ilk mesaj kaybolduysa
    return { job: existing, created: false };
  }

  // -------------------------------------------------------------------------
  // Baslatma (API)
  // -------------------------------------------------------------------------

  /** Toplu aidat tahakkuku isi. Govde `POST /api/finance/dues` toplu govdesiyle aynidir. */
  async function startDues(ctx: BulkJobContext, body: unknown) {
    const plan = await deps.finance.planBulkJob(ctx, body);
    // Is kimligi istemci anahtarindan turetilir (ayni anahtar = ayni is); URL kimligi 64 karakteri asmaz.
    const key = plan.spec.idempotencyKey;
    const jobId = key.length <= 58 ? `dues-${key}` : `dues-${fingerprintOf(key)}`;
    const fingerprint = fingerprintOf({ spec: plan.spec, lines: plan.lines.map((l) => [l.unitId, l.amount, l.party, l.vacant]) });
    const existing = await repo.get(ctx.apartmentId, jobId);
    if (existing) return reuse(existing, fingerprint, 'Bu islem anahtariyla farkli içerikli bir toplu tahakkuk zaten baslatilmis');

    const chunks: BulkDuesLine[][] = [];
    for (let i = 0; i < plan.lines.length; i += LINE_CHUNK) chunks.push(plan.lines.slice(i, i + LINE_CHUNK));
    const params: DuesJobParams = { spec: plan.spec, lineChunks: chunks.length, unitCount: plan.unitCount, exemptCount: plan.exempt.length, vacantCount: plan.vacant.length };
    const job = baseJob(ctx, jobId, 'dues_bulk', params, plan.lines.length, fingerprint);
    try {
      await repo.create(job, chunks);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        const raced = await repo.get(ctx.apartmentId, jobId);
        if (raced) return reuse(raced, fingerprint, 'Bu islem anahtariyla farkli içerikli bir toplu tahakkuk zaten baslatilmis');
      }
      throw err;
    }
    await enqueue(job);
    return { job, created: true };
  }

  /**
   * Sayac donemi onayi isi. Hizli on kontrol (hesap ozeti guncel mi) burada; tam hesap ve
   * `calcHash` dogrulamasi worker'da (`prepareApproval`) yapilir.
   */
  async function startMeterPosting(ctx: BulkJobContext & { role: Role }, periodId: string, calcHash: string) {
    if (!deps.meters) throw new BulkJobError('unprocessable', 'Sayac dagitimi bu ortamda acik degil');
    const period = await deps.meters.getPeriod(ctx, periodId);
    if (period.status === 'draft') throw new MeterError('conflict', 'Önizlemeden sonra okumalar, şablon veya tutar değişti; yeniden önizleyin');
    if (period.status !== 'calculated' && period.status !== 'posting' && period.status !== 'posted') {
      throw new MeterError('unprocessable', 'Bu dönem onaylanamaz (iptal edilmiş veya geri alınmış)');
    }
    if (period.calc?.hash !== calcHash) {
      throw new MeterError('conflict', 'Önizlemeden sonra okumalar, şablon veya tutar değişti; yeniden önizleyin', period.calc?.hash ? { calcHash: period.calc.hash } : undefined);
    }
    const jobId = `mp-${fingerprintOf({ periodId, calcHash })}`;
    const fingerprint = fingerprintOf({ periodId, calcHash });
    const existing = await repo.get(ctx.apartmentId, jobId);
    if (existing) return reuse(existing, fingerprint, 'Bu dönem için farklı bir onay işi var');
    const params: MeterJobParams = { periodId, calcHash, periodName: period.name };
    const job = baseJob(ctx, jobId, 'meter_posting', params, period.calc?.chargeCount ?? 0, fingerprint);
    try {
      await repo.create(job, []);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        const raced = await repo.get(ctx.apartmentId, jobId);
        if (raced) return reuse(raced, fingerprint, 'Bu dönem için farklı bir onay işi var');
      }
      throw err;
    }
    await enqueue(job);
    return { job, created: true };
  }

  async function get(ctx: BulkJobContext, jobId: string) {
    const job = await repo.get(ctx.apartmentId, jobId);
    if (!job) throw new BulkJobError('not_found', 'Toplu iş bulunamadı');
    return job;
  }

  /** Basarisiz / hatali biten isi bastan (idempotent: yazilmis kalemler yeniden yazilmaz) baslatir. */
  async function restart(job: BulkJob): Promise<BulkJob> {
    const next: BulkJob = {
      ...job,
      status: 'pending',
      processed: 0,
      succeeded: 0,
      failed: 0,
      failures: [],
      cursor: 0,
      ...(job.kind !== 'dues_bulk' ? { phase: 'prepare' as const } : {}),
      updatedAt: stamp(),
      version: job.version + 1,
    };
    delete next.error;
    delete next.finishedAt;
    delete next.leaseUntil;
    delete next.leaseToken;
    delete next.transientFailures;
    await repo.update(next, job.version);
    await enqueue(next);
    return next;
  }

  /** Kirasi bos (veya suresi dolmus) ve uzun suredir ilerlemeyen calisan/bekleyen is. */
  function isStale(job: BulkJob): boolean {
    if (job.status !== 'running' && job.status !== 'pending') return false;
    const t = now().getTime();
    if (job.leaseUntil && Date.parse(job.leaseUntil) > t) return false;
    return t - Date.parse(job.updatedAt) >= opt.staleMinutes * 60_000;
  }

  async function retry(ctx: BulkJobContext, jobId: string) {
    const job = await get(ctx, jobId);
    if (isStale(job)) {
      // Takili is (ornegin gecici hata mesaji DLQ'ya dustu): imlec korunur, kaldigi yerden devam.
      const next: BulkJob = { ...job, status: 'pending', transientFailures: 0, updatedAt: stamp(), version: job.version + 1 };
      delete next.leaseUntil;
      delete next.leaseToken;
      delete next.error;
      await repo.update(next, job.version);
      await enqueue(next);
      log.info(JSON.stringify({ msg: 'bulk_job_resumed', jobId: job.jobId, apartmentId: job.apartmentId, cursor: job.cursor, total: job.total }));
      return next;
    }
    if (job.status !== 'failed' && job.status !== 'completed_with_errors') {
      throw new BulkJobError('conflict', 'Yalnızca başarısız, hatalı biten veya takılı kalan iş yeniden denenebilir');
    }
    return restart(job);
  }

  // -------------------------------------------------------------------------
  // Isleme (worker)
  // -------------------------------------------------------------------------

  /**
   * Tek worker cagrisi. Gecici hatada hata firlatir (SQS tekrar teslim eder, ilerleme kayitli).
   * Is bitmediyse kirayi birakip devam mesaji gonderir.
   */
  async function handle(message: BulkJobMessage, budget: Budget = UNLIMITED): Promise<{ outcome: 'skipped' | 'continued' | 'done'; job?: BulkJob }> {
    const current = await repo.get(message.apartmentId, message.jobId);
    if (!current || isTerminal(current.status)) return { outcome: 'skipped', ...(current ? { job: current } : {}) };
    if (current.leaseUntil && Date.parse(current.leaseUntil) > now().getTime()) {
      // Baska worker calisiyor; devam mesajini o gonderecek.
      return { outcome: 'skipped', job: current };
    }
    const token = newToken();
    let job: BulkJob = {
      ...current,
      status: 'running',
      leaseToken: token,
      leaseUntil: new Date(now().getTime() + opt.leaseSeconds * 1000).toISOString(),
      invocations: current.invocations + 1,
      startedAt: current.startedAt ?? stamp(),
      updatedAt: stamp(),
      version: current.version + 1,
    };
    try {
      await repo.update(job, current.version);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') return { outcome: 'skipped', job: current };
      throw err;
    }

    const save = async (patch: Partial<BulkJob>) => {
      const next: BulkJob = { ...job, ...patch, updatedAt: stamp(), version: job.version + 1 };
      try {
        await repo.update(next, job.version);
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') throw new LeaseLostError();
        throw err;
      }
      job = next;
    };
    const finish = async (patch: Partial<BulkJob>) => {
      const next: BulkJob = { ...job, ...patch, finishedAt: stamp(), updatedAt: stamp(), version: job.version + 1 };
      delete next.leaseUntil;
      delete next.leaseToken;
      // Bildirim devami: bitis ozeti baslatana (is kaydiyla ayni atomik yazimda; sistem baslattiysa yok).
      const summary = finishedEvent(next);
      try {
        if (summary) await repo.update(next, job.version, { outbox: [summary] });
        else await repo.update(next, job.version);
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') throw new LeaseLostError();
        throw err;
      }
      job = next;
    };
    let handled = 0;
    const shouldStop = () => handled >= opt.maxUnitsPerInvocation || budget.remainingMs() < opt.safetyMs;

    try {
      const run = job.kind === 'dues_bulk' ? runDues : job.kind === 'meter_reversal' ? runMeterReversal : job.kind === 'meter_calculation' ? runMeterCalculation : runMeter;
      const done = await run(() => job, save, finish, shouldStop, (n) => (handled += n));
      if (done) {
        log.info(JSON.stringify({ msg: 'bulk_job_done', jobId: job.jobId, apartmentId: job.apartmentId, kind: job.kind, status: job.status, total: job.total, failed: job.failed, invocations: job.invocations }));
        // P1-a: toplu tahakkuk tum alt carilerin surumunu artirdi; ozetleri worker'da tazele ki
        // ilk Genel Bakis / dues-status istegi yuzlerce hesabi yeniden okumasin. En iyi caba:
        // hata veya sure azligi sonucu degistirmez (istek yolu bayat ozeti kendisi uretir).
        if (job.kind !== 'meter_calculation' && deps.finance.refreshSummaries && budget.remainingMs() > opt.safetyMs + 30_000) {
          try {
            const stats = await deps.finance.refreshSummaries(job.apartmentId);
            log.info(JSON.stringify({ msg: 'finance_summary_refreshed', jobId: job.jobId, apartmentId: job.apartmentId, ...stats }));
          } catch (err) {
            log.info(JSON.stringify({ msg: 'finance_summary_refresh_failed', jobId: job.jobId, apartmentId: job.apartmentId, error: messageOf(err) }));
          }
        }
        return { outcome: 'done', job };
      }
      // Kirayi birak, sonra devam mesaji (gonderim basarisizsa SQS ayni mesaji tekrar teslim eder).
      const released: BulkJob = { ...job, transientFailures: 0, updatedAt: stamp(), version: job.version + 1 };
      delete released.leaseUntil;
      delete released.leaseToken;
      await repo.update(released, job.version);
      job = released;
      await enqueue(job, message.seq + 1);
      log.info(JSON.stringify({ msg: 'bulk_job_continued', jobId: job.jobId, apartmentId: job.apartmentId, processed: job.processed, total: job.total, seq: message.seq + 1 }));
      return { outcome: 'continued', job };
    } catch (err) {
      if (err instanceof LeaseLostError) return { outcome: 'skipped', job };
      if (isBusinessError(err)) {
        const details = errorDetails(err);
        await finish({ status: 'failed', error: { code: String(errorCode(err) ?? 'unprocessable'), message: messageOf(err), ...(details ? { details } : {}) } });
        log.error(JSON.stringify({ msg: 'bulk_job_failed', jobId: job.jobId, apartmentId: job.apartmentId, kind: job.kind, error: messageOf(err) }));
        return { outcome: 'done', job };
      }
      // Gecici hata. Bu cagride ilerleme olduysa sayac 1'den, olmadiysa bir artarak devam eder.
      const streak = handled > 0 ? 1 : (current.transientFailures ?? 0) + 1;
      if (streak >= opt.maxTransientFailures) {
        // Sonsuz `running` yerine kesin durum: is `failed`, "Tekrar dene" idempotent olarak
        // (yazilmis kalemler replay) kaldigi yerden tamamlar. Mesaj basariyla tuketilir (DLQ yok).
        try {
          await finish({
            status: 'failed',
            transientFailures: streak,
            error: { code: 'transient_exhausted', message: `Gecici hata ${streak} kez ust uste tekrarlandi: ${messageOf(err)}` },
          });
        } catch (finishErr) {
          if (finishErr instanceof LeaseLostError) return { outcome: 'skipped', job };
          throw err;
        }
        log.error(JSON.stringify({ msg: 'bulk_job_failed', jobId: job.jobId, apartmentId: job.apartmentId, kind: job.kind, reason: 'transient_exhausted', processed: job.processed, total: job.total, error: messageOf(err) }));
        return { outcome: 'done', job };
      }
      // Kirayi birakmayi dene (hemen tekrar teslimde beklemesin), sonra SQS'e birak.
      try {
        const released: BulkJob = { ...job, transientFailures: streak, updatedAt: stamp(), version: job.version + 1 };
        delete released.leaseUntil;
        delete released.leaseToken;
        await repo.update(released, job.version);
      } catch {
        // Kira suresi dolunca zaten serbest kalir.
      }
      log.error(JSON.stringify({ msg: 'bulk_job_transient_error', jobId: job.jobId, apartmentId: job.apartmentId, processed: job.processed, total: job.total, streak, error: messageOf(err) }));
      throw err;
    }
  }

  type Get = () => BulkJob;
  type Save = (patch: Partial<BulkJob>) => Promise<void>;

  /** Aidat: dondurulmus satirlar imlecten itibaren alt parcalarla. Bittiyse true. */
  async function runDues(job: Get, save: Save, finish: Save, shouldStop: () => boolean, count: (n: number) => void): Promise<boolean> {
    const j = job();
    const params = j.params as DuesJobParams;
    const ctx: BulkJobContext = { apartmentId: j.apartmentId, userId: j.createdBy };
    if (j.cursor < j.total) await deps.finance.prepareBulkPosting(ctx);
    let cache: { index: number; lines: BulkDuesLine[] } | undefined;

    while (job().cursor < job().total) {
      if (shouldStop()) return false;
      const cursor = job().cursor;
      const index = Math.floor(cursor / LINE_CHUNK);
      if (cache?.index !== index) cache = { index, lines: await deps.repository.getLines(j.apartmentId, j.jobId, index) };
      const offset = cursor - index * LINE_CHUNK;
      const batch = cache.lines.slice(offset, offset + opt.batchSize);
      if (batch.length === 0) throw new DataAccessError('internal', 'Toplu is satirlari eksik');

      const outcomes = await mapLimit(batch, opt.concurrency, async (line): Promise<{ ok: BulkDuesLineResult } | { error: string }> => {
        for (let attempt = 1; ; attempt++) {
          try {
            return { ok: await deps.finance.postBulkLine(ctx, params.spec, line) };
          } catch (err) {
            // Is mantigi hatasi deterministiktir: bolum hatali sayilir, is devam eder. (Ayni kalem
            // zaten yazilmissa idempotency kaydi `replayed` dondurur; hata degildir.)
            if (isBusinessError(err)) return { error: messageOf(err) };
            if (attempt < opt.attemptsPerUnit) {
              // Gecici (cekisme / kisitlama): eszamanli kalemler ayni anda tekrar carpismasin.
              if (opt.retryBaseMs > 0) await new Promise((r) => setTimeout(r, opt.retryBaseMs * contentionBackoffMs(attempt)));
              continue;
            }
            throw err; // gecici: mesaj SQS'e doner, ilerleme son kayittan devam eder
          }
        }
      });
      const ok = outcomes.flatMap((o) => ('ok' in o ? [o.ok] : []));
      const failures = outcomes.flatMap((o, i) => ('error' in o ? [{ unitId: batch[i]?.unitId as string, unitNumber: batch[i]?.unitNumber, message: o.error }] : []));
      if (ok.length) await deps.repository.putResults(j.apartmentId, j.jobId, cursor, ok, j.ttl);
      count(batch.length);
      const cur = job();
      await save({
        cursor: cursor + batch.length,
        processed: cursor + batch.length,
        succeeded: cur.succeeded + ok.length,
        failed: cur.failed + failures.length,
        written: cur.written + ok.filter((r) => !r.replayed).length,
        failures: [...cur.failures, ...failures].slice(0, MAX_FAILURE_SAMPLES),
      });
    }

    // Tum kalemler denendi: ozet bildirim (deterministik kimlik; tekrar calisirsa ikinci olay yok).
    const results = await deps.repository.listResults(j.apartmentId, j.jobId);
    const spec = params.spec;
    await deps.finance.recordDuesBatchSummary(ctx, { batchId: spec.batchId, date: spec.date, dueDate: spec.dueDate, description: spec.description, liableParty: spec.liableParty, results });
    const cur = job();
    await finish({
      status: cur.failed > 0 ? 'completed_with_errors' : 'completed',
      result: {
        batchId: spec.batchId,
        count: results.length,
        distributedAmount: results.reduce((s, r) => s + r.amount, 0),
        exemptCount: params.exemptCount,
        vacantCount: results.filter((r) => r.vacant).length,
        written: cur.written,
        replayed: results.length > 0 && cur.written === 0,
      },
    });
    return true;
  }

  /** Sayac: hazirlik -> parcali kalem yazimi -> sonlandirma. Bittiyse true. */
  async function runMeter(job: Get, save: Save, finish: Save, shouldStop: () => boolean, count: (n: number) => void): Promise<boolean> {
    const meters = deps.meters;
    if (!meters) throw new BulkJobError('unprocessable', 'Sayac dagitimi bu ortamda acik degil');
    const j = job();
    const params = j.params as MeterJobParams;
    const ctx = { apartmentId: j.apartmentId, userId: j.createdBy, role: j.createdByRole ?? ('apartment_manager' as Role) };

    if (!j.phase || j.phase === 'prepare') {
      const prepared = await meters.prepareApproval(ctx, params.periodId, params.calcHash);
      if (prepared.kind === 'posted') {
        const posted = prepared.period.chargeCount ?? 0;
        await finish({ status: 'completed', phase: 'finalize', total: posted, processed: posted, succeeded: posted, result: { posted, written: 0, replayed: true } });
        return true;
      }
      const total = prepared.period.calc?.chargeCount ?? 0;
      await save({ phase: 'post', total });
    }

    if (job().phase === 'post') {
      for (;;) {
        if (shouldStop()) return false;
        const period = await meters.getPeriod(ctx, params.periodId);
        if (period.status === 'posted') break;
        const step = await meters.postStep(ctx, period, {
          maxUnits: opt.batchSize * 4,
          batchSize: opt.batchSize,
          concurrency: opt.concurrency,
          shouldStop,
        });
        count(step.processed);
        const cur = job();
        await save({ total: step.total, processed: step.posted, succeeded: step.posted, cursor: step.posted, written: cur.written + step.written });
        if (step.pending === 0) break;
        if (step.processed === 0) return false; // sure doldu
      }
      await save({ phase: 'finalize' });
    }

    const period = await meters.getPeriod(ctx, params.periodId);
    const done = await meters.finalizePosting(ctx, period, { written: job().written });
    await finish({ status: 'completed', processed: done.chargeCount, succeeded: done.chargeCount, total: done.chargeCount, result: { posted: done.chargeCount, written: job().written, replayed: false } });
    return true;
  }

  // -------------------------------------------------------------------------
  // P1-b: sayac doneminin toplu geri alinmasi
  // -------------------------------------------------------------------------

  /**
   * Is kimligi donem + geri alma anahtarindan (ayni anahtar = ayni is). P1-c: donem kimligi onekte
   * (`mr-<donem>-<ozet>`): worker baslamadan (donem henuz `posted`) sayfa yenilense de is donemden
   * bulunur. P1-b ile acilmis eski bicim (`mr-<ozet>`) de okunur.
   */
  const meterReversalJobId = (periodId: string, key: string) => `mr-${periodId}-${fingerprintOf({ periodId, key }).slice(0, 16)}`;
  const legacyReversalJobId = (periodId: string, key: string) => `mr-${fingerprintOf({ periodId, key })}`;

  /**
   * Buyuk donemin geri alinmasi (202). Engel kontrolu ve `reversing` gecisi worker'in ilk adiminda
   * (`beginReversal`) yapilir; engel varsa is `failed` olur ve engeller `error.details.blockers`'ta.
   */
  async function startMeterReversal(ctx: BulkJobContext & { role: Role }, periodId: string, body: unknown) {
    const reversal = deps.meterReversal;
    if (!reversal) throw new BulkJobError('unprocessable', 'Sayac geri alma bu ortamda acik degil');
    const p = reversal.parseReverseBody(body);
    const period = await reversal.getPeriod(ctx, periodId);
    if (period.status === 'reversing' || period.status === 'reversed') {
      if (period.reversal?.key !== p.key) throw new MeterError('conflict', 'Bu dönem başka bir geri alma anahtarıyla geri alınıyor / alınmış');
    } else if (period.status !== 'posted') {
      throw new MeterError('unprocessable', 'Yalnızca onaylı dönem geri alınabilir');
    } else if (p.reason === undefined) {
      throw new ValidationError('reason zorunludur', 'reason');
    }
    const legacy = await repo.get(ctx.apartmentId, legacyReversalJobId(periodId, p.key));
    const jobId = legacy ? legacy.jobId : meterReversalJobId(periodId, p.key);
    const params: MeterReversalJobParams = { periodId, key: p.key, ...(p.reason !== undefined ? { reason: p.reason } : {}), notify: p.notify, periodName: period.name };
    const fingerprint = fingerprintOf({ periodId, key: p.key });
    const existing = await repo.get(ctx.apartmentId, jobId);
    if (existing) return reuse(existing, fingerprint, 'Bu geri alma anahtarıyla farklı bir iş var');
    const job = baseJob(ctx, jobId, 'meter_reversal', params, period.chargeCount ?? 0, fingerprint);
    try {
      await repo.create(job, []);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        const raced = await repo.get(ctx.apartmentId, jobId);
        if (raced) return reuse(raced, fingerprint, 'Bu geri alma anahtarıyla farklı bir iş var');
      }
      throw err;
    }
    await enqueue(job);
    return { job, created: true };
  }

  async function runMeterReversal(job: Get, save: Save, finish: Save, shouldStop: () => boolean, count: (n: number) => void): Promise<boolean> {
    const reversal = deps.meterReversal;
    if (!reversal) throw new BulkJobError('unprocessable', 'Sayac geri alma bu ortamda acik degil');
    const j = job();
    const params = j.params as MeterReversalJobParams;
    const ctx = { apartmentId: j.apartmentId, userId: j.createdBy, role: j.createdByRole ?? ('apartment_manager' as Role) };
    const body = { idempotencyKey: params.key, ...(params.reason !== undefined ? { reason: params.reason } : {}), notify: params.notify };

    if (!j.phase || j.phase === 'prepare') {
      const begun = await reversal.beginReversal(ctx, params.periodId, body);
      if (begun.kind === 'reversed') {
        const n = begun.period.reversal?.reversedCount ?? 0;
        await finish({ status: 'completed', phase: 'finalize', total: n, processed: n, succeeded: n, result: { reversed: n, written: 0, replayed: true } });
        return true;
      }
      await save({ phase: 'post', total: begun.period.chargeCount ?? j.total });
    }

    if (job().phase === 'post') {
      for (;;) {
        if (shouldStop()) return false;
        const period = await reversal.getPeriod(ctx, params.periodId);
        if (period.status === 'reversed') break;
        const step = await reversal.reverseStep(ctx, period, { maxUnits: opt.batchSize * 4, batchSize: opt.batchSize, concurrency: opt.concurrency, shouldStop });
        count(step.processed);
        const cur = job();
        await save({ total: step.total, processed: step.reversed, succeeded: step.reversed, cursor: step.reversed, written: cur.written + step.written });
        if (step.pending === 0) break;
        if (step.processed === 0) return false; // sure doldu
      }
      await save({ phase: 'finalize' });
    }

    const period = await reversal.getPeriod(ctx, params.periodId);
    const done = await reversal.finalizeReversal(ctx, period, { written: job().written });
    await finish({ status: 'completed', processed: done.reversed, succeeded: done.reversed, total: done.reversed, result: { reversed: done.reversed, written: job().written, replayed: false } });
    return true;
  }

  // -------------------------------------------------------------------------
  // Performans: buyuk donemin dagitim onizlemesi (`/calculate`, 1.000+ bolum)
  // -------------------------------------------------------------------------

  const calcJobPrefix = (periodId: string) => `mc-${periodId}-`;

  /**
   * Onizleme isi (202). Donemin suren onizleme isi varsa o doner (cift tiklama / yenileme); yoksa her
   * baslatma yeni is acar: senkron yol gibi her istekte yeniden hesaplanir (uyelik / kapama gibi
   * donem disi girdiler de degismis olabilir). Hesabin kendisi worker'da `posting.calculate`.
   */
  async function startMeterCalculation(ctx: BulkJobContext & { role: Role }, periodId: string, unitCount: number) {
    if (!deps.meters?.calculate) throw new BulkJobError('unprocessable', 'Sayac onizleme isi bu ortamda acik degil');
    const period = await deps.meters.getPeriod(ctx, periodId);
    if (period.status !== 'draft' && period.status !== 'calculated') {
      throw new MeterError('unprocessable', 'Yalnızca taslak dönem hesaplanabilir; onaylı dönemin satırları için /lines kullanın');
    }
    if (repo.listByPrefix) {
      const running = (await repo.listByPrefix(ctx.apartmentId, calcJobPrefix(periodId))).filter((j) => !isTerminal(j.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (running && !isStale(running)) return { job: running, created: false };
    }
    // Zaman sirali + rastgele ek: her baslatma ayri is (kisa omurlu kayit).
    const jobId = `${calcJobPrefix(periodId)}${now().getTime().toString(36)}${newToken().replace(/[^A-Za-z0-9]/g, '').slice(0, 4)}`;
    const params: MeterCalcJobParams = { periodId, periodVersion: period.version, unitCount, ...(period.name ? { periodName: period.name } : {}) };
    const job: BulkJob = { ...baseJob(ctx, jobId, 'meter_calculation', params, unitCount, fingerprintOf({ periodId, jobId })), ttl: Math.floor(now().getTime() / 1000) + CALC_JOB_TTL_DAYS * 86_400 };
    delete job.phase;
    await repo.create(job, []);
    await enqueue(job);
    return { job, created: true };
  }

  async function runMeterCalculation(job: Get, _save: Save, finish: Save, _shouldStop: () => boolean, count: (n: number) => void): Promise<boolean> {
    const calculate = deps.meters?.calculate;
    if (!calculate || !repo.putOutput) throw new BulkJobError('unprocessable', 'Sayac onizleme isi bu ortamda acik degil');
    const j = job();
    const params = j.params as MeterCalcJobParams;
    const ctx = { apartmentId: j.apartmentId, userId: j.createdBy, role: j.createdByRole ?? ('apartment_manager' as Role) };
    // Senkron yolla ayni fonksiyon: ayni girdiyle ayni cetvel ve calcHash.
    const out = await calculate(ctx, params.periodId);
    const { period: _p, ...rest } = out;
    const json = JSON.stringify(rest);
    const chunks: string[] = [];
    for (let i = 0; i < json.length; i += OUTPUT_CHUNK_CHARS) chunks.push(json.slice(i, i + OUTPUT_CHUNK_CHARS));
    await repo.putOutput(j.apartmentId, j.jobId, chunks, j.ttl);
    const units = out.ok ? out.lines.length : params.unitCount;
    count(units);
    await finish({
      status: 'completed',
      total: units,
      processed: units,
      succeeded: units,
      result: {
        ok: out.ok,
        unitCount: units,
        outputChunks: chunks.length,
        ...(out.ok ? { calcHash: out.calcHash, chargeCount: out.totals.chargeCount } : { blockerCount: out.blockers.length }),
      },
    });
    return true;
  }

  /**
   * Biten onizleme isinin ciktisi (senkron `/calculate` yanitiyla ayni govde; donem guncel kayittan).
   * Hesap yapildiysa donem hala o hesapta olmali (`calculated` + ayni `calcHash`); degilse 409.
   */
  async function meterCalculationOutput(ctx: BulkJobContext & { role: Role }, periodId: string, jobId: string) {
    if (!deps.meters || !repo.getOutput) throw new BulkJobError('unprocessable', 'Sayac onizleme isi bu ortamda acik degil');
    const job = await get(ctx, jobId);
    const params = job.params as MeterCalcJobParams;
    if (job.kind !== 'meter_calculation' || params.periodId !== periodId) throw new BulkJobError('not_found', 'Önizleme işi bulunamadı');
    if (job.status !== 'completed' || !job.result?.outputChunks) throw new BulkJobError('conflict', 'Önizleme henüz hazır değil');
    const [period, parts] = await Promise.all([deps.meters.getPeriod(ctx, periodId), repo.getOutput(ctx.apartmentId, jobId, job.result.outputChunks)]);
    const output = JSON.parse(parts.join('')) as Record<string, unknown>;
    if (job.result.ok && (period.status !== 'calculated' || period.calc?.hash !== job.result.calcHash)) {
      throw new MeterError('conflict', 'Önizlemeden sonra okumalar, şablon veya tutar değişti; yeniden önizleyin', period.calc?.hash ? { calcHash: period.calc.hash } : undefined);
    }
    return { output, period };
  }

  /**
   * P1-b: sayac doneminin suren (veya son) arka plan isi. Sayfa yenilendiginde istemci donemin
   * durumundan isi bulur ve ilerlemeyi kaldigi yerden izler. Is kimligi deterministik oldugu icin
   * ek kayit gerekmez: onay `mp-<donem+calcHash>`, geri alma `mr-<donem+anahtar>`.
   */
  async function findMeterJob(
    ctx: BulkJobContext,
    period: { periodId: string; status: string; calc?: { hash: string }; reversal?: { key: string } },
  ): Promise<BulkJob | undefined> {
    const ids: string[] = [];
    // `calculated`: is kuyrukta, worker henuz `prepare` adimini calistirmadi.
    if ((period.status === 'calculated' || period.status === 'posting' || period.status === 'posted') && period.calc?.hash) ids.push(`mp-${fingerprintOf({ periodId: period.periodId, calcHash: period.calc.hash })}`);
    if ((period.status === 'reversing' || period.status === 'reversed') && period.reversal?.key) {
      ids.unshift(meterReversalJobId(period.periodId, period.reversal.key), legacyReversalJobId(period.periodId, period.reversal.key));
    }
    // P1-c: `posted` donemde baslatilmis ama worker'in henuz almadigi geri alma isi (anahtar donemde yok).
    if (period.status === 'posted' && repo.listByPrefix) {
      const pending = (await repo.listByPrefix(ctx.apartmentId, `mr-${period.periodId}-`)).filter((j) => !isTerminal(j.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (pending) return pending;
    }
    for (const id of ids) {
      const job = await repo.get(ctx.apartmentId, id);
      if (job) return job;
    }
    // Performans: taslak / hesaplanmis donemin onizleme isi. Suren is ya da (sayfa yenilendiyse
    // onizleme geri yuklensin diye) donemin guncel hesabini ureten son tamamlanmis is.
    if ((period.status === 'draft' || period.status === 'calculated') && repo.listByPrefix) {
      const calcs = (await repo.listByPrefix(ctx.apartmentId, calcJobPrefix(period.periodId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = calcs[0];
      const restores = period.status === 'calculated' && latest?.status === 'completed' && latest.result?.ok && latest.result.calcHash === period.calc?.hash;
      if (latest && (!isTerminal(latest.status) || restores)) return latest;
    }
    return undefined;
  }

  return { startDues, startMeterPosting, startMeterReversal, startMeterCalculation, meterCalculationOutput, findMeterJob, get, retry, handle };
}

export type BulkJobService = ReturnType<typeof createBulkJobService>;

