/**
 * Finans 2.2 - borc yapilandirma / taksit plani (API + servis): faiz dondurma, taksit tablosu,
 * taksit tazminati (yalnizca anapara payi), FIFO tahsilat, muacceliyet (ardisik/toplam + ek sure,
 * otomatik / yonetici onayli), erken kapama, iptal, kapama/devir kilidi, ters kayit korumalari,
 * sakin portali ve zamanlayici isi.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthClaims } from '../src/auth/claims.js';
import { buildEvent, createInMemoryEventPublisher } from '../src/events/publisher.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import { type Site, toKurus } from '../src/modules/core/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { checkSettlements } from '../src/modules/finance/audit.js';
import { feeLedgerFor, unpostedLateFee } from '../src/modules/finance/lateFee.js';
import { allocate, linesOfAccount, readSubledger } from '../src/modules/finance/subledger.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { APT, MAIN, RATE, TL, cariWorld, manager, observer, resident } from './fakes/cariWorld.js';

type W = ReturnType<typeof cariWorld>;

/** Kiraci A: Eylul + Ekim aidati (1000'er TL) odenmemis; bugun 5 Kasim. */
async function debtor(w: W) {
  w.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
  await w.charge('k-sep', 1000, '2026-09-01', '2026-09-10');
  await w.charge('k-oct', 1000, '2026-10-01', '2026-10-10');
  w.setNow('2026-11-05');
}
const dues = async (w: W) => (await w.txs()).filter((t) => t.kind === 'dues_charge').sort((a, b) => a.date.localeCompare(b.date));

async function planBody(w: W, over: Record<string, unknown> = {}) {
  const ids = (await dues(w)).map((t) => t.transactionId);
  return {
    idempotencyKey: 'plan-000001',
    accountId: MAIN,
    chargeIds: ids,
    installments: 4,
    firstDueDate: '2026-12-10',
    reason: 'Sakin yapılandırma talep etti',
    ...over,
  };
}
const open = async (w: W, day: string) => allocate(readSubledger(linesOfAccount(MAIN, await w.txs())), day).open;
const fee = async (w: W, day: string) => unpostedLateFee(feeLedgerFor(MAIN, await w.txs()), RATE, day);

// Eylul (56 gun) + Ekim (26 gun) x 1000 TL x %5/30: 8.200.000 kurus-gun -> 13.667 kurus.
const FROZEN = 13667;

