import { describe, expect, it } from 'vitest';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { APT, manager, meterPostingWorld } from './fakes/meterPostingWorld.js';

/**
 * Kurulum: 2.3-3 ile ayni (Kasim 2026, %30 m2 + %70 tuketim, 1.000,01 TL), donem onayli.
 *  u1 kiraci t1 -> 27500, u2 oturan malik o2 -> 62501, u3 bos daire (malik o3) -> 10000.
 */
async function posted() {
  const w = meterPostingWorld();
  w.ow.member('t1', { unitId: 'u1', relation: 'tenant', startDate: '2026-03-01' });
  w.ow.member('o1', { unitId: 'u1' });
  w.ow.member('o2', { unitId: 'u2', residesInUnit: true });
  w.ow.member('o3', { unitId: 'u3' });
  const tpl = (await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating' })).json;
  const ids: Record<string, string> = {};
  for (const u of ['u1', 'u2', 'u3']) {
    ids[u] = (await w.call('POST', '/api/metering/meters', manager, { unitId: u, kind: 'heat_allocator', label: 'Salon', openingIndex: 0, installedAt: '2026-01-01' })).json.meterId;
  }
  const openPeriod = async (name: string, startDate: string, endDate: string, dueDate: string, totalAmount: number, readings: Record<string, number>) => {
    const period = (await w.call('POST', '/api/metering/periods', manager, { templateId: tpl.templateId, name, startDate, endDate, dueDate, totalAmount })).json;
    const items = Object.entries(readings).map(([u, endIndex]) => ({ meterId: ids[u], endIndex }));
    const saved = await w.call('PUT', `/api/meter-readings/periods/${period.periodId}`, manager, { items });
    if (saved.status !== 200) throw new Error(JSON.stringify(saved.json));
    return period as { periodId: string };
  };
  const approvePeriod = async (periodId: string) => {
    const pv = await w.call('POST', `/api/metering/periods/${periodId}/calculate`, manager);
    if (!pv.json.ok) throw new Error(JSON.stringify(pv.json));
    const r = await w.call('POST', `/api/metering/periods/${periodId}/approve`, manager, { calcHash: pv.json.calcHash });
    if (r.status !== 200) throw new Error(JSON.stringify(r.json));
    return r.json;
  };
  const nov = await openPeriod('Kasım 2026', '2026-11-01', '2026-11-30', '2026-12-15', 100001, { u1: 100, u2: 300, u3: 0 });
  await approvePeriod(nov.periodId);
  const base = (id: string) => `/api/metering/periods/${id}`;
  const preview = (id: string) => w.call('GET', `${base(id)}/reverse/preview`, manager);
  const reverse = (id: string, key: string, extra: Record<string, unknown> = {}) =>
    w.call('POST', `${base(id)}/reverse`, manager, { idempotencyKey: key, reason: 'Hatalı okuma', ...extra });
  const periodOf = async (id: string) => (await w.call('GET', base(id), manager)).json;
  return { w, tpl, ids, nov, openPeriod, approvePeriod, base, preview, reverse, periodOf };
}

describe('geri alma onizlemesi', () => {
  it('kalemler, toplam ve engelsiz durum', async () => {
    const { nov, preview, w, base } = await posted();
    const r = await preview(nov.periodId);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ canReverse: true, blockers: [], total: 100001 });
    expect(r.json.items.map((i: { unitId: string; state: string }) => [i.unitId, i.state])).toEqual([
      ['u1', 'reversible'],
      ['u2', 'reversible'],
      ['u3', 'reversible'],
    ]);
    // Onayli olmayan donem onizlenemez.
    const draft = (await w.call('POST', '/api/metering/periods', manager, {
      templateId: (await w.call('GET', base(nov.periodId), manager)).json.templateId,
      name: 'Taslak',
      startDate: '2026-12-01',
      endDate: '2026-12-04',
      dueDate: '2026-12-20',
    })).json;
    expect((await preview(draft.periodId)).status).toBe(422);
  });
});

