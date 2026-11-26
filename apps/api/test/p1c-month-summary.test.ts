/**
 * P1-c: acik aylarin hesap-ay hareket ozeti (`MSUM#<YYYY-MM>#<hesap>`).
 *
 * Buyuk olcek dogrulamasi: 1.200 bolum x 3 acik ay (tahakkuk + kismi tahsilat + gider).
 *  - Yeni site ozetle dogar (`MSUMSTATE.ready`, source `new_site`); mizan, gelir-gider, butce-
 *    gerceklesen ve Genel Bakis acik aylari ozetten okur, islem (TX) aralik taramasi YAPMAZ.
 *  - P1-c oncesi veri taklidi (ozet ve isaret yok): raporlar eski tam tarama yoluna duser ve
 *    AYNI sonucu verir; ardindan canli (yeni) yazimlarla karisik defter olusur.
 *  - `backfill:month-summary` dry-run / verify / apply: eski toplamlari doldurur, defterle birebir
 *    karsilastirir, ancak fark yoksa siteyi hazir isaretler; sonrasi raporlar ozetten ve kurusu
 *    kurusuna ayni. Bozulmus ozet --verify ile yakalanir.
 *  - Defter (TX/LE) ve bakiyeler hicbir adimda degismez; silme yazimi yok.
 */
import { describe, expect, it, vi } from 'vitest';
import { backfillMonthSummary } from '../scripts/backfill-month-summary.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import type { Budget, BudgetReader } from '../src/modules/finance/budgetModel.js';
import { type MonthSummaryRepo, monthTotals } from '../src/modules/finance/monthSummary.js';
import type { PeriodCheckSources } from '../src/modules/finance/periods.js';
import { createReportService } from '../src/modules/finance/reportService.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeFiscalRepo } from './fakes/fiscalRepo.js';

const APT = 'apt-1';
const UNITS = 1200;
const MONTHS = ['2026-09', '2026-10', '2026-11'];
const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };

function unit(i: number): Unit {
  const id = `u${String(i).padStart(4, '0')}`;
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: `b${i % 12}`,
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

const budget = {
  PK: `APT#${APT}`,
  SK: 'BUDGET#2026#v001',
  entityType: 'BUDGET',
  budgetId: '2026-r1',
  apartmentId: APT,
  year: 2026,
  revision: 1,
  status: 'approved',
  lines: [
    { accountId: 'income-dues', kind: 'income', months: Array(12).fill(80_000_000) },
    { accountId: 'exp-cleaning', kind: 'expense', months: Array(12).fill(5_000_000) },
  ],
  decision: { ref: 'GK-2026/1', date: '2026-01-10' },
  approvedAt: '2026-01-10T10:00:00.000Z',
  approvedBy: 'mgr-1',
  createdAt: '2026-01-05T00:00:00.000Z',
  createdBy: 'mgr-1',
  updatedAt: '2026-01-10T10:00:00.000Z',
  updatedBy: 'mgr-1',
  version: 2,
} as unknown as Budget;

function world() {
  const now = new Date('2026-11-25T09:00:00.000Z');
  const fake = createFakeFinanceRepo(APT);
  const fiscal = createFakeFiscalRepo(fake.docs);
  const units = Array.from({ length: UNITS }, (_, i) => unit(i + 1));
  const byId = new Map(units.map((u) => [u.unitId, u]));
  const blocks = Array.from({ length: 12 }, (_, i) => ({ blockId: `b${i}`, name: `${i + 1}. Blok` })) as Block[];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => byId.get(id), listUnits: async () => units };
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core, now: () => now, newId: () => `id${String(++n).padStart(6, '0')}` });
  const sources: PeriodCheckSources = {
    meterPeriods: async () => [],
    reviewPayments: async () => 0,
    unmatchedBankLines: async () => 0,
    pendingOffsetRequests: async () => 0,
    lateFeeSettings: async () => ({ monthlyBasisPoints: 0 }),
  };
  const budgets: BudgetReader = { approvedFor: async (_a, year) => (year === 2026 ? budget : undefined) } as BudgetReader;
  const { store } = createMemoryDocumentStore();
  const listTransactions = vi.spyOn(fake.repo, 'listTransactions');
  const reports = createReportService({
    finance: fake.repo,
    fiscal: fiscal.repo,
    budgets,
    ledger: finance,
    core: { getSite: async () => ({ siteId: APT, name: 'Örnek Site' }) as Site, listUnits: async () => units, listBlocks: async () => blocks },
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
    finance.recordExpense(ctx, { idempotencyKey: `exp-key-${++k}`, expenseAccountId, amount, date, description: 'Gider' });

  /** 1.200 bolum x 3 ay: degisken aidat, 3 bolumden 2'sine kismi tahsilat, ayda 3 gider. */
  async function seed() {
    for (const [mi, m] of MONTHS.entries()) {
      for (const [i, u] of units.entries()) await charge(u.unitId, `${m}-01`, 50_000 + (i % 7) * 1_250 + mi * 100);
      for (const [i, u] of units.entries()) if (i % 3 !== 0) await pay(u.unitId, `${m}-${String(5 + (i % 20)).padStart(2, '0')}`, 30_000 + (i % 5) * 333);
      await expense(`${m}-10`, 1_234_567);
      await expense(`${m}-15`, 765_433, 'exp-elevator');
      await expense(`${m}-20`, 99_999);
    }
  }

  async function snapshot() {
    return {
      tb: await reports.trialBalance(ctx, { from: '2026-09', to: '2026-11' }),
      tbNov: await reports.trialBalance(ctx, { from: '2026-11', to: '2026-11' }),
      ie: await reports.incomeExpense(ctx, { year: '2026' }),
      bva: await reports.budgetVsActual(ctx, { year: '2026' }),
      dash: await reports.dashboard(ctx),
    };
  }

  /** P1-c oncesi veri taklidi: ozet ogeleri, isaret ve "canli sayildi" bilgisi hic yazilmamis. */
  function forgetMonthSummaries() {
    fake.monthSummaries.clear();
    fake.monthStates.clear();
    fake.msCounted.clear();
  }

  const isCounted = (tx: Transaction) => fake.msCounted.has(`${APT}|${tx.transactionId}`);
  const backfill = (mode: 'apply' | 'dry-run' | 'verify') =>
    backfillMonthSummary(
      { core: { listSiteIds: async () => [APT] }, finance: fake.repo as unknown as MonthSummaryRepo, isCounted, log: { info: () => {} } },
      { mode },
    );
  const summaryItems = () => [...fake.monthSummaries.values()];

  return { fake, reports, listTransactions, seed, snapshot, forgetMonthSummaries, backfill, pay, units, summaryItems };
}

describe('P1-c hesap-ay ozeti (1.200 bolum x 3 acik ay)', () => {
  it('ozet = tam tarama; eski veri backfill ile birebir doldurulur; raporlar TX taramasi yapmaz', { timeout: 300_000 }, async () => {
    const w = world();
    await w.seed();
    const txCount = w.fake.msCounted.size;
    expect(txCount).toBe(MONTHS.length * (UNITS + 800 + 3));

    // 1) Yeni site ozetle dogdu; tum acik aylar ozetten okunur.
    expect(w.fake.monthStates.get(APT)).toMatchObject({ ready: true, source: 'new_site' });
    w.listTransactions.mockClear();
    const viaSummary = await w.snapshot();
    expect(w.listTransactions).not.toHaveBeenCalled();
    expect(viaSummary.tb.balanced).toBe(true);
    expect(viaSummary.tb.closedMonths).toEqual([]);
    // Ozet ogesi sayisi (ay x dokunulan hesap): bolum basina ay basina 1 alacak hesabi.
    expect(w.summaryItems().filter((m) => m.accountId.startsWith('recv-')).length).toBe(UNITS * MONTHS.length);

    // 2) Ayni defter, P1-c oncesi gibi: isaret yok -> eski tam tarama yolu, sonuc birebir ayni.
    const recvBefore = w.fake.balanceOf('recv-u0001-owner');
    w.forgetMonthSummaries();
    w.listTransactions.mockClear();
    const viaScan = await w.snapshot();
    expect(w.listTransactions).toHaveBeenCalled();
    expect(viaScan).toEqual(viaSummary);

    // 3) Dagitim sonrasi yeni yazimlar canli ozete sayilir -> karisik (eski + canli) defter.
    for (const u of w.units.slice(0, 300)) await w.pay(u.unitId, '2026-11-24', 1_001);
    const mixedScan = await w.snapshot();
    expect(w.fake.msCounted.size).toBe(300);
    expect(w.fake.monthStates.get(APT)).toBeUndefined(); // eski site: otomatik hazir isaretlenmez
    expect(mixedScan.dash.thisMonth.collected).toBe(viaScan.dash.thisMonth.collected + 300 * 1_001);

    // 4) dry-run: yazmaz, isaretlemez, uyusmazlik yok.
    const dry = await w.backfill('dry-run');
    expect(dry).toMatchObject({ sites: 1, ready: 0, legacyTransactions: txCount, legacyWritten: 0, mismatchedSites: [] });
    expect(w.fake.monthStates.get(APT)).toBeUndefined();
    expect(w.summaryItems().every((m) => m.ld === undefined && m.lc === undefined)).toBe(true);

    // 5) verify (doldurmadan once): yazmaz; eski toplamlar eksik oldugundan fark ve "hazir degil" raporlar.
    expect(await w.backfill('verify')).toMatchObject({ ready: 0, notReady: [APT], mismatchedSites: [APT] });
    expect(w.summaryItems().every((m) => m.ld === undefined)).toBe(true);

    // 6) apply: eski toplamlar SET, defterle birebir, site hazir (source backfill).
    const applied = await w.backfill('apply');
    expect(applied).toMatchObject({ sites: 1, ready: 1, legacyTransactions: txCount, mismatchedSites: [], notReady: [] });
    expect(applied.legacyWritten).toBeGreaterThanOrEqual(UNITS * MONTHS.length);
    expect(w.fake.monthStates.get(APT)).toMatchObject({ ready: true, source: 'backfill' });

    w.listTransactions.mockClear();
    const afterBackfill = await w.snapshot();
    expect(w.listTransactions).not.toHaveBeenCalled();
    expect(afterBackfill).toEqual(mixedScan);

    // Kasim tahsilati (Genel Bakis) = canli + eski toplamlarin birlesimi.
    const novCash = w.summaryItems().find((m) => m.month === '2026-11' && m.accountId === 'cash')!;
    expect(novCash.p).toBe(300 * 1_001);
    expect(monthTotals(novCash).p).toBe(afterBackfill.dash.thisMonth.collected);

    // 7) Tekrar calistirma ayni degerleri yazar (dondurulmus eski kume); verify temiz.
    const frozen = JSON.stringify(w.summaryItems().map(({ updatedAt: _u, ...rest }) => rest));
    await w.backfill('apply');
    expect(JSON.stringify(w.summaryItems().map(({ updatedAt: _u, ...rest }) => rest))).toBe(frozen);
    expect(await w.backfill('verify')).toMatchObject({ ready: 1, mismatchedSites: [], notReady: [] });

    // 8) Bozulmus ozet (1 kurus) --verify ile yakalanir.
    const victim = w.summaryItems().find((m) => m.month === '2026-10' && m.accountId === 'income-dues')!;
    w.fake.monthSummaries.set(`${APT}|2026-10|income-dues`, { ...victim, c: (victim.c ?? 0) + 1 });
    expect((await w.backfill('verify')).mismatchedSites).toEqual([APT]);

    // Defter ve bakiyeler degismedi (yalnizca 300 yeni tahsilat eklendi).
    expect(w.fake.balanceOf('recv-u0001-owner')).toBe(recvBefore - 1_001);
  });
});