describe('yapilandirma - olusturma', () => {
  it('sihirbaz: acik kalemler ve dondurulacak tazminat (yazmaz); aktif plan gosterilir', async () => {
    const w = cariWorld();
    await debtor(w);
    const r = await w.call('GET', `/api/finance/plans/open-items?accountId=${MAIN}`, manager);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accountId: MAIN, date: '2026-11-05', accruedLateFee: FROZEN });
    expect(r.json.items.map((i: any) => [i.dueDate, i.remaining, i.overdue])).toEqual([
      ['2026-09-10', TL(1000), true],
      ['2026-10-10', TL(1000), true],
    ]);
    expect(r.json).not.toHaveProperty('activePlanId');
    const plan = (await w.call('POST', '/api/finance/plans', manager, await planBody(w))).json.plan;
    const after = await w.call('GET', `/api/finance/plans/open-items?accountId=${MAIN}`, manager);
    expect(after.json.activePlanId).toBe(plan.planId);
    expect(after.json.items.every((i: any) => i.planId === plan.planId)).toBe(true);
    expect((await w.call('GET', `/api/finance/plans/open-items?accountId=${MAIN}`, observer)).status).toBe(403);
    expect((await w.call('GET', '/api/finance/plans/open-items', manager)).status).toBe(400);
  });


  it('onizleme yazmaz: dondurulan tazminat, secilen kalemler, taksit tablosu', async () => {
    const w = cariWorld();
    await debtor(w);
    const before = (await w.txs()).length;
    const r = await w.call('POST', '/api/finance/plans/preview', manager, await planBody(w));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accountId: MAIN, date: '2026-11-05', frozenLateFee: FROZEN, total: TL(2000) + FROZEN, feeBaseTotal: TL(2000), includeLateFees: true });
    expect(r.json.installments.map((i: any) => [i.no, i.dueDate, i.amount, i.feeBase])).toEqual([
      [1, '2026-12-10', 53417, 50000],
      [2, '2027-01-10', 53417, 50000],
      [3, '2027-02-10', 53417, 50000],
      [4, '2027-03-10', 53416, 50000],
    ]);
    expect((await w.txs()).length).toBe(before);
  });

  it('tek atomik yazim: tazminat dondurma + yapilandirma; eski kalemler kapanir, taksitler acilir', async () => {
    const w = cariWorld();
    await debtor(w);
    const r = await w.call('POST', '/api/finance/plans', manager, await planBody(w));
    expect(r.status).toBe(201);
    const plan = r.json.plan;
    expect(plan).toMatchObject({ status: 'active', accountId: MAIN, unitId: 'u1', liableParty: 'occupant', frozenLateFee: FROZEN, total: TL(2000) + FROZEN, rule: { consecutive: 2, total: 3, graceDays: 7, autoAccelerate: false } });
    expect(plan).not.toHaveProperty('PK');
    expect(plan.selected).toHaveLength(3);
    expect(plan.state).toMatchObject({ displayStatus: 'active', remaining: TL(2000) + FROZEN, paid: 0, inDefault: false });
    const batch = w.fake.batches.at(-1)!;
    expect(batch.transactions.map((t) => t.kind)).toEqual(['late_fee', 'restructure']);
    expect(batch.audit).toMatchObject({ action: 'finance.plan_create' });
    const rs = batch.transactions[1]!;
    expect(rs.lines.map((l) => [l.side, l.amount])).toEqual([
      ['credit', TL(2000) + FROZEN],
      ['debit', TL(2000) + FROZEN],
    ]);

    // Bakiye = borc + dondurulan tazminat; acik kalemler yalnizca taksitler.
    expect((await w.acc(MAIN))!.balance).toBe(TL(2000) + FROZEN);
    expect((await open(w, '2026-11-05')).map((c) => [c.id, c.plan?.no, c.remaining])).toEqual(plan.installments.map((i: any) => [i.chargeId, i.no, i.amount]));
    // Faiz donduruldu: ilk vadeye kadar yeni tazminat yok.
    expect(await fee(w, '2026-11-05')).toBe(0);
    expect(await fee(w, '2026-12-10')).toBe(0);
    // Ilk taksit 30 gun gecikmede: yalnizca anapara payi (50.000) uzerinden %5.
    expect(await fee(w, '2027-01-09')).toBe(2500);
    expect(checkSettlements({ transactions: await w.txs() })).toEqual([]);
  });

  it('idempotent; caride ikinci aktif plan, acik olmayan kalem ve gecmis vade reddedilir', async () => {
    const w = cariWorld();
    await debtor(w);
    const a = await w.call('POST', '/api/finance/plans', manager, await planBody(w));
    const b = await w.call('POST', '/api/finance/plans', manager, await planBody(w));
    expect(b.status).toBe(200);
    expect(b.json.plan.planId).toBe(a.json.plan.planId);
    expect((await w.call('POST', '/api/finance/plans', manager, await planBody(w, { installments: 3 }))).status).toBe(409);
    const second = await w.call('POST', '/api/finance/plans', manager, await planBody(w, { idempotencyKey: 'plan-000002', chargeIds: [a.json.plan.installments[0].chargeId] }));
    expect(second.status).toBe(409);

    const w2 = cariWorld();
    await debtor(w2);
    expect((await w2.call('POST', '/api/finance/plans', manager, await planBody(w2, { chargeIds: ['yok'] }))).status).toBe(400);
    expect((await w2.call('POST', '/api/finance/plans', manager, await planBody(w2, { firstDueDate: '2026-11-01' }))).status).toBe(400);
    expect((await w2.call('POST', '/api/finance/plans', manager, await planBody(w2, { installments: 61 }))).status).toBe(400);
    expect((await w2.call('POST', '/api/finance/plans', manager, await planBody(w2, { rule: { consecutive: 4, total: 3 } }))).status).toBe(400);
    expect((await w2.call('POST', '/api/finance/plans', observer, await planBody(w2))).status).toBe(403);
  });

  it('includeLateFees=false: tazminat yine kesinlesir ama plana girmez (ayri acik kalem)', async () => {
    const w = cariWorld();
    await debtor(w);
    const r = await w.call('POST', '/api/finance/plans', manager, await planBody(w, { includeLateFees: false, installments: 2 }));
    expect(r.status).toBe(201);
    expect(r.json.plan).toMatchObject({ total: TL(2000), frozenLateFee: FROZEN, includeLateFees: false });
    const items = await open(w, '2026-11-05');
    expect(items.filter((c) => !c.plan).map((c) => [c.lateFee, c.remaining])).toEqual([[true, FROZEN]]);
  });
});