describe('toplu ters kayit (kural 1-3)', () => {
  it('sessiz varsayilan: tum kalemler ters kaydedilir, bakiyeler sifirlanir, sayac imleci geri yuklenir, bildirim yok', async () => {
    const { w, ids, nov, reverse, periodOf } = await posted();
    const r = await reverse(nov.periodId, 'rev-key-0001');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ replayed: false, reversed: 3, written: 3, notified: false, period: { status: 'reversed' } });

    const f = w.ow.fake;
    expect(f.balanceOf('recv-u1-occupant')).toBe(0);
    expect(f.balanceOf('recv-u2-occupant')).toBe(0);
    expect(f.balanceOf('recv-u3-owner')).toBe(0);
    expect(f.trialBalance()).toBe(0);
    const revs = w.reversals(nov.periodId);
    expect(revs).toHaveLength(3);
    expect(revs.every((t) => t.date === '2026-12-05' && t.reason?.includes('Hatalı okuma'))).toBe(true);
    expect(f.events('METER_PERIOD_REVERSED')).toHaveLength(0);

    for (const u of ['u1', 'u2', 'u3']) {
      const m = w.meter(ids[u] as string);
      expect(m.lastReading).toBeUndefined();
      expect(m.recentConsumption).toBeUndefined();
    }
    expect(w.lines(nov.periodId).every((l) => l.status === 'reversed' && !!l.reversalTransactionId)).toBe(true);
    expect(w.meterRepo.audits.map((a) => a.action).filter((a) => a.startsWith('meters.period_rever'))).toEqual(['meters.period_reverse', 'meters.period_reversed']);
    expect((await periodOf(nov.periodId)).reversal).toMatchObject({ key: 'rev-key-0001', reason: 'Hatalı okuma', notify: false, reversedCount: 3 });

    const again = await reverse(nov.periodId, 'rev-key-0001');
    expect(again.json).toMatchObject({ replayed: true, reversed: 3, written: 0 });
    expect((await reverse(nov.periodId, 'rev-key-0002')).status).toBe(409);
    expect(w.reversals(nov.periodId)).toHaveLength(3);
  });

  it('notify: true -> outbox ozeti ve sakin basina tek bildirim', async () => {
    const { w, nov, reverse } = await posted();
    const r = await reverse(nov.periodId, 'rev-key-0001', { notify: true });
    expect(r.json.notified).toBe(true);
    const events = w.ow.fake.events('METER_PERIOD_REVERSED');
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev) throw new Error('olay yok');
    expect(ev.payload).toMatchObject({ periodId: nov.periodId, batchId: `mdr-${nov.periodId}`, totalAmount: 100001, description: 'Isınma — Kasım 2026' });
    expect(ev.payload.items.map((i) => i.unitId)).toEqual(['u1', 'u2', 'u3']);

    const notes = buildNotifications(ev, await w.ow.memberships.list(APT), new Map(), '2026-12-05');
    expect(notes.every((n) => n.template === 'dues_reversed')).toBe(true);
    expect(notes.map((n) => n.userId)).toEqual(expect.arrayContaining(['t1', 'o2', 'o3']));
    const t1 = notes.find((n) => n.userId === 't1');
    expect(t1?.data).toMatchObject({ total: 27500 });
  });

  it('zincir korumasi: ayni sayaclarin daha yeni onayli donemi varsa once o geri alinmali', async () => {
    const { w, ids, nov, openPeriod, approvePeriod, preview, reverse } = await posted();
    const dec = await openPeriod('Aralık 2026 (ilk hafta)', '2026-12-01', '2026-12-04', '2026-12-20', 5000, { u1: 130, u2: 320, u3: 5 });
    await approvePeriod(dec.periodId);

    const pv = await preview(nov.periodId);
    expect(pv.json.canReverse).toBe(false);
    expect(pv.json.blockers.map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(['newer_period', 'meter_advanced']));
    const blocked = await reverse(nov.periodId, 'rev-key-0001');
    expect(blocked.status).toBe(422);
    expect(w.reversals(nov.periodId)).toHaveLength(0);

    expect((await reverse(dec.periodId, 'rev-key-dec-01')).status).toBe(200);
    expect(w.meter(ids.u1 as string).lastReading).toEqual({ index: 100, date: '2026-11-30', periodId: nov.periodId });
    expect(w.meter(ids.u1 as string).recentConsumption).toEqual([{ delta: 100, days: 333, periodId: nov.periodId }]);
    expect((await reverse(nov.periodId, 'rev-key-0001')).status).toBe(200);
    expect(w.meter(ids.u1 as string).lastReading).toBeUndefined();
  });

  it('defter engelleri korunur: tasinma kapamasiyla kapatilan doneme ait kalem geri alinamaz', async () => {
    const { w, nov, preview, reverse, periodOf } = await posted();
    const closed = await w.ow.call('POST', '/api/finance/units/u1/closures', manager, {
      idempotencyKey: 'close-0001',
      party: 'occupant',
      moveOutDate: '2026-12-01',
      userIds: ['t1'],
      reason: 'Kiracı taşındı',
    });
    expect(closed.status).toBe(201);
    const pv = await preview(nov.periodId);
    // Kalem kapamayla devredildi: reverseTransaction'in kapanmis donem (veya hedefli kapama) engeli.
    expect(pv.json.blockers).toHaveLength(1);
    expect(pv.json.blockers[0].unitId).toBe('u1');
    expect(['closed_period', 'settled']).toContain(pv.json.blockers[0].code);
    const r = await reverse(nov.periodId, 'rev-key-0001');
    expect(r.status).toBe(422);
    expect(r.json.blockers[0].unitId).toBe('u1');
    expect((await periodOf(nov.periodId)).status).toBe('posted');
    expect(w.reversals(nov.periodId)).toHaveLength(0);
  });

  it('yarida kesilen geri alma ayni anahtarla kaldigi yerden tamamlanir', async () => {
    const { w, ids, nov, reverse, periodOf } = await posted();
    const repo = w.ow.fake.repo;
    const original = repo.postTransaction;
    let calls = 0;
    repo.postTransaction = async (input) => {
      calls++;
      if (calls === 2) throw new Error('Lambda zaman aşımı (simülasyon)');
      return original(input);
    };
    expect((await reverse(nov.periodId, 'rev-key-0001')).status).toBe(500);
    repo.postTransaction = original;

    expect((await periodOf(nov.periodId)).status).toBe('reversing');
    expect(w.reversals(nov.periodId)).toHaveLength(1);
    expect(w.meter(ids.u1 as string).lastReading?.periodId).toBe(nov.periodId);
    expect((await reverse(nov.periodId, 'rev-key-other')).status).toBe(409);
    // Okuma girisi / yeni onay bu sirada yapilamaz.
    expect((await w.call('POST', `/api/metering/periods/${nov.periodId}/calculate`, manager)).status).toBe(422);

    const done = await reverse(nov.periodId, 'rev-key-0001', { reason: 'farklı metin yok sayılır' });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ reversed: 3, written: 2, period: { status: 'reversed' } });
    const revs = w.reversals(nov.periodId);
    expect(revs).toHaveLength(3);
    expect(new Set(revs.map((t) => t.reversalOf)).size).toBe(3);
    expect(revs.every((t) => t.reason?.includes('Hatalı okuma'))).toBe(true);
    expect(w.meter(ids.u1 as string).lastReading).toBeUndefined();
    expect(w.ow.fake.trialBalance()).toBe(0);
  });
});

