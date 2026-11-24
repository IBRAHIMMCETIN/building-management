import { describe, expect, it } from 'vitest';
import { MeterError } from '../src/modules/meters/errors.js';
import { assertReconciled } from '../src/modules/meters/posting.js';
import { APT, manager, meterPostingWorld, staff } from './fakes/meterPostingWorld.js';

type W = ReturnType<typeof meterPostingWorld>;

/**
 * Kurulum (Kasim 2026, merkezi isitma %30 m2 + %70 tuketim, fatura 1.000,01 TL):
 *  u1: kiraci t1 (sakin carisi)      okuma 100
 *  u2: oturan malik o2 (sakin carisi) okuma 300
 *  u3: oturmayan malik o3 (bos daire -> malik carisi) okuma 0
 * Beklenen: ortak 30000 -> 10000 x 3; tuketim 70001 -> 17500 / 52501 / 0.
 * u1 = 27500, u2 = 62501, u3 = 10000 (toplam 100001).
 */
async function setup(opts: { readings?: Record<string, number>; totalAmount?: number | null } = {}) {
  const w = meterPostingWorld();
  w.ow.member('t1', { unitId: 'u1', relation: 'tenant', startDate: '2026-03-01' });
  w.ow.member('o1', { unitId: 'u1' });
  w.ow.member('o2', { unitId: 'u2', residesInUnit: true });
  w.ow.member('o3', { unitId: 'u3' });
  const tpl = (await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating' })).json;
  const ids: Record<string, string> = {};
  for (const u of ['u1', 'u2', 'u3']) {
    const r = await w.call('POST', '/api/metering/meters', manager, { unitId: u, kind: 'heat_allocator', label: 'Salon', openingIndex: 0, installedAt: '2026-01-01' });
    ids[u] = r.json.meterId;
  }
  const period = (
    await w.call('POST', '/api/metering/periods', manager, {
      templateId: tpl.templateId,
      name: 'Kasım 2026',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      dueDate: '2026-12-15',
      ...(opts.totalAmount === null ? {} : { totalAmount: opts.totalAmount ?? 100001 }),
    })
  ).json;
  const values = opts.readings ?? { u1: 100, u2: 300, u3: 0 };
  const items = Object.entries(values).map(([u, endIndex]) => ({ meterId: ids[u], endIndex }));
  const saved = await w.call('PUT', `/api/meter-readings/periods/${period.periodId}`, manager, { items });
  if (saved.status !== 200) throw new Error(JSON.stringify(saved.json));
  const base = `/api/metering/periods/${period.periodId}`;
  const calculate = () => w.call('POST', `${base}/calculate`, manager);
  const approve = (calcHash?: string) => w.call('POST', `${base}/approve`, manager, calcHash === undefined ? {} : { calcHash });
  return { w, tpl, ids, period, base, calculate, approve };
}

const byUnit = <T extends { unitId: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.unitId, x]));

describe('hesap onizleme', () => {
  it('dagitim cetveli, borclular ve calcHash; donem calculated olur', async () => {
    const { calculate, w, base } = await setup();
    const r = await calculate();
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.calcHash).toMatch(/^[0-9a-f]{32}$/);
    expect(r.json.totals).toMatchObject({ totalAmount: 100001, commonPool: 30000, consumptionPool: 70001, unitCount: 3, chargeCount: 3 });
    const l = byUnit(r.json.lines as { unitId: string; amount: number; liability: Record<string, unknown> }[]);
    expect([l.u1?.amount, l.u2?.amount, l.u3?.amount]).toEqual([27500, 62501, 10000]);
    expect(l.u1?.liability).toMatchObject({ party: 'occupant', vacant: false, kind: 'main', accountId: 'recv-u1-occupant' });
    expect(l.u2?.liability).toMatchObject({ party: 'occupant', kind: 'main' });
    expect(l.u3?.liability).toMatchObject({ party: 'owner', vacant: true, kind: 'main', accountId: 'recv-u3-owner' });
    expect(r.json.period.status).toBe('calculated');
    expect(r.json.description).toBe('Isınma — Kasım 2026');
    // Ayni girdi ayni hash.
    expect((await calculate()).json.calcHash).toBe(r.json.calcHash);
    expect((await w.call('POST', `${base}/calculate`, staff)).status).toBe(403);
  });

  it('engelleyiciler: eksik okuma ve fatura tutari', async () => {
    const { calculate, approve } = await setup({ readings: { u1: 100, u2: 300 }, totalAmount: null });
    const r = await calculate();
    expect(r.json.ok).toBe(false);
    expect(r.json.blockers.map((b: { code: string }) => b.code).sort()).toEqual(['missing_reading', 'missing_total']);
    const a = await approve('x'.repeat(32));
    expect(a.status).toBe(422);
    expect(a.json.blockers).toHaveLength(2);
  });
});