describe('yapilandirma - tahsilat, muacceliyet, erken kapama, iptal', () => {
  async function withPlan(w: W, over: Record<string, unknown> = {}) {
    await debtor(w);
    const r = await w.call('POST', '/api/finance/plans', manager, await planBody(w, over));
    expect(r.status).toBe(201);
    return r.json.plan;
  }

  it('tahsilat FIFO ile taksitlere; plan durumu taksit bazinda', async () => {
    const w = cariWorld();
    const plan = await withPlan(w);
    await w.pay('p-1', 600, '2026-12-08');
    const g = await w.call('GET', `/api/finance/plans/${plan.planId}`, observer);
    expect(g.json.state.installments.map((i: any) => [i.no, i.remaining])).toEqual([
      [1, 0],
      [2, 53417 - (TL(600) - 53417)],
      [3, 53417],
      [4, 53416],
    ]);
    expect(g.json.state.paid).toBe(TL(600));
    expect(await fee(w, '2026-12-31')).toBe(0);
  });

  it('temerrut: ek sure dolmadan sayilmaz; 2 ardisik gecikmede isaretlenir ve sakine bildirilir (tek kez)', async () => {
    const w = cariWorld();
    const plan = await withPlan(w);
    // 2. taksit (10 Ocak) 17 Ocak'ta henuz ek surede.
    w.setNow('2027-01-17');
    expect(await w.plans.checkDefaults(APT, '2027-01-17')).toMatchObject({ checked: 1, flagged: [], accelerated: [] });
    w.setNow('2027-01-18');
    const r = await w.plans.checkDefaults(APT, '2027-01-18');
    expect(r.flagged).toEqual([plan.planId]);
    const batch = w.fake.batches.at(-1)!;
    expect(batch.transactions).toEqual([]);
    expect(batch.outbox?.[0]).toMatchObject({
      eventId: `PLAN_DEFAULT:${plan.planId}:2027-01-18`,
      type: 'DUES_REMINDER',
      payload: { items: [{ unitId: 'u1', liableParty: 'occupant', kind: 'plan_default', dueDate: '2026-12-10', amount: TL(2000) + FROZEN }] },
    });
    const g = await w.call('GET', `/api/finance/plans/${plan.planId}`, manager);
    expect(g.json).toMatchObject({ status: 'active', default: { detectedAt: '2027-01-18', overdueNos: [1, 2] }, state: { inDefault: true } });
    // Ayni gun / ertesi gun tekrar: yeni bildirim yok.
    const n = w.fake.batches.length;
    expect((await w.plans.checkDefaults(APT, '2027-01-18')).flagged).toEqual([]);
    expect(w.fake.batches.length).toBe(n);

    // Yonetici onayi ile muaccel kilma.
    const acc = await w.call('POST', `/api/finance/plans/${plan.planId}/accelerate`, manager, { reason: 'Temerrüt - muaccel' });
    expect(acc.status).toBe(200);
    expect(acc.json.plan).toMatchObject({ status: 'accelerated', acceleration: { mode: 'manual', amount: TL(2000) + FROZEN, feeBase: TL(2000) } });
    expect(acc.json.plan).not.toHaveProperty('default');
    expect(acc.json.plan.state.accelerated).toMatchObject({ dueDate: '2027-01-18', remaining: TL(2000) + FROZEN });
    expect(acc.json.plan.state.installments.every((i: any) => i.remaining === 0 && i.settledByAcceleration)).toBe(true);
    expect((await open(w, '2027-01-18')).map((c) => [c.plan?.no, c.remaining])).toEqual([[0, TL(2000) + FROZEN]]);
    expect((await w.call('POST', `/api/finance/plans/${plan.planId}/accelerate`, manager, { reason: 'Tekrar deneme' })).status).toBe(409);
    expect(checkSettlements({ transactions: await w.txs() })).toEqual([]);
  });

  it('temerrut duzelirse isaret kalkar', async () => {
    const w = cariWorld();
    const plan = await withPlan(w);
    w.setNow('2027-01-18');
    await w.plans.checkDefaults(APT, '2027-01-18');
    await w.pay('p-cure', 1100, '2027-01-19');
    w.setNow('2027-01-19');
    expect((await w.plans.checkDefaults(APT, '2027-01-19')).cleared).toEqual([plan.planId]);
    expect((await w.call('GET', `/api/finance/plans/${plan.planId}`, manager)).json).not.toHaveProperty('default');
  });

  it('otomatik muacceliyet: zamanlayici kendisi muaccel kilar (bildirimle ayni atomik yazim)', async () => {
    const w = cariWorld();
    const plan = await withPlan(w, { rule: { autoAccelerate: true, consecutive: 2, total: 3, graceDays: 7 } });
    w.setNow('2027-01-18');
    const r = await w.plans.checkDefaults(APT, '2027-01-18');
    expect(r).toMatchObject({ accelerated: [plan.planId], flagged: [] });
    const batch = w.fake.batches.at(-1)!;
    expect(batch.transactions.map((t) => [t.kind, t.plan?.role])).toEqual([['restructure', 'accelerate']]);
    expect(batch.outbox?.[0]).toMatchObject({ type: 'DUES_REMINDER', payload: { items: [{ kind: 'plan_default' }] } });
    const g = await w.call('GET', `/api/finance/plans/${plan.planId}`, manager);
    expect(g.json).toMatchObject({ status: 'accelerated', acceleration: { mode: 'auto' } });
  });

  it('plana ozel kural: esik ve ek sure planla saklanir ve taramada uygulanir', async () => {
    const w = cariWorld();
    await debtor(w);
    const plan = (await w.call('POST', '/api/finance/plans', manager, await planBody(w, { installments: 6, rule: { consecutive: 3, total: 4, graceDays: 3 } }))).json.plan;
    expect(plan.rule).toEqual({ consecutive: 3, total: 4, graceDays: 3, autoAccelerate: false });
    // 14 Ocak: 1. ve 2. taksit (ek sure 3 gun) gecikmede -> 3 ardisik esigine ulasmadi.
    w.setNow('2027-01-14');
    expect((await w.plans.checkDefaults(APT, '2027-01-14')).flagged).toEqual([]);
    expect((await w.call('GET', `/api/finance/plans/${plan.planId}`, manager)).json.state.overdueNos).toEqual([1, 2]);
    // 14 Subat: 1-3 gecikmede -> temerrut.
    w.setNow('2027-02-14');
    expect((await w.plans.checkDefaults(APT, '2027-02-14')).flagged).toEqual([plan.planId]);
  });

  it('erken kapama: kalan taksitler bugun vadeli tek kaleme alinir (ceza yok)', async () => {
    const w = cariWorld();
    const plan = await withPlan(w);
    await w.pay('p-1', 600, '2026-12-08');
    w.setNow('2026-12-20');
    const r = await w.call('POST', `/api/finance/plans/${plan.planId}/pull-forward`, manager, { reason: 'Borçlu tamamını ödeyecek' });
    expect(r.status).toBe(200);
    expect(r.json.plan).toMatchObject({ status: 'accelerated', acceleration: { mode: 'pull_forward', amount: TL(2000) + FROZEN - TL(600) } });
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ action: 'finance.plan_pull_forward' });
    await w.pay('p-2', (TL(2000) + FROZEN - TL(600)) / 100, '2026-12-20');
    const g = await w.call('GET', `/api/finance/plans/${plan.planId}`, manager);
    expect(g.json.state).toMatchObject({ displayStatus: 'completed', remaining: 0 });
    expect((await w.call('GET', '/api/finance/plans?status=completed', observer)).json.items).toHaveLength(1);
  });

  it('iptal: yapilandirma ters kaydedilir, kalemler ve odemeler FIFO ile geri doner; dondurulan tazminat kalir', async () => {
    const w = cariWorld();
    const plan = await withPlan(w);
    await w.pay('p-1', 600, '2026-12-08');
    w.setNow('2026-12-20');
    const r = await w.call('POST', `/api/finance/plans/${plan.planId}/cancel`, manager, { reason: 'Plan iptal edildi' });
    expect(r.status).toBe(200);
    expect(r.json.plan).toMatchObject({ status: 'cancelled', cancellation: { reason: 'Plan iptal edildi' } });
    const [sep, oct] = await dues(w);
    const items = await open(w, '2026-12-20');
    expect(items.map((c) => [c.id, c.remaining])).toEqual([
      [sep!.transactionId, TL(400)],
      [oct!.transactionId, TL(1000)],
      [plan.transactionIds.lateFee, FROZEN],
    ]);
    expect((await w.acc(MAIN))!.balance).toBe(TL(1400) + FROZEN);
    expect((await w.call('POST', `/api/finance/plans/${plan.planId}/cancel`, manager, { reason: 'Tekrar iptal' })).status).toBe(409);
    // Iptalden sonra ayni kalemlerle yeni plan kurulabilir.
    const again = await w.call('POST', '/api/finance/plans', manager, await planBody(w, { idempotencyKey: 'plan-000009', firstDueDate: '2027-01-10' }));
    expect(again.status).toBe(201);
  });
});

