/**
 * Finans 2.4-3: raporlar (mizan, gelir-gider, butce-gerceklesen, kesin hesap, borclu listesi,
 * kasa/banka hesap dokumu), kapali aylarin anlik goruntuden okunmasi, PDF onbellegi, Genel Bakis
 * ve API uclari.
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { DocumentError } from '../src/modules/documents/errors.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import type { Budget, BudgetReader } from '../src/modules/finance/budgetModel.js';
import {
  type ReportActivity,
  buildBudgetVsActual,
  buildIncomeExpense,
  buildTrialBalance,
  monthsBetween,
} from '../src/modules/finance/ledgerReports.js';
import { type PeriodCheckSources, createPeriodService } from '../src/modules/finance/periods.js';
import { createReportService } from '../src/modules/finance/reportService.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Account } from '../src/modules/finance/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeFiscalRepo } from './fakes/fiscalRepo.js';

const APT = 'apt-1';
const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };

function unit(id: string, blockId = 'b1'): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId,
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 1,
  } as Unit;
}

function budget(lines: Budget['lines']): Budget {
  return {
    PK: `APT#${APT}`,
    SK: 'BUDGET#2026#v001',
    entityType: 'BUDGET',
    budgetId: '2026-r1',
    apartmentId: APT,
    year: 2026,
    revision: 1,
    status: 'approved',
    lines,
    decision: { ref: 'GK-2026/1', date: '2026-01-10' },
    approvedAt: '2026-01-10T10:00:00.000Z',
    approvedBy: 'mgr-1',
    createdAt: '2026-01-05T00:00:00.000Z',
    createdBy: 'mgr-1',
    updatedAt: '2026-01-10T10:00:00.000Z',
    updatedBy: 'mgr-1',
    version: 2,
  } as unknown as Budget;
}

function world(nowIso = '2026-11-25T09:00:00.000Z') {
  const now = new Date(nowIso);
  const fake = createFakeFinanceRepo(APT);
  const fiscal = createFakeFiscalRepo(fake.docs);
  const units = [unit('u1'), unit('u2', 'b2')];
  const blocks = [{ blockId: 'b1', name: 'A Blok' }, { blockId: 'b2', name: 'B Blok' }] as Block[];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => units.find((u) => u.unitId === id), listUnits: async () => units };
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core, now: () => now, newId: () => `id${String(++n).padStart(4, '0')}` });
  const src = { review: 0, bank: 0, offsets: 0, meter: [] as { periodId: string; name: string; status: string; endDate: string }[] };
  const sources: PeriodCheckSources = {
    meterPeriods: async () => src.meter,
    reviewPayments: async () => src.review,
    unmatchedBankLines: async () => src.bank,
    pendingOffsetRequests: async () => src.offsets,
    lateFeeSettings: async () => ({ monthlyBasisPoints: 0 }),
  };
  const periods = createPeriodService({ finance: fake.repo, fiscal: fiscal.repo, sources, now: () => now });
  const budgets = { current: undefined as Budget | undefined };
  const budgetReader: BudgetReader = { approvedFor: async (_a, year) => (budgets.current?.year === year ? budgets.current : undefined) } as BudgetReader;
  const { store, objects } = createMemoryDocumentStore();
  const listTransactions = vi.spyOn(fake.repo, 'listTransactions');
  const reports = createReportService({
    finance: fake.repo,
    fiscal: fiscal.repo,
    budgets: budgetReader,
    ledger: finance,
    core: {
      getSite: async () => ({ siteId: APT, name: 'Hamravat Villaları' }) as Site,
      listUnits: async () => units,
      listBlocks: async () => blocks,
    },
    sources,
    store,
    now: () => now,
  });
  let k = 0;
  const charge = (unitId: string, date: string, amount: number) =>
    finance.chargeUnit(ctx, { idempotencyKey: `dues-key-${++k}`, unitId, liableParty: 'owner', amount, date, dueDate: date, description: `Aidat ${date}` });
  const pay = (unitId: string, paidAt: string, amount: number) =>
    finance.recordPayment(ctx, { idempotencyKey: `pay-key-${++k}`, unitId, liableParty: 'owner', amount, method: 'cash', paidAt });
  const expense = (date: string, amount: number, expenseAccountId = 'exp-cleaning') =>
    finance.recordExpense(ctx, { idempotencyKey: `exp-key-${++k}`, expenseAccountId, amount, date, description: 'Temizlik' });
  const close = async (period: string) =>
    periods.close(ctx, period, { expectedLockVersion: (await fiscal.repo.getLock(APT))?.version ?? 0, acknowledgeWarnings: [] });

  /** Eylul-Kasim 2026: iki daire, tahsilat ve gider. */
  async function seed() {
    for (const m of ['09', '10', '11']) {
      await charge('u1', `2026-${m}-01`, 100000);
      await charge('u2', `2026-${m}-01`, 100000);
    }
    await pay('u1', '2026-09-10', 100000);
    await pay('u1', '2026-11-10', 50000);
    await pay('u2', '2026-10-05', 100000);
    await expense('2026-10-15', 30000);
    await expense('2026-11-03', 12000, 'exp-elevator');
  }
  return { fake, fiscal, finance, periods, reports, src, budgets, objects, listTransactions, seed, close, charge, pay, expense };
}