describe('onizleme-onay hash kilidi (kural 1)', () => {
  it('calcHash zorunlu; uyusmazsa 409 ve guncel hash doner', async () => {
    const { calculate, approve } = await setup();
    const { calcHash } = (await calculate()).json;
    expect((await approve()).status).toBe(400);
    const wrong = await approve('0'.repeat(32));
    expect(wrong.status).toBe(409);
    expect(wrong.json.calcHash).toBe(calcHash);
  });

  it('onizlemeden sonra okuma / tutar degisirse onay reddedilir', async () => {
    const { w, ids, period, base, calculate, approve } = await setup();
    const first = (await calculate()).json.calcHash;
    await w.call('PUT', `/api/meter-readings/periods/${period.periodId}`, manager, { items: [{ meterId: ids.u1, endIndex: 101 }] });
    expect((await approve(first)).status).toBe(409);
    const second = (await calculate()).json;
    await w.call('PATCH', base, manager, { version: second.period.version, totalAmount: 100002 });
    const r = await approve(second.calcHash);
    expect(r.status).toBe(409);
    expect(w.meterCharges(period.periodId)).toHaveLength(0);
  });
});

describe('onay ve toplu tahakkuk', () => {
  it('mevcut cozumleyiciyle yazar: kiraci, oturan malik, bos daire -> malik; ozet bildirim ve sayac imleci', async () => {
    const { w, ids, period, calculate, approve } = await setup();
    const { calcHash } = (await calculate()).json;
    const r = await approve(calcHash);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ replayed: false, posted: 3, written: 3, period: { status: 'posted', chargeCount: 3, batchId: `mdp-${period.periodId}` } });

    const f = w.ow.fake;
    expect(f.balanceOf('recv-u1-occupant')).toBe(27500);
    expect(f.balanceOf('recv-u2-occupant')).toBe(62501);
    expect(f.balanceOf('recv-u3-owner')).toBe(10000);
    const charges = w.meterCharges(period.periodId);
    expect(charges).toHaveLength(3);
    expect(charges.reduce((s, t) => s + t.totalAmount, 0)).toBe(100001);
    expect(charges.every((t) => t.batchId === `mdp-${period.periodId}` && t.date === '2026-11-30' && t.dueDate === '2026-12-15')).toBe(true);
    expect(charges.find((t) => t.vacant)?.description).toContain('Isınma — Kasım 2026');
    expect(f.trialBalance()).toBe(0);

    const due = f.events('DUE_GENERATED').filter((e) => e.payload.batchId === `mdp-${period.periodId}`);
    expect(due).toHaveLength(3);
    const summary = f.events('DUES_BATCH_SUMMARY').filter((e) => e.payload.batchId === `mdp-${period.periodId}`);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.payload.totalAmount).toBe(100001);

    expect(w.meter(ids.u1 as string).lastReading).toEqual({ index: 100, date: '2026-11-30', periodId: period.periodId });
    expect(w.meter(ids.u2 as string).recentConsumption).toEqual([{ delta: 300, days: 333, periodId: period.periodId }]);
    expect(w.lines(period.periodId).every((l) => l.status === 'posted' && !!l.transactionId)).toBe(true);
    expect(w.meterRepo.audits.map((a) => a.action).filter((a) => a.startsWith('meters.period_'))).toEqual([
      'meters.period_create',
      'meters.period_approve',
      'meters.period_posted',
    ]);

    // Ayni onay tekrar: yeni kayit yok.
    const again = await approve(calcHash);
    expect(again.json).toMatchObject({ replayed: true, written: 0 });
    expect(w.meterCharges(period.periodId)).toHaveLength(3);
    // Onaylanan doneme okuma girilemez; satirlar okunabilir.
    expect((await w.call('PUT', `/api/meter-readings/periods/${period.periodId}`, manager, { items: [{ meterId: ids.u1, endIndex: 150 }] })).status).toBe(422);
    const lines = await w.call('GET', `/api/metering/periods/${period.periodId}/lines`, manager);
    expect(lines.json.total).toBe(100001);
  });

  it('sonraki donem son onayli endeksten baslar', async () => {
    const { w, tpl, ids, calculate, approve } = await setup();
    await approve((await calculate()).json.calcHash);
    const dec = (
      await w.call('POST', '/api/metering/periods', manager, { templateId: tpl.templateId, name: 'Aralık 2026', startDate: '2026-12-01', endDate: '2026-12-31', dueDate: '2027-01-15' })
    ).json;
    const sheet = (await w.call('GET', `/api/meter-readings/periods/${dec.periodId}`, manager)).json;
    expect(sheet.rows.find((r: { meterId: string }) => r.meterId === ids.u1)).toMatchObject({ startIndex: 100, startSource: 'last_reading' });
  });
});