describe('yapilandirma - korumalar ve gorunurluk', () => {
  it('aktif planli caride tasinma kapamasi 409, onizlemede uyari; iptalden sonra serbest', async () => {
    const w = cariWorld();
    await debtor(w);
    const plan = (await w.call('POST', '/api/finance/plans', manager, await planBody(w))).json.plan;
    const pv = await w.call('GET', '/api/finance/units/u1/closures/preview?party=occupant&moveOutDate=2026-11-05');
    expect(pv.json.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/yapılandırma/)]));
    const close = { idempotencyKey: 'close-plan-1', party: 'occupant', moveOutDate: '2026-11-05', userIds: ['tenant-a'], reason: 'Kiracı taşındı' };
    const c1 = await w.call('POST', '/api/finance/units/u1/closures', manager, close);
    expect(c1.status).toBe(409);
    expect(c1.json.message).toMatch(/yapılandırma planı/);
    await w.call('POST', `/api/finance/plans/${plan.planId}/cancel`, manager, { reason: 'Taşınma öncesi iptal' });
    expect((await w.call('POST', '/api/finance/units/u1/closures', manager, { ...close, idempotencyKey: 'close-plan-2' })).status).toBe(201);
  });

  it('plana bagli islemler genel ters kayit ucundan cevrilemez', async () => {
    const w = cariWorld();
    await debtor(w);
    const plan = (await w.call('POST', '/api/finance/plans', manager, await planBody(w))).json.plan;
    const [sep] = await dues(w);
    const a = await w.call('POST', `/api/finance/transactions/${sep!.transactionId}/reversal`, manager, { reason: 'Hatali tahakkuk' });
    expect(a.status).toBe(422);
    expect(a.json.message).toMatch(/yapılandırma/);
    const b = await w.call('POST', `/api/finance/transactions/${plan.transactionIds.open}/reversal`, manager, { reason: 'Hatali plan' });
    expect(b.status).toBe(422);
    const c = await w.call('POST', `/api/finance/transactions/${plan.transactionIds.lateFee}/reversal`, manager, { reason: 'Hatali tazminat' });
    expect(c.status).toBe(422);
  });

  it('sakin portali: kendi caresindeki plan ve taksitler (gerekce/denetim alanlari yok)', async () => {
    const w = cariWorld();
    await debtor(w);
    await w.call('POST', '/api/finance/plans', manager, await planBody(w));
    const r = await w.call('GET', '/api/portal/my-plans', resident);
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ status: 'active', total: TL(2000) + FROZEN, remaining: TL(2000) + FROZEN, inDefault: false });
    expect(r.json.items[0].installments).toHaveLength(4);
    expect(r.json.items[0]).not.toHaveProperty('reason');
    expect(r.json.items[0]).not.toHaveProperty('selected');
    // Portal borclarim: taksitler acik kalem olarak gorunur.
    const d = await w.call('GET', '/api/portal/my-dues', resident);
    expect(d.status).toBe(200);
  });
});