describe('duzeltilmis donem (kural 4)', () => {
  it('geri alinan donemden tek komutla taslak; okumalar kopyalanir; hatali okuma duzeltilip yeniden onaylanir', async () => {
    const { w, ids, nov, reverse, approvePeriod, periodOf } = await posted();
    // Geri alinmamis donemden duzeltme acilamaz.
    expect((await w.call('POST', `/api/metering/periods/${nov.periodId}/correction`, manager, {})).status).toBe(422);
    await reverse(nov.periodId, 'rev-key-0001');

    const c = await w.call('POST', `/api/metering/periods/${nov.periodId}/correction`, manager, {});
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ replayed: false, copied: 3, period: { status: 'draft', name: 'Kasım 2026 (düzeltme)', supersedesPeriodId: nov.periodId, totalAmount: 100001 } });
    const corr = c.json.period.periodId as string;
    expect((await periodOf(nov.periodId)).supersededByPeriodId).toBe(corr);
    const again = await w.call('POST', `/api/metering/periods/${nov.periodId}/correction`, manager, {});
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, copied: 0, period: { periodId: corr } });

    const sheet = (await w.call('GET', `/api/meter-readings/periods/${corr}`, manager)).json;
    const row = sheet.rows.find((r: { meterId: string }) => r.meterId === ids.u1);
    expect(row).toMatchObject({ status: 'ok', startIndex: 0, startSource: 'opening', endIndex: 100 });
    expect(sheet.summary).toMatchObject({ ok: 3, missing: 0 });

    // Yalnizca hatali okuma duzeltilir: u1 100 -> 120.
    expect((await w.call('PUT', `/api/meter-readings/periods/${corr}`, manager, { items: [{ meterId: ids.u1, endIndex: 120 }] })).status).toBe(200);
    // Tuketim 120 / 300: 20000,28 -> 20000 ; 50000,71 -> 50001 (artan kurus).
    await approvePeriod(corr);
    const f = w.ow.fake;
    expect(f.balanceOf('recv-u1-occupant')).toBe(30000);
    expect(f.balanceOf('recv-u2-occupant')).toBe(60001);
    expect(f.balanceOf('recv-u3-owner')).toBe(10000);
    expect(w.meterCharges(corr).reduce((s, t) => s + t.totalAmount, 0)).toBe(100001);
    expect(w.meter(ids.u1 as string).lastReading).toEqual({ index: 120, date: '2026-11-30', periodId: corr });
    // Onayli donemden (geri alinmamis) duzeltme acilamaz.
    expect((await w.call('POST', `/api/metering/periods/${corr}/correction`, manager, {})).status).toBe(422);
  });
});