describe('ayrilan sakin carisi (kural 2)', () => {
  it('donem sonundaki kiraci tasinip carisi kapandiysa kalem ayrilan carisine yazilir, yeni kiraciya degil', async () => {
    const { w, calculate, approve } = await setup();
    const closed = await w.ow.call('POST', '/api/finance/units/u1/closures', manager, {
      idempotencyKey: 'close-0001',
      party: 'occupant',
      moveOutDate: '2026-11-30',
      userIds: ['t1'],
      reason: 'Kiracı taşındı',
    });
    expect(closed.status).toBe(201);
    const closureId = closed.json.closure.closureId as string;
    w.ow.member('t2', { unitId: 'u1', relation: 'tenant', startDate: '2026-12-01' });

    const pv = await calculate();
    const former = `recv-u1-occupant-c${closureId}`;
    expect(byUnit(pv.json.lines as { unitId: string; liability: Record<string, unknown> }[]).u1?.liability).toMatchObject({
      party: 'occupant',
      kind: 'former',
      accountId: former,
      former: { closureId, userIds: ['t1'], periodEnd: '2026-11-30' },
    });
    const r = await approve(pv.json.calcHash);
    expect(r.status).toBe(200);
    expect(w.ow.fake.balanceOf(former)).toBe(27500);
    // Ayrilan cariye yazilan kalem dairenin bugunku sakinine ozet bildiriminde gitmez.
    const summary = w.ow.fake.events('DUES_BATCH_SUMMARY').at(-1);
    expect(summary?.payload.items.map((i) => i.unitId)).toEqual(['u2', 'u3']);
    expect(r.json.posted).toBe(3);
    expect(w.ow.fake.balanceOf('recv-u1-occupant')).toBe(0);
    const acc = await w.ow.acc(former);
    expect(acc).toMatchObject({ type: 'receivable', unitId: 'u1', liableParty: 'occupant', closureId, holder: { userIds: ['t1'], periodEnd: '2026-11-30' } });
  });
});

