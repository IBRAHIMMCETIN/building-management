/**
 * Finans 2.3-5a: fatura cift dagitim kilidi, gece denetimi (sayac donemi mutabakati / takili donem),
 * sakin portali tuketim gecmisi ve Sayac Dagitim Dokumu PDF'i.
 */
import { describe, expect, it } from 'vitest';
import type { AuthClaims } from '../src/auth/claims.js';
import { type AuditSnapshot, checkMeterPeriods, createLedgerAuditor } from '../src/modules/finance/audit.js';
import type { MeterLine, MeterPeriod } from '../src/modules/meters/types.js';
import { APT, manager, meterPostingWorld, staff } from './fakes/meterPostingWorld.js';

const resident = (userId: string): AuthClaims => ({ userId, role: 'resident', apartmentId: APT });

async function world() {
  const w = meterPostingWorld();
  w.ow.member('t1', { unitId: 'u1', relation: 'tenant', startDate: '2026-03-01' });
  w.ow.member('o1', { unitId: 'u1' });
  w.ow.member('o2', { unitId: 'u2', residesInUnit: true });
  w.ow.member('o3', { unitId: 'u3' });
  const heat = (await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating' })).json;
  const water = (await w.call('POST', '/api/metering/templates', manager, { preset: 'hot_water' })).json;
  const ids: Record<string, string> = {};
  for (const u of ['u1', 'u2', 'u3']) {
    ids[u] = (await w.call('POST', '/api/metering/meters', manager, { unitId: u, kind: 'heat_allocator', label: 'Salon', serialNo: `PO-${u}`, openingIndex: 0, installedAt: '2026-01-01' })).json.meterId;
  }
  const createPeriod = (body: Record<string, unknown>) =>
    w.call('POST', '/api/metering/periods', manager, { templateId: heat.templateId, name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', ...body });
  const read = async (periodId: string, readings: Record<string, number>) => {
    const r = await w.call('PUT', `/api/meter-readings/periods/${periodId}`, manager, { items: Object.entries(readings).map(([u, endIndex]) => ({ meterId: ids[u], endIndex })) });
    if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  };
  const approve = async (periodId: string) => {
    const pv = await w.call('POST', `/api/metering/periods/${periodId}/calculate`, manager);
    if (!pv.json.ok) throw new Error(JSON.stringify(pv.json));
    return w.call('POST', `/api/metering/periods/${periodId}/approve`, manager, { calcHash: pv.json.calcHash });
  };
  const reverse = (periodId: string, key: string) => w.call('POST', `/api/metering/periods/${periodId}/reverse`, manager, { idempotencyKey: key, reason: 'Hatalı okuma' });
  /** Kasim donemi onayli (100001; u1 27500, u2 62501, u3 10000). */
  const postedNov = async (body: Record<string, unknown> = { totalAmount: 100001 }) => {
    const p = (await createPeriod(body)).json;
    await read(p.periodId, { u1: 100, u2: 300, u3: 0 });
    const r = await approve(p.periodId);
    if (r.status !== 200) throw new Error(JSON.stringify(r.json));
    return p.periodId as string;
  };
  return { w, heat, water, ids, createPeriod, read, approve, reverse, postedNov };
}

describe('fatura cift dagitim kilidi (EXPDIST)', () => {
  it('bagli faturalar tutari belirler; ayni fatura ikinci doneme baglanamaz; bag kaldirilinca serbest', async () => {
    const { w, water, createPeriod } = await world();
    w.addExpense('gas-1', 60000);
    w.addExpense('gas-2', 40001);
    expect((await createPeriod({ expenseIds: ['gas-1', 'yok'] })).status).toBe(404);
    expect((await createPeriod({ expenseIds: ['gas-1', 'gas-2'], totalAmount: 5 })).status).toBe(422);
    expect((await createPeriod({ expenseIds: ['gas-1', 'gas-1'] })).status).toBe(400);
    const nov = await createPeriod({ expenseIds: ['gas-1', 'gas-2'] });
    expect(nov.status).toBe(201);
    expect(nov.json).toMatchObject({ totalAmount: 100001, expenseIds: ['gas-1', 'gas-2'] });

    const waterBody = { templateId: water.templateId, name: 'Kasım sıcak su', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', expenseIds: ['gas-1'] };
    const clash = await w.call('POST', '/api/metering/periods', manager, waterBody);
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ expenseId: 'gas-1', periodId: nov.json.periodId });

    const upd = await w.call('PATCH', `/api/metering/periods/${nov.json.periodId}`, manager, { version: nov.json.version, expenseIds: ['gas-2'] });
    expect(upd.json).toMatchObject({ totalAmount: 40001, expenseIds: ['gas-2'] });
    const wp = await w.call('POST', '/api/metering/periods', manager, waterBody);
    expect(wp.status).toBe(201);
    // Iptal kilidi birakir.
    await w.call('POST', `/api/metering/periods/${wp.json.periodId}/cancel`, manager, { version: wp.json.version, reason: 'Yanlış' });
    const back = await w.call('PATCH', `/api/metering/periods/${nov.json.periodId}`, manager, { version: upd.json.version, expenseIds: ['gas-1', 'gas-2'] });
    expect(back.status).toBe(200);
    expect(back.json.totalAmount).toBe(100001);
  });

  it('geri alma kilidi birakir, duzeltilmis donem yeniden alir; kilit bozulursa onay engellenir', async () => {
    const { w, water, reverse, postedNov } = await world();
    w.addExpense('gas-1', 100001);
    const nov = await postedNov({ expenseIds: ['gas-1'] });
    await reverse(nov, 'rev-key-0001');
    const corr = await w.call('POST', `/api/metering/periods/${nov}/correction`, manager, {});
    expect(corr.status).toBe(201);
    expect(corr.json.period.expenseIds).toEqual(['gas-1']);
    const lock = w.meterRepo.docs.get(`APT#${APT}|EXPDIST#gas-1`) as Record<string, unknown>;
    expect(lock).toMatchObject({ status: 'active', periodId: corr.json.period.periodId });
    const steal = await w.call('POST', '/api/metering/periods', manager, {
      templateId: water.templateId,
      name: 'Su',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      dueDate: '2026-12-15',
      expenseIds: ['gas-1'],
    });
    expect(steal.status).toBe(409);

    // Kilit baska doneme gecmisse (veri bozulmasi) onay engellenir.
    w.meterRepo.docs.set(`APT#${APT}|EXPDIST#gas-1`, { ...(lock as { PK: string; SK: string }), periodId: 'baska-donem' });
    const pv = await w.call('POST', `/api/metering/periods/${corr.json.period.periodId}/calculate`, manager);
    expect(pv.json.ok).toBe(false);
    expect(pv.json.blockers.map((b: { code: string }) => b.code)).toContain('expense_lock');
  });
});

describe('gece denetimi - sayac donemleri', () => {
  const snapshot = (w: Awaited<ReturnType<typeof world>>['w']): Pick<AuditSnapshot, 'transactions' | 'meterPeriods' | 'meterLines'> => ({
    transactions: [...w.ow.fake.transactions.values()],
    meterPeriods: [...w.meterRepo.docs.values()].filter((d) => d.SK.startsWith('MPERIOD#')) as unknown as MeterPeriod[],
    meterLines: [...w.meterRepo.docs.values()].filter((d) => d.SK.startsWith('MDLINE#')) as unknown as MeterLine[],
  });
  const NOW = new Date('2026-12-05T09:10:00.000Z');

  it('onayli donem mutabakati: temizse bulgu yok; eksik kalem / tutar farki raporlanir', async () => {
    const { w, postedNov } = await world();
    const nov = await postedNov();
    expect(checkMeterPeriods(snapshot(w), NOW)).toEqual([]);

    const s = snapshot(w);
    const dropped = s.transactions.find((t) => t.reference === `METER_PERIOD:${nov}`);
    const broken = { ...s, transactions: s.transactions.filter((t) => t !== dropped) };
    const details = checkMeterPeriods(broken, NOW).map((f) => [f.code, f.periodId, f.detail]);
    expect(details).toEqual(
      expect.arrayContaining([
        ['meter_period_mismatch', nov, 'tahakkuk toplami fatura tutarina esit degil'],
        ['meter_period_mismatch', nov, 'tahakkuk sayisi uyusmuyor'],
      ]),
    );
    expect(details.some((d) => String(d[2]).startsWith('satirin islemi defterde yok'))).toBe(true);
  });

  it('geri alinmis donemde canli kalem kalmamali', async () => {
    const { w, postedNov, reverse } = await world();
    const nov = await postedNov();
    await reverse(nov, 'rev-key-0001');
    expect(checkMeterPeriods(snapshot(w), NOW)).toEqual([]);
    const s = snapshot(w);
    const oneReversal = s.transactions.find((t) => t.kind === 'reversal');
    const broken = { ...s, transactions: s.transactions.filter((t) => t !== oneReversal) };
    expect(checkMeterPeriods(broken, NOW)).toEqual([expect.objectContaining({ code: 'meter_period_mismatch', periodId: nov, detail: 'geri alinmis donemde ters kaydedilmemis tahakkuk var' })]);
  });

  it('ara durumda 30 dakikadan uzun kalan donem takili sayilir; denetci raporuna girer', async () => {
    const { w, createPeriod, read, approve } = await world();
    const p = (await createPeriod({ totalAmount: 100001 })).json;
    await read(p.periodId, { u1: 100, u2: 300, u3: 0 });
    const repo = w.ow.fake.repo;
    const original = repo.postTransaction;
    let calls = 0;
    repo.postTransaction = async (input) => {
      if (++calls === 2) throw new Error('kesinti');
      return original(input);
    };
    await approve(p.periodId);
    repo.postTransaction = original;

    const s = snapshot(w);
    const stuckAt = s.meterPeriods?.find((x) => x.periodId === p.periodId)?.updatedAt as string;
    const at = (min: number) => new Date(Date.parse(stuckAt) + min * 60_000);
    expect(checkMeterPeriods(s, at(5))).toEqual([]);
    expect(checkMeterPeriods(s, at(31))).toEqual([expect.objectContaining({ code: 'meter_period_stuck', periodId: p.periodId })]);

    const auditor = createLedgerAuditor(
      {
        load: async () => ({
          apartmentId: APT,
          intents: [],
          closures: [],
          transactions: [],
          entries: [],
          accounts: [],
          payments: [],
          receiptCounter: 0,
          meterPeriods: s.meterPeriods ?? [],
          meterLines: [],
        }),
        getAccount: async () => undefined,
        listAccountEntries: async () => [],
        getTransaction: async () => undefined,
        listClosures: async () => [],
      },
      { now: () => at(45) },
    );
    const report = await auditor.run(APT);
    expect(report.findings.map((f) => f.code)).toEqual(['meter_period_stuck']);
  });
});

describe('sakin portali - tuketim gecmisi ve dokum PDF', () => {
  it('kendi dairesinin donemleri, bina / blok ortalamasi; yetkisiz daire 403, gorunmeyen taraf bos', async () => {
    const { w, postedNov } = await world();
    const nov = await postedNov();
    const r = await w.call('GET', '/api/portal/meters/consumption?unitId=u1', resident('t1'));
    expect(r.status).toBe(200);
    expect(r.json.periods).toHaveLength(1);
    expect(r.json.periods[0]).toMatchObject({
      periodId: nov,
      category: 'heating',
      consumption: 100,
      amount: 27500,
      commonAmount: 10000,
      consumptionAmount: 17500,
      buildingAverage: 133.333,
      blockAverage: 133.333,
      meteredUnits: 3,
      meters: [{ endIndex: '100', delta: '100', label: 'Salon' }],
    });
    expect(r.json.periods[0].previous).toBeUndefined();
    expect((await w.call('GET', '/api/portal/meters/consumption?unitId=u1', resident('o2'))).status).toBe(403);
    // Oturmayan malik sakin tarafini (kiraci tuketimini) gormez.
    expect((await w.call('GET', '/api/portal/meters/consumption?unitId=u1', resident('o1'))).json.periods).toEqual([]);
    // Bos daire (malige yazilan) malike gorunur.
    expect((await w.call('GET', '/api/portal/meters/consumption?unitId=u3', resident('o3'))).json.periods[0]).toMatchObject({ amount: 10000 });
    expect((await w.call('GET', '/api/portal/meters/consumption?unitId=u1', manager)).status).toBe(403);
  });

  it('onceki doneme gore degisim; geri alinan donem listelenmez', async () => {
    const { w, createPeriod, read, approve, reverse, postedNov } = await world();
    const nov = await postedNov();
    const dec = (await createPeriod({ name: 'Aralık ilk hafta', startDate: '2026-12-01', endDate: '2026-12-04', dueDate: '2026-12-20', totalAmount: 5000 })).json;
    await read(dec.periodId, { u1: 130, u2: 320, u3: 5 });
    await approve(dec.periodId);
    const r = (await w.call('GET', '/api/portal/meters/consumption?unitId=u1', resident('t1'))).json;
    expect(r.periods.map((p: { periodId: string }) => p.periodId)).toEqual([dec.periodId, nov]);
    expect(r.periods[0]).toMatchObject({ consumption: 30, previous: { periodId: nov, consumption: 100, diff: -70, percent: -70 } });

    await reverse(dec.periodId, 'rev-key-dec-1');
    const after = (await w.call('GET', '/api/portal/meters/consumption?unitId=u1', resident('t1'))).json;
    expect(after.periods.map((p: { periodId: string }) => p.periodId)).toEqual([nov]);
  });

  it('Sayac Dagitim Dokumu PDF: reports/ altinda onbelleklenir, imzali link; yonetici her daireyi, sakin yalniz kendisini', async () => {
    const { w, postedNov } = await world();
    const nov = await postedNov();
    const r = await w.call('GET', `/api/portal/meters/statement/${nov}?unitId=u1`, resident('t1'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ contentType: 'application/pdf', fileName: `sayac-dokumu-2026-11-30-u1.pdf` });
    const key = decodeURIComponent(String(r.json.url)).match(/^memory:\/\/get\/([^?]+)/)?.[1] as string;
    expect(key).toMatch(new RegExp(`^apartments/${APT}/reports/2026/11/meter-statement-${nov}-u1-[0-9a-f]{16}\\.pdf$`));
    const pdf = w.objects.get(key);
    expect(pdf?.contentType).toBe('application/pdf');
    expect(new TextDecoder().decode(pdf?.body.slice(0, 5))).toBe('%PDF-');
    const count = w.objects.size;
    // Ikinci istek onbellekten (yeniden uretilmez).
    await w.call('GET', `/api/portal/meters/statement/${nov}?unitId=u1`, resident('t1'));
    expect(w.objects.size).toBe(count);

    expect((await w.call('GET', `/api/portal/meters/statement/${nov}?unitId=u1`, resident('o2'))).status).toBe(403);
    expect((await w.call('GET', `/api/portal/meters/statement/${nov}?unitId=u1`, resident('o1'))).status).toBe(403);
    const mgr = await w.call('GET', `/api/metering/periods/${nov}/lines/u2/statement`, manager);
    expect(mgr.status).toBe(200);
    expect(mgr.json.fileName).toBe('sayac-dokumu-2026-11-30-u2.pdf');
    expect((await w.call('GET', `/api/metering/periods/${nov}/lines/u2/statement`, resident('o2'))).status).toBe(403);
  });
});

describe('fatura secicisi (2.3-5b web)', () => {
  it('giderleri yeniden eskiye listeler, aktif kilidi donemle gosterir; yalnizca yonetici gorur', async () => {
    const { w, createPeriod } = await world();
    w.addExpense('gas-1', 60000);
    w.addExpense('gas-2', 40001);
    const nov = (await createPeriod({ expenseIds: ['gas-1'] })).json;
    const res = await w.call('GET', '/api/metering/expenses', manager);
    expect(res.status).toBe(200);
    const items = res.json.items as { expenseId: string; lockedBy?: string; amount: number }[];
    expect(items.map((i) => i.expenseId).sort()).toEqual(['gas-1', 'gas-2']);
    expect(items.find((i) => i.expenseId === 'gas-1')).toMatchObject({ lockedBy: nov.periodId, amount: 60000 });
    expect(items.find((i) => i.expenseId === 'gas-2')?.lockedBy).toBeUndefined();
    expect((await w.call('GET', '/api/metering/expenses?from=2027-01-01', manager)).json.items).toEqual([]);
    expect((await w.call('GET', '/api/metering/expenses', staff)).status).toBe(403);
  });
});
