/**
 * Performans: buyuk donemde sayac onizlemesi (`/calculate`) arka plan isi olarak.
 *  - Esigin altindaki donem senkron yolda kalir; ustundeki 202 + `meter_calculation` isi.
 *  - Is senkron yolla AYNI fonksiyonu calistirir: cetvel, toplamlar ve calcHash birebir ayni.
 *  - Engelli hesap (eksik okuma) is olarak tamamlanir, engeller sonuc govdesinde.
 *  - Okumalar is bittikten sonra degisirse sonuc 409 (bayat onizleme onaylanamaz); yeni hesap yeni is.
 *  - Taslak olmayan donem: 422 (is acilmaz). Tenant izolasyonu: baska apartmanin isi bulunamaz.
 *  - Cikti parcalanir (buyuk cetvel tek ogeye sigmaz); onizleme bitis bildirimi uretmez.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { createMemoryBulkJobQueue } from '../src/modules/bulkjobs/queue.js';
import { createMemoryBulkJobRepository } from '../src/modules/bulkjobs/repository.js';
import { createBulkJobService, splitCodePoints } from '../src/modules/bulkjobs/service.js';
import { OUTPUT_CHUNK_CHARS } from '../src/modules/bulkjobs/types.js';
import { meterPostingWorld } from './fakes/meterPostingWorld.js';
import { APT, manager } from './fakes/ownershipWorld.js';

const SILENT = { info: () => undefined, error: () => undefined };

function setup(threshold = 2) {
  const w = meterPostingWorld('2026-12-05');
  const jobs = createMemoryBulkJobRepository();
  const q = createMemoryBulkJobQueue();
  const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: w.ow.finance, meters: w.posting, now: w.ow.now, log: SILENT });
  const app = createApp({
    version: 'test',
    financeService: w.ow.finance,
    meterService: w.service,
    meterReadingService: w.readings,
    meterPostingService: w.posting,
    bulkJobService: service,
    meterAsyncCalculateUnits: threshold,
    authenticate: (c) => {
      const raw = c.req.header('x-test-claims');
      return raw ? (JSON.parse(raw) as AuthClaims) : null;
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
  const call = async (method: string, path: string, body?: unknown, who: AuthClaims = manager): Promise<{ status: number; json: Record<string, any> }> => {
    const res = await app.request(path, {
      method,
      headers: { 'x-test-claims': JSON.stringify(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const drain = async () => {
    while (q.messages.length) await service.handle(q.messages.shift() as never);
  };
  return { w, jobs, q, service, call, drain };
}

async function period(s: ReturnType<typeof setup>, read: 'all' | 'partial' = 'all') {
  const tpl = (await s.call('POST', '/api/metering/templates', { preset: 'central_heating' })).json;
  const meterIds: string[] = [];
  for (const u of s.w.ow.units) meterIds.push((await s.call('POST', '/api/metering/meters', { unitId: u.unitId, kind: 'heat_allocator', label: 'Salon', openingIndex: 0, installedAt: '2026-01-01' })).json.meterId);
  const p = (await s.call('POST', '/api/metering/periods', { templateId: tpl.templateId, name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', totalAmount: 1_000_001 })).json;
  const ids = read === 'all' ? meterIds : meterIds.slice(1);
  await s.call('PUT', `/api/meter-readings/periods/${p.periodId}`, { items: ids.map((meterId, i) => ({ meterId, endIndex: 10 + i * 7 })) });
  return { periodId: p.periodId as string, meterIds };
}

describe('sayac onizlemesi: arka plan isi', () => {
  it('esigin altinda senkron yol (is yok); ustunde 202 ve sonuc senkron hesapla birebir ayni', async () => {
    const small = setup(1000);
    const a = await period(small);
    const sync = await small.call('POST', `/api/metering/periods/${a.periodId}/calculate`);
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ ok: true });
    expect(small.q.messages).toHaveLength(0);

    const big = setup(2);
    const b = await period(big);
    const started = await big.call('POST', `/api/metering/periods/${b.periodId}/calculate`);
    expect(started.status).toBe(202);
    expect(started.json.job).toMatchObject({ kind: 'meter_calculation', status: 'pending', total: 3 });
    await big.drain();
    const out = await big.call('GET', `/api/metering/periods/${b.periodId}/calculation/${started.json.job.jobId}`);
    expect(out.status).toBe(200);
    // Iki dunya ayni girdiye sahip: ayni hash, ayni cetvel ve toplamlar.
    expect(out.json.calcHash).toBe(sync.json.calcHash);
    expect(out.json.lines).toEqual(sync.json.lines);
    expect({ ...out.json.totals, calculatedAt: undefined }).toEqual({ ...sync.json.totals, calculatedAt: undefined });
    expect(out.json.period).toMatchObject({ status: 'calculated', calc: { hash: out.json.calcHash } });
    expect(out.json.period).not.toHaveProperty('PK');
    // Onay ayni calcHash ile kabul edilir (esik onay icin degismedi: 3 bolum senkron).
    expect((await big.call('POST', `/api/metering/periods/${b.periodId}/approve`, { calcHash: out.json.calcHash })).status).toBe(200);
    expect(big.jobs.outbox).toHaveLength(0);
  });

  it('engelli hesap (eksik okuma) tamamlanir, engeller sonuc govdesinde', async () => {
    const s = setup(2);
    const p = await period(s, 'partial');
    const started = await s.call('POST', `/api/metering/periods/${p.periodId}/calculate`);
    await s.drain();
    expect((await s.call('GET', `/api/jobs/${started.json.job.jobId}`)).json).toMatchObject({ status: 'completed', result: { ok: false, blockerCount: 1 } });
    const out = await s.call('GET', `/api/metering/periods/${p.periodId}/calculation/${started.json.job.jobId}`);
    expect(out.json).toMatchObject({ ok: false, blockers: [{ code: 'missing_reading', meterId: p.meterIds[0] }], period: { status: 'draft' } });
  });

  it('is sonrasi okuma degisti: sonuc 409; yeni hesap yeni is; taslak olmayan donem 422; baska apartman 404', async () => {
    const s = setup(2);
    const p = await period(s);
    const first = (await s.call('POST', `/api/metering/periods/${p.periodId}/calculate`)).json.job.jobId as string;
    await s.drain();
    await s.call('PUT', `/api/meter-readings/periods/${p.periodId}`, { items: [{ meterId: p.meterIds[0], endIndex: 99 }] });
    const stale = await s.call('GET', `/api/metering/periods/${p.periodId}/calculation/${first}`);
    expect(stale.status).toBe(409);
    // Bayat is /job ile geri yuklenmez.
    expect((await s.call('GET', `/api/metering/periods/${p.periodId}/job`)).json.job).toBeNull();
    const second = (await s.call('POST', `/api/metering/periods/${p.periodId}/calculate`)).json.job.jobId as string;
    expect(second).not.toBe(first);
    await s.drain();
    const fresh = await s.call('GET', `/api/metering/periods/${p.periodId}/calculation/${second}`);
    expect(fresh.status).toBe(200);
    expect((await s.call('POST', `/api/metering/periods/${p.periodId}/approve`, { calcHash: fresh.json.calcHash })).status).toBe(200);
    // Onayli donem: onizleme 422, is acilmaz.
    const posted = await s.call('POST', `/api/metering/periods/${p.periodId}/calculate`);
    expect(posted.status).toBe(422);
    expect(s.q.messages).toHaveLength(0);
    // Tenant izolasyonu: is yalnizca JWT apartmaninda aranir.
    expect((await s.call('GET', `/api/metering/periods/${p.periodId}/calculation/${second}`, undefined, { ...manager, apartmentId: 'apt-x' })).status).toBe(404);
  });

  it('es zamanli iki /calculate tek is acar; is surerken onay 409; bitince onay gecer', async () => {
    const s = setup(2);
    const p = await period(s);
    const [a, b] = await Promise.all([s.call('POST', `/api/metering/periods/${p.periodId}/calculate`), s.call('POST', `/api/metering/periods/${p.periodId}/calculate`)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.json.job.jobId).toBe(b.json.job.jobId);
    expect([a.json.created, b.json.created].sort()).toEqual([false, true]);
    expect(s.q.messages).toHaveLength(1);
    expect(s.jobs.jobs.size).toBe(1);

    // Is surerken onay: eski / herhangi bir hash ile reddedilir, is acilmaz.
    const blocked = await s.call('POST', `/api/metering/periods/${p.periodId}/approve`, { calcHash: '0'.repeat(32) });
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toMatch(/hesaplanıyor/);
    await s.drain();
    const out = await s.call('GET', `/api/metering/periods/${p.periodId}/calculation/${a.json.job.jobId}`);
    expect((await s.call('POST', `/api/metering/periods/${p.periodId}/approve`, { calcHash: out.json.calcHash })).status).toBe(200);
  });

  it('kod noktasi parcalama: vekil cift bolunmez, birlesim ayni metin', () => {
    const text = `${'a'.repeat(4)}😀${'b'.repeat(3)}ğ😀`;
    const parts = splitCodePoints(text, 5);
    expect(parts.join('')).toBe(text);
    expect(parts.every((x) => !/[\uD800-\uDBFF]$/.test(x) && !/^[\uDC00-\uDFFF]/.test(x))).toBe(true);
    expect(parts.map((x) => Array.from(x).length)).toEqual([5, 5]);
    expect(parts[0]).toBe('aaaa😀');
  });

  it('cikti parcalara bolunur ve yeniden birlestirilir', async () => {
    const s = setup(2);
    const p = await period(s);
    const started = (await s.call('POST', `/api/metering/periods/${p.periodId}/calculate`)).json.job.jobId as string;
    await s.drain();
    const parts = s.jobs.outputs.get(`${APT}|${started}`) ?? [];
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.every((x) => x.length <= OUTPUT_CHUNK_CHARS)).toBe(true);
    expect(JSON.parse(parts.join(''))).toMatchObject({ ok: true });
  });
});