describe('idempotent parcali tahakkuk (kural 3)', () => {
  it('yarida kesilen onay ayni komutla yalnizca eksik daireleri yazar', async () => {
    const { w, ids, period, calculate, approve } = await setup();
    const { calcHash } = (await calculate()).json;
    const repo = w.ow.fake.repo;
    const original = repo.postTransaction;
    let calls = 0;
    repo.postTransaction = async (input) => {
      calls++;
      if (calls === 2) throw new Error('Lambda zaman aşımı (simülasyon)');
      return original(input);
    };
    const broken = await approve(calcHash);
    expect(broken.status).toBe(500);
    repo.postTransaction = original;

    const mid = (await w.call('GET', `/api/metering/periods/${period.periodId}`, manager)).json;
    expect(mid.status).toBe('posting');
    expect(w.meterCharges(period.periodId)).toHaveLength(1);
    expect(w.ow.fake.events('DUES_BATCH_SUMMARY').filter((e) => e.payload.batchId === `mdp-${period.periodId}`)).toHaveLength(0);
    // Onay surerken okuma girilemez, sayac degistirilemez.
    expect((await w.call('PUT', `/api/meter-readings/periods/${period.periodId}`, manager, { items: [{ meterId: ids.u1, endIndex: 150 }] })).status).toBe(422);
    const swap = await w.call('POST', '/api/metering/swaps/preview', manager, {
      meterId: ids.u1,
      kind: 'reset',
      swapDate: '2026-12-02',
      oldClosingIndex: 120,
      newOpeningIndex: 0,
      reason: 'Sıfırlandı',
    });
    expect(swap.status).toBe(422);
    expect(swap.json.message).toContain('onaylanıyor');

    // Farkli hash ile devam edilemez.
    expect((await approve('1'.repeat(32))).status).toBe(409);
    const done = await approve(calcHash);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ posted: 3, written: 2, period: { status: 'posted' } });
    const charges = w.meterCharges(period.periodId);
    expect(charges).toHaveLength(3);
    expect(new Set(charges.map((t) => t.lines[0]?.unitId)).size).toBe(3);
    expect(charges.reduce((s, t) => s + t.totalAmount, 0)).toBe(100001);
    expect(w.ow.fake.events('DUES_BATCH_SUMMARY').filter((e) => e.payload.batchId === `mdp-${period.periodId}`)).toHaveLength(1);
    expect(w.ow.fake.events('DUE_GENERATED').filter((e) => e.payload.batchId === `mdp-${period.periodId}`)).toHaveLength(3);
  });
});

describe('kurus mutabakat kilidi (kural 4)', () => {
  it('saf kontrol: toplam fatura tutarina esit degilse yazim yok', () => {
    const liability = { party: 'occupant' as const, vacant: false, kind: 'main' as const };
    const ok = [
      { unitId: 'a', amount: 60, commonAmount: 30, consumptionAmount: 30, liability },
      { unitId: 'b', amount: 40, commonAmount: 40, consumptionAmount: 0, liability },
    ];
    expect(() => assertReconciled(100, ok)).not.toThrow();
    expect(() => assertReconciled(101, ok)).toThrow(MeterError);
    expect(() => assertReconciled(100, [{ ...ok[0]!, commonAmount: 31 }, ok[1]!])).toThrow(/tutarsız/);
    expect(() => assertReconciled(100, [ok[0]!, { ...ok[1]!, liability: { ...liability, kind: 'none' as const } }])).toThrow(/borçlusuz/);
  });

  it('devam sirasinda dondurulmus satirlar bozulduysa tahakkuk durur', async () => {
    const { w, period, calculate, approve } = await setup();
    const { calcHash } = (await calculate()).json;
    const repo = w.ow.fake.repo;
    const original = repo.postTransaction;
    let calls = 0;
    repo.postTransaction = async (input) => {
      calls++;
      if (calls === 2) throw new Error('kesinti');
      return original(input);
    };
    await approve(calcHash);
    repo.postTransaction = original;

    const key = `APT#${APT}|MDLINE#${period.periodId}#u3`;
    const doc = w.meterRepo.docs.get(key) as Record<string, unknown> & { PK: string; SK: string };
    w.meterRepo.docs.set(key, { ...doc, amount: 10001, commonAmount: 10001 });
    const r = await approve(calcHash);
    expect(r.status).toBe(422);
    expect(r.json.message).toContain('Kuruş mutabakatı');
    expect(w.meterCharges(period.periodId)).toHaveLength(1);
  });
});
