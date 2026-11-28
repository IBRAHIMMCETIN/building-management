import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { createMemoryBulkJobQueue } from '../src/modules/bulkjobs/queue.js';
import { createMemoryBulkJobRepository } from '../src/modules/bulkjobs/repository.js';
import { type BulkJobDeps, type BulkJobService, createBulkJobService } from '../src/modules/bulkjobs/service.js';
import type { BulkJob } from '../src/modules/bulkjobs/types.js';
import { BATCH_SUMMARY_CHUNK, BulkTooLargeError, SYNC_BULK_UNITS } from '../src/modules/finance/service.js';
import { meterPostingWorld } from './fakes/meterPostingWorld.js';
import { APT, manager, ownershipWorld } from './fakes/ownershipWorld.js';

/**
 * Yuksek hacim: 1.200 bagimsiz bolumlu site. Toplu aidat tahakkuku ve sayac donemi onayi arka
 * plan isinde parca parca (continuation) yazilir; her worker cagrisi en fazla 100 bolum isler
 * (gercekte Lambda suresi), bu yuzden is 12+ cagriya bolunur. Dogrulananlar:
 *   - her bolum TAM BIR kez borclandi (cift kayit yok), toplam = tutar (kurus mutabakati), mizan 0
 *   - yinelenen / es zamanli mesaj ve worker kesintisi sonrasi tekrar teslim cift kayit uretmez
 *   - ozet bildirim deterministik ve tek
 */

const UNITS = 1200;
const SILENT = { info: () => undefined, error: () => undefined };
const OPTIONS: BulkJobDeps['options'] = { batchSize: 25, concurrency: 4, maxUnitsPerInvocation: 100, attemptsPerUnit: 1 };

function bigSite() {
  const ow = ownershipWorld('2026-12-01');
  for (let i = 2; i <= UNITS; i++) ow.addUnit(`u${String(i).padStart(4, '0')}`, String(i));
  return ow;
}

/** Kuyruktaki mesajlari bitene kadar isler (her mesaj = bir worker cagrisi). */
async function drain(service: BulkJobService, messages: { type: 'bulk_job'; apartmentId: string; jobId: string; seq: number }[], limit = 200) {
  let invocations = 0;
  while (messages.length > 0) {
    if (++invocations > limit) throw new Error('Toplu is bitmedi (sonsuz dongu?)');
    const m = messages.shift() as (typeof messages)[number];
    await service.handle(m);
  }
  return invocations;
}

const duesBody = (key: string) => ({
  idempotencyKey: key,
  liableParty: 'owner',
  totalAmount: UNITS * 150_001, // bolum basi 1.500,01 TL
  distributionKey: 'equal',
  date: '2026-12-01',
  dueDate: '2026-12-15',
  description: 'Aralık 2026 aidatı',
});