describe('zamanlayici - installment_plans isi', () => {
  it('aktif apartmanlarda plan taramasini Istanbul gunuyle cagirir', async () => {
    const now = new Date('2026-12-01T06:30:00.000Z');
    const site = { siteId: 'apt-1', status: 'active', settings: { ...defaultSiteSettings() } } as unknown as Site;
    const plans = { checkDefaults: vi.fn(async () => ({ checked: 2, flagged: ['p1'], accelerated: [], cleared: [] })) };
    const worker = createSchedulerWorker({
      core: { listSiteIds: async () => ['apt-1', 'apt-2'], getSite: async (id: string) => (id === 'apt-1' ? site : undefined) },
      finance: {} as never,
      plans,
      payments: null,
      payouts: null,
      invoices: null,
      events: createInMemoryEventPublisher(),
      now: () => now,
      log: { info: () => {}, error: () => {} },
    });
    const out = await worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'installment_plans', scheduledTime: '2026-12-01T06:30:00Z' }) }] });
    expect(out).toEqual({ batchItemFailures: [] });
    expect(plans.checkDefaults).toHaveBeenCalledTimes(1);
    expect(plans.checkDefaults).toHaveBeenCalledWith('apt-1', '2026-12-01');
    const outcomes = await worker.runJob({ job: 'installment_plans', scheduledTime: '2026-12-01T06:30:00Z' });
    expect(outcomes).toEqual([
      { apartmentId: 'apt-1', status: 'done', detail: { date: '2026-12-01', checked: 2, flagged: ['p1'], accelerated: [], cleared: [] } },
      { apartmentId: 'apt-2', status: 'skipped', reason: 'site_inactive' },
    ]);
  });
});