// ---------------------------------------------------------------------------
// Saf olusturucular
// ---------------------------------------------------------------------------

describe('rapor olusturucular (saf)', () => {
  const accounts = [
    { accountId: 'cash', type: 'cash', name: 'Kasa', status: 'active', balance: 0, code: '100' },
    { accountId: 'recv', type: 'receivable', name: 'Daire 1', status: 'active', balance: 0 },
    { accountId: 'inc', type: 'income', name: 'Aidat Gelirleri', status: 'active', balance: 0, code: '600' },
    { accountId: 'exp', type: 'expense', name: 'Temizlik', status: 'active', balance: 0, code: '770' },
    { accountId: 'exp2', type: 'expense', name: 'Asansör', status: 'active', balance: 0 },
  ] as Account[];
  const activity: ReportActivity = {
    accounts,
    months: ['2026-01', '2026-02'],
    opening: new Map([['cash', 50000], ['inc', -50000]]),
    byMonth: new Map([
      ['2026-01', new Map([['recv', { debit: 100000, credit: 80000 }], ['inc', { debit: 0, credit: 100000 }], ['cash', { debit: 80000, credit: 20000 }], ['exp', { debit: 20000, credit: 0 }]])],
      ['2026-02', new Map([['recv', { debit: 100000, credit: 0 }], ['inc', { debit: 0, credit: 100000 }]])],
    ]),
    closedMonths: ['2026-01'],
  };

  it('ay araligi yil sinirini gecer', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-03', '2026-03')).toEqual(['2026-03']);
  });

  it('mizan: acilis + borc - alacak = kapanis, borc = alacak, dengede', () => {
    const tb = buildTrialBalance(activity);
    const cash = tb.rows.find((r) => r.accountId === 'cash');
    expect(cash).toMatchObject({ code: '100', opening: 50000, debit: 80000, credit: 20000, closing: 110000 });
    expect(tb.rows.find((r) => r.accountId === 'inc')).toMatchObject({ opening: -50000, credit: 200000, closing: -250000 });
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.balanced).toBe(true);
    // Hareketi ve bakiyesi olmayan hesap listelenmez.
    expect(tb.rows.some((r) => r.accountId === 'exp2')).toBe(false);
  });

  it('gelir-gider: aylik kolonlar ve donem sonucu', () => {
    const ie = buildIncomeExpense(activity);
    expect(ie.income).toEqual([expect.objectContaining({ accountId: 'inc', months: [100000, 100000], total: 200000 })]);
    expect(ie.expense).toEqual([expect.objectContaining({ accountId: 'exp', months: [20000, 0], total: 20000 })]);
    expect(ie.totals).toMatchObject({ incomeTotal: 200000, expenseTotal: 20000, resultTotal: 180000, result: [80000, 100000] });
  });

  it('butce-gerceklesen: donem sonuna kadar fark ve sapma; butcede olmayan gerceklesen kalem eklenir', () => {
    const r = buildBudgetVsActual({
      activity: { ...activity, byMonth: new Map([...activity.byMonth, ['2026-02', new Map([...(activity.byMonth.get('2026-02') ?? []), ['exp2', { debit: 5000, credit: 0 }]])]]) },
      lines: [
        { accountId: 'inc', kind: 'income', months: [90000, 90000] },
        { accountId: 'exp', kind: 'expense', months: [10000, 10000] },
      ],
      throughIndex: 0,
    });
    expect(r.throughMonth).toBe('2026-01');
    const exp = r.lines.find((l) => l.accountId === 'exp');
    expect(exp).toMatchObject({ budgetYtd: 10000, actualYtd: 20000, variance: 10000, variancePct: 100, budgetTotal: 20000 });
    expect(r.lines.find((l) => l.accountId === 'exp2')).toMatchObject({ kind: 'expense', budgetTotal: 0, actualTotal: 5000 });
    expect(r.lines[0]?.kind).toBe('income');
    expect(r.totals.income).toMatchObject({ budget: 180000, actual: 200000, budgetYtd: 90000, actualYtd: 100000 });
  });
});