describe('1.200 bolum: toplu aidat tahakkuku arka plan isi', () => {
  it('senkron yol buyuk kapsami reddeder; is parca parca tamamlanir, her bolum tek kez borclanir', async () => {
    const ow = bigSite();
    const ctx = { apartmentId: APT, userId: manager.userId };
    await expect(ow.finance.chargeBulk(ctx, duesBody('dues-scale-sync'))).rejects.toBeInstanceOf(BulkTooLargeError);
    expect(SYNC_BULK_UNITS).toBeLessThan(UNITS);

    const jobs = createMemoryBulkJobRepository();
    const q = createMemoryBulkJobQueue();
    const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: ow.finance, now: ow.now, options: OPTIONS, log: SILENT });

    const { job, created } = await service.startDues(ctx, duesBody('dues-scale-0001'));
    expect(created).toBe(true);
    expect(job).toMatchObject({ status: 'pending', total: UNITS, processed: 0, kind: 'dues_bulk' });
    expect(jobs.lines.size).toBe(Math.ceil(UNITS / 250));
    expect(q.messages).toHaveLength(1);

    const invocations = await drain(service, q.messages);
    expect(invocations).toBe(UNITS / 100); // 12 cagri: 11 continuation + bitis

    const done = (await service.get(ctx, job.jobId)) as BulkJob;
    expect(done).toMatchObject({ status: 'completed', processed: UNITS, succeeded: UNITS, failed: 0, written: UNITS, invocations: 12 });
    expect(done.result).toMatchObject({ count: UNITS, distributedAmount: UNITS * 150_001, replayed: false });
    expect(done.leaseUntil).toBeUndefined();

    const charges = [...ow.fake.transactions.values()].filter((t) => t.kind === 'dues_charge' && t.batchId === done.result?.batchId);
    expect(charges).toHaveLength(UNITS);
    expect(new Set(charges.map((t) => t.lines[0]?.unitId)).size).toBe(UNITS);
    expect(charges.reduce((s, t) => s + t.totalAmount, 0)).toBe(UNITS * 150_001);
    expect(ow.fake.trialBalance()).toBe(0);
    expect(ow.fake.events('DUE_GENERATED')).toHaveLength(UNITS);
    const summaries = ow.fake.events('DUES_BATCH_SUMMARY').filter((e) => e.payload.batchId === done.result?.batchId);
    expect(summaries).toHaveLength(Math.ceil(UNITS / BATCH_SUMMARY_CHUNK));

    // Eski mesajin tekrar teslimi ve ayni anahtarla yeniden baslatma: yeni kayit yok.
    await service.handle({ type: 'bulk_job', apartmentId: APT, jobId: job.jobId, seq: 3 });
    const again = await service.startDues(ctx, duesBody('dues-scale-0001'));
    expect(again).toMatchObject({ created: false, job: { status: 'completed' } });
    expect(q.messages).toHaveLength(0);
    expect([...ow.fake.transactions.values()].filter((t) => t.kind === 'dues_charge')).toHaveLength(UNITS);

    // Ayni anahtar farkli icerik: 409.
    await expect(service.startDues(ctx, { ...duesBody('dues-scale-0001'), totalAmount: UNITS * 150_002 })).rejects.toMatchObject({ httpStatus: 409 });
  }, 180_000);

  it('worker kesintisi (gecici hata) ve yinelenen mesaj: kaldigi yerden devam, cift kayit yok', async () => {
    const ow = bigSite();
    const ctx = { apartmentId: APT, userId: manager.userId };
    const jobs = createMemoryBulkJobRepository();
    const q = createMemoryBulkJobQueue();
    const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: ow.finance, now: ow.now, options: OPTIONS, log: SILENT });
    const { job } = await service.startDues(ctx, duesBody('dues-scale-0002'));

    // Ilk iki cagri normal; ucuncude bir bolumun yazimi gecici hatayla duser.
    await service.handle(q.messages.shift() as never);
    await service.handle(q.messages.shift() as never);
    const third = q.messages.shift() as (typeof q.messages)[number];
    ow.fake.failNext(new Error('ag kesintisi'));
    await expect(service.handle(third)).rejects.toThrow('ag kesintisi');
    const mid = await service.get(ctx, job.jobId);
    expect(mid.status).toBe('running');
    expect(mid.leaseUntil).toBeUndefined(); // kira birakildi: tekrar teslim hemen devam eder
    expect(mid.processed).toBeGreaterThanOrEqual(200);
    expect(mid.processed % 25).toBe(0);

    // SQS ayni mesaji tekrar teslim eder; ayrica yinelenen bir kopya da gelir.
    q.messages.push(third, { ...third });
    await drain(service, q.messages);

    const done = await service.get(ctx, job.jobId);
    expect(done).toMatchObject({ status: 'completed', processed: UNITS, failed: 0 });
    const charges = [...ow.fake.transactions.values()].filter((t) => t.kind === 'dues_charge');
    expect(charges).toHaveLength(UNITS);
    expect(new Set(charges.map((t) => t.lines[0]?.unitId)).size).toBe(UNITS);
    expect(charges.reduce((s, t) => s + t.totalAmount, 0)).toBe(UNITS * 150_001);
    expect(ow.fake.trialBalance()).toBe(0);
    // Kesintide yarim kalan parca tekrarlandi ama defter yazimi idempotent: yeni yazim = bolum sayisi.
    expect(done.written).toBeLessThanOrEqual(UNITS);
  }, 180_000);

  it('kira: ayni anda gelen iki kopya ayni isi birlikte ilerletemez', async () => {
    const ow = bigSite();
    const ctx = { apartmentId: APT, userId: manager.userId };
    const jobs = createMemoryBulkJobRepository();
    const q = createMemoryBulkJobQueue();
    const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: ow.finance, now: ow.now, options: OPTIONS, log: SILENT });
    const { job } = await service.startDues(ctx, duesBody('dues-scale-0003'));
    const m = q.messages.shift() as (typeof q.messages)[number];
    const [a, b] = await Promise.all([service.handle(m), service.handle({ ...m })]);
    expect([a.outcome, b.outcome].sort()).toEqual(['continued', 'skipped']);
    await drain(service, q.messages);
    expect(await service.get(ctx, job.jobId)).toMatchObject({ status: 'completed', processed: UNITS });
    expect([...ow.fake.transactions.values()].filter((t) => t.kind === 'dues_charge')).toHaveLength(UNITS);
  }, 180_000);

  it('is mantigi hatasi bolumu hatali sayar, is devam eder; Tekrar dene yalnizca eksikleri yazar', async () => {
    const ow = bigSite();
    const ctx = { apartmentId: APT, userId: manager.userId };
    const jobs = createMemoryBulkJobRepository();
    const q = createMemoryBulkJobQueue();
    // u0500 bolumunun yazimi 409 (orn. kapali cari) ile reddedilir; ikinci denemede gecer.
    let blocked = true;
    const finance: BulkJobDeps['finance'] = {
      ...ow.finance,
      postBulkLine: async (c, spec, line) => {
        if (blocked && line.unitId === 'u0500') throw Object.assign(new Error('Bu cari kapatildi'), { httpStatus: 409, code: 'conflict' });
        return ow.finance.postBulkLine(c, spec, line);
      },
    };
    const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance, now: ow.now, options: OPTIONS, log: SILENT });
    const { job } = await service.startDues(ctx, duesBody('dues-scale-0004'));
    await drain(service, q.messages);
    const partial = await service.get(ctx, job.jobId);
    expect(partial).toMatchObject({ status: 'completed_with_errors', processed: UNITS, succeeded: UNITS - 1, failed: 1, failures: [{ unitId: 'u0500', message: 'Bu cari kapatildi' }] });

    blocked = false;
    await service.retry(ctx, job.jobId);
    await drain(service, q.messages);
    const done = await service.get(ctx, job.jobId);
    expect(done).toMatchObject({ status: 'completed', succeeded: UNITS, failed: 0 });
    expect(done.result?.count).toBe(UNITS);
    const charges = [...ow.fake.transactions.values()].filter((t) => t.kind === 'dues_charge');
    expect(charges).toHaveLength(UNITS);
    expect(ow.fake.trialBalance()).toBe(0);
  }, 180_000);
});