describe('bildirim - plan_default', () => {
  it('e-posta sablonu: kalan plan borcu ve geciken ilk taksit vadesi', () => {
    const mail = renderEmail(
      { eventId: 'E1', apartmentId: APT, userId: 'tenant-a', template: 'dues_reminder_plan_default', data: { unitId: 'u1', amount: 213667, dueDate: '2026-12-10' } },
      { siteName: 'Lale Sitesi', recipientName: 'Ayşe', unitLabel: () => 'A Blok - 5', portalUrl: 'https://site.example/app' },
    )!;
    expect(mail.subject).toContain('Taksit planınızda gecikme');
    expect(mail.text).toContain('2.136,67 TL');
    expect(mail.html).toContain('href="https://site.example/app/odeme"');
  });

  it('bildirim worker: sakin alt carisini goren uyeye dues_reminder_plan_default', () => {
    const event = buildEvent({
      eventId: 'PLAN_DEFAULT:p1:2027-01-18',
      type: 'DUES_REMINDER',
      apartmentId: APT,
      actorId: 'system-scheduler',
      payload: { date: '2027-01-18', items: [{ unitId: 'u1', liableParty: 'occupant', kind: 'plan_default', dueDate: '2026-12-10', amount: toKurus(213667) }] },
    });
    const m = (userId: string, relation: 'tenant' | 'owner', residesInUnit: boolean) =>
      ({ userId, apartmentId: APT, unitId: 'u1', relation, residesInUnit, status: 'active', startDate: '2026-01-01' }) as unknown as UnitMembership;
    const out = buildNotifications(event, [m('tenant-a', 'tenant', true), m('owner-o', 'owner', false)], new Map(), '2027-01-18');
    expect(out.map((n) => [n.userId, n.template])).toEqual([['tenant-a', 'dues_reminder_plan_default']]);
  });
});