// ---------------------------------------------------------------------------
// Servis: kapali + acik aylar
// ---------------------------------------------------------------------------

describe('rapor servisi', () => {
  it('kapali aylar anlik goruntuden okunur; sonuc kapanis oncesiyle birebir ayni', async () => {
    const w = world();
    await w.seed();
    const before = await w.reports.trialBalance(ctx, { from: '2026-09', to: '2026-11' });
    const ieBefore = await w.reports.incomeExpense(ctx, { year: '2026' });

    await w.close('2026-09');
    await w.close('2026-10');
    w.listTransactions.mockClear();

    const after = await w.reports.trialBalance(ctx, { from: '2026-09', to: '2026-11' });
    expect(after.rows).toEqual(before.rows);
    expect(after.closedMonths).toEqual(['2026-09', '2026-10']);
    expect(after.balanced).toBe(true);
    expect((await w.reports.incomeExpense(ctx, { year: '2026' })).totals).toEqual(ieBefore.totals);

    // Ekim-Kasim: acilis Eylul kapanisindan, yalnizca acik Kasim taranir.
    w.listTransactions.mockClear();
    const late = await w.reports.trialBalance(ctx, { from: '2026-10', to: '2026-11' });
    expect(w.listTransactions.mock.calls.map(([, q]) => q)).toEqual([{ from: '2026-11-01', to: '2026-11-30' }]);
    expect(late.rows.find((r) => r.accountId === 'cash')).toMatchObject({ opening: 100000, debit: 150000, credit: 42000, closing: 208000 });
  });

  it('kesin hesap: fonlar, sonuc, alacaklar; butce toplamlari', async () => {
    const w = world();
    await w.seed();
    w.budgets.current = budget([
      { accountId: 'income-dues', kind: 'income', months: Array(12).fill(200000) },
      { accountId: 'exp-cleaning', kind: 'expense', months: Array(12).fill(25000) },
    ]);
    const r = await w.reports.annualStatement(ctx, { year: '2026' });
    expect(r.funds).toMatchObject({ opening: 0, closing: 208000 });
    expect(r.income.total).toBe(600000);
    expect(r.expense.total).toBe(42000);
    expect(r.result).toBe(558000);
    expect(r.receivables.closing).toBe(350000);
    expect(r.budget).toEqual({ income: 2400000, expense: 300000, result: 2100000 });
    expect(r.yearClosed).toBe(false);
  });

  it('butce-gerceklesen: onayli butce yoksa null, yil icinde bugunun ayina kadar', async () => {
    const w = world();
    await w.seed();
    expect((await w.reports.budgetVsActual(ctx, { year: '2026' })).budget).toBeNull();
    w.budgets.current = budget([{ accountId: 'exp-cleaning', kind: 'expense', months: Array(12).fill(10000) }]);
    const r = await w.reports.budgetVsActual(ctx, { year: '2026' });
    expect(r.budget).toMatchObject({ revision: 1, decision: { ref: 'GK-2026/1' } });
    expect(r.throughMonth).toBe('2026-11');
    expect(r.lines.find((l) => l.accountId === 'exp-cleaning')).toMatchObject({ budgetYtd: 110000, actualYtd: 30000, variance: -80000 });
    await expect(w.reports.budgetVsActual(ctx, { year: '1999' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('borclu listesi: blok etiketi, vadesi gecen tutara gore sirali, toplamlar', async () => {
    const w = world();
    await w.seed();
    const r = await w.reports.debtors(ctx);
    expect(r.items.map((i) => [i.label, i.balance])).toEqual([
      ['B Blok · U2', 200000],
      ['A Blok · U1', 150000],
    ]);
    expect(r.totals).toMatchObject({ balance: 350000, count: 2 });
  });

  it('kasa dokumu: devreden bakiye, yuruyen bakiye; kasa/banka disi hesap reddedilir', async () => {
    const w = world();
    await w.seed();
    const r = await w.reports.fundsLedger(ctx, { accountId: 'cash', from: '2026-10-01', to: '2026-11-30' });
    expect(r.opening).toBe(100000);
    expect(r.rows.map((x) => [x.date, x.in, x.out, x.balance])).toEqual([
      ['2026-10-05', 100000, 0, 200000],
      ['2026-10-15', 0, 30000, 170000],
      ['2026-11-03', 0, 12000, 158000],
      ['2026-11-10', 50000, 0, 208000],
    ]);
    expect(r).toMatchObject({ closing: 208000, totals: { in: 150000, out: 42000 } });
    await expect(w.reports.fundsLedger(ctx, { accountId: 'income-dues' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.reports.fundsLedger(ctx, { accountId: 'cash', from: '2026-12-01', to: '2026-11-01' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('Genel Bakis: fonlar, bu ay tahakkuk/tahsilat, 12 aylik seri, butce kullanimi, bekleyen isler', async () => {
    const w = world();
    await w.seed();
    w.budgets.current = budget([{ accountId: 'exp-cleaning', kind: 'expense', months: Array(12).fill(10000) }]);
    w.src.review = 1;
    w.src.meter = [{ periodId: 'mp1', name: 'Ekim su', status: 'calculated', endDate: '2026-10-31' }];
    const d = await w.reports.dashboard(ctx);
    expect(d.funds).toMatchObject({ cash: 208000, total: 208000 });
    expect(d.thisMonth).toEqual({ period: '2026-11', charged: 200000, collected: 50000, collectionRatePct: 25 });
    expect(d.series).toHaveLength(12);
    expect(d.series.at(-1)).toMatchObject({ period: '2026-11', income: 200000, expense: 12000 });
    expect(d.budget).toMatchObject({ expenseBudgetYtd: 110000, expenseActualYtd: 42000, utilizationPct: 38.18 });
    expect(d.pending.map((p) => p.code)).toEqual(['payment_review', 'meter_pending', 'periods_never_closed']);

    w.src.review = 0;
    await w.close('2026-09');
    const d2 = await w.reports.dashboard(ctx);
    expect(d2.lockedThrough).toBe('2026-09-30');
    expect(d2.pending.find((p) => p.code === 'periods_unclosed')).toMatchObject({ count: 1 });
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

describe('rapor PDF', () => {
  it('her rapor PDF uretir; ayni veri ayni dosyayi yeniden kullanir, veri degisince yeni dosya', async () => {
    const w = world();
    await w.seed();
    for (const [kind, q] of [
      ['trial-balance', {}],
      ['income-expense', { year: '2026' }],
      ['budget-vs-actual', { year: '2026' }],
      ['annual-statement', { year: '2026' }],
      ['debtors', {}],
      ['funds-ledger', { accountId: 'cash', from: '2026-09-01' }],
    ] as const) {
      const r = await w.reports.pdf(ctx, kind, q);
      expect(r.url).toMatch(new RegExp(`^memory://get/apartments/${APT}/reports/2026/11/finance-${kind}-`));
      expect(r.contentType).toBe('application/pdf');
    }
    expect(w.objects.size).toBe(6);
    const head = [...w.objects.values()][0]?.body.slice(0, 5);
    expect(Buffer.from(head ?? []).toString()).toBe('%PDF-');

    const a = await w.reports.pdf(ctx, 'debtors', {});
    expect(w.objects.size).toBe(6);
    await w.pay('u2', '2026-11-20', 10000);
    const b = await w.reports.pdf(ctx, 'debtors', {});
    expect(b.url).not.toBe(a.url);
    expect(w.objects.size).toBe(7);
  });

  it('bilinmeyen rapor 400; belge deposu yoksa 503', async () => {
    const w = world();
    await expect(w.reports.pdf(ctx, 'nope', {})).rejects.toBeInstanceOf(ValidationError);
    const noStore = createReportService({ ledger: w.finance, finance: w.fake.repo, fiscal: w.fiscal.repo, store: undefined });
    await expect(noStore.pdf(ctx, 'debtors', {})).rejects.toBeInstanceOf(DocumentError);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe('API uclari', () => {
  it('denetci raporlari ve Genel Bakisi okur; sakin okuyamaz; PDF link doner', async () => {
    const w = world();
    await w.seed();
    const app = createApp({
      version: 'test',
      financeService: w.finance,
      reportService: w.reports,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const get = async (path: string, role: string) => {
      const res = await app.request(path, { headers: { 'x-test-claims': JSON.stringify({ userId: 'u-x', role, apartmentId: APT }) } });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    expect(await get('/api/finance/reports/trial-balance?from=2026-09&to=2026-11', 'observer')).toMatchObject({ status: 200, json: { balanced: true } });
    expect(await get('/api/finance/reports/debtors', 'management_company')).toMatchObject({ status: 200, json: { totals: { count: 2 } } });
    expect((await get('/api/finance/reports/income-expense?year=abc', 'observer')).status).toBe(400);
    expect((await get('/api/finance/reports/funds-ledger?accountId=cash&format=pdf', 'observer')).json.url).toMatch(/^memory:\/\/get\//);
    expect((await get('/api/finance/dashboard', 'apartment_manager')).json).toMatchObject({ funds: { total: 208000 } });
    expect((await get('/api/finance/dashboard', 'resident')).status).toBe(403);
    expect((await get('/api/finance/reports/annual-statement', 'building_staff')).status).toBe(403);
  });
});