describe('1.200 bolum: sayac donemi onayi arka plan isi', () => {
  it('HTTP onay 202 doner; parca parca yazilir, donem posted, kurus mutabakati ve imlecler tamam', async () => {
    const w = meterPostingWorld('2026-12-05');
    for (let i = 4; i <= UNITS; i++) w.ow.addUnit(`u${String(i).padStart(4, '0')}`, String(i));
    const jobs = createMemoryBulkJobRepository();
    const q = createMemoryBulkJobQueue();
    const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: w.ow.finance, meters: w.posting, now: w.ow.now, options: OPTIONS, log: SILENT });
    const app = createApp({
      version: 'test',
      financeService: w.ow.finance,
      meterService: w.service,
      meterReadingService: w.readings,
      meterPostingService: w.posting,
      bulkJobService: service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify(manager), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    const tpl = (await call('POST', '/api/metering/templates', { preset: 'central_heating' })).json;
    const unitIds = w.ow.units.map((u) => u.unitId);
    const meterIds: string[] = [];
    for (const unitId of unitIds) {
      const r = await call('POST', '/api/metering/meters', { unitId, kind: 'heat_allocator', label: 'Salon', openingIndex: 0, installedAt: '2026-01-01' });
      if (r.status !== 201) throw new Error(JSON.stringify(r.json));
      meterIds.push(r.json.meterId);
    }
    const total = 12_345_678_901; // 123.456.789,01 TL: kurus bolunmez, en buyuk kalan
    const period = (
      await call('POST', '/api/metering/periods', { templateId: tpl.templateId, name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', totalAmount: total })
    ).json;
    for (let i = 0; i < meterIds.length; i += 90) {
      const items = meterIds.slice(i, i + 90).map((meterId, j) => ({ meterId, endIndex: ((i + j) % 37) * 10 + 5 }));
      const r = await call('PUT', `/api/meter-readings/periods/${period.periodId}`, { items });
      if (r.status !== 200) throw new Error(JSON.stringify(r.json));
    }
    // Performans: 1.000+ bolumde onizleme de arka plan isi (202); cift tiklama ayni isi doner.
    const started = await call('POST', `/api/metering/periods/${period.periodId}/calculate`);
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ mode: 'job', created: true, job: { kind: 'meter_calculation', status: 'pending', total: UNITS, params: { periodId: period.periodId } } });
    const calcJobId = started.json.job.jobId as string;
    expect((await call('POST', `/api/metering/periods/${period.periodId}/calculate`)).json).toMatchObject({ created: false, job: { jobId: calcJobId } });
    // Is bitmeden sonuc yok; sayfa yenilense de donemin isi bulunur.
    expect((await call('GET', `/api/metering/periods/${period.periodId}/calculation/${calcJobId}`)).status).toBe(409);
    expect((await call('GET', `/api/metering/periods/${period.periodId}/job`)).json.job).toMatchObject({ jobId: calcJobId, kind: 'meter_calculation' });
    await drain(service, q.messages);
    expect((await call('GET', `/api/jobs/${calcJobId}`)).json).toMatchObject({ status: 'completed', percent: 100, result: { ok: true, unitCount: UNITS, chargeCount: UNITS } });
    const calc = await call('GET', `/api/metering/periods/${period.periodId}/calculation/${calcJobId}`);
    expect(calc.status).toBe(200);
    expect(calc.json).toMatchObject({ ok: true, period: { status: 'calculated' }, totals: { unitCount: UNITS, chargeCount: UNITS } });
    expect(calc.json.period.calc.hash).toBe(calc.json.calcHash);
    expect(calc.json.lines).toHaveLength(UNITS);
    // Biten is donemin guncel hesabini urettigi icin /job ile geri yuklenir (onizleme kaybolmaz).
    expect((await call('GET', `/api/metering/periods/${period.periodId}/job`)).json.job).toMatchObject({ jobId: calcJobId, status: 'completed' });
    // Ayni girdiyle senkron yol: ayni cetvel, toplamlar ve calcHash (cikti JSON'u birebir).
    const sync = await w.posting.calculate({ apartmentId: APT, userId: manager.userId, role: 'apartment_manager' }, period.periodId);
    if (!sync.ok) throw new Error('senkron hesap yapilamadi');
    expect(calc.json.calcHash).toBe(sync.calcHash);
    expect(calc.json.lines).toEqual(JSON.parse(JSON.stringify(sync.lines)));
    expect({ ...calc.json.totals, calculatedAt: undefined }).toEqual({ ...JSON.parse(JSON.stringify(sync.totals)), calculatedAt: undefined });
    expect(calc.json.warnings).toEqual(sync.warnings);
    // Onizleme isi bitis bildirimi uretmez (yalnizca defter yazan isler).
    expect(jobs.outbox).toHaveLength(0);

    // Eski hash: hemen 409 (is acilmaz).
    expect((await call('POST', `/api/metering/periods/${period.periodId}/approve`, { calcHash: '0'.repeat(32) })).status).toBe(409);
    expect(q.messages).toHaveLength(0);

    const accepted = await call('POST', `/api/metering/periods/${period.periodId}/approve`, { calcHash: calc.json.calcHash });
    expect(accepted.status).toBe(202);
    expect(accepted.json).toMatchObject({ mode: 'job', job: { kind: 'meter_posting', status: 'pending', total: UNITS } });
    const jobId = accepted.json.job.jobId as string;
    // Tekrar tiklama ayni isi doner.
    expect((await call('POST', `/api/metering/periods/${period.periodId}/approve`, { calcHash: calc.json.calcHash })).json.job.jobId).toBe(jobId);

    const invocations = await drain(service, q.messages);
    expect(invocations).toBeGreaterThanOrEqual(UNITS / 100);

    const status = await call('GET', `/api/jobs/${jobId}`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ status: 'completed', processed: UNITS, total: UNITS, percent: 100, result: { posted: UNITS, written: UNITS } });
    expect(status.json).not.toHaveProperty('leaseToken');

    const charges = w.meterCharges(period.periodId);
    expect(charges).toHaveLength(UNITS);
    expect(new Set(charges.map((t) => t.lines[0]?.unitId)).size).toBe(UNITS);
    expect(charges.reduce((s, t) => s + t.totalAmount, 0)).toBe(total);
    expect(w.ow.fake.trialBalance()).toBe(0);
    expect(w.lines(period.periodId).every((l) => l.status === 'posted' && !!l.transactionId)).toBe(true);
    expect(w.meter(meterIds[0] as string).lastReading?.periodId).toBe(period.periodId);
    const summaries = w.ow.fake.events('DUES_BATCH_SUMMARY').filter((e) => e.payload.batchId === `mdp-${period.periodId}`);
    expect(summaries).toHaveLength(Math.ceil(UNITS / BATCH_SUMMARY_CHUNK));
    expect(w.meterRepo.audits.filter((a) => a.action === 'meters.period_posted')).toHaveLength(1);
    // Bildirim devami: onay isi bitince baslatana tek ozet olayi.
    expect(jobs.outbox.map((e) => [e.type, (e.payload as { kind: string; status: string }).kind, (e.payload as { status: string }).status])).toEqual([['BULK_JOB_FINISHED', 'meter_posting', 'completed']]);

    // Bitmis donemin onayini tekrar: yeni kayit yok.
    await service.handle({ type: 'bulk_job', apartmentId: APT, jobId, seq: 99 });
    expect(w.meterCharges(period.periodId)).toHaveLength(UNITS);
    // Baska apartmanin isi gorunmez.
    const other = await app.request(`/api/jobs/${jobId}`, { headers: { 'x-test-claims': JSON.stringify({ ...manager, apartmentId: 'apt-2' }) } });
    expect(other.status).toBe(404);
  }, 300_000);
});
