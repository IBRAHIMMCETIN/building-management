/**
 * Finans 2.4-3 - Rapor servisi: mizan, gelir-gider, butce-gerceklesen, kesin hesap, borclu
 * listesi, kasa/banka hesap dokumu, PDF ciktilari (S3 onbellek + imzali link) ve Genel Bakis.
 *
 * Veri kaynagi (plan: claude/finans-2-4-donem-kapanisi-butce-plani.md):
 *  - Kapali aylar `FPERIOD#` anlik goruntusunden (tam defter taramasi yok).
 *  - Acik aylar tek bir TX# tarih araligi sorgusundan.
 *  - Acilis: onceki ay kapaliysa onun kapanisi; degilse en yakin onceki kapanis + aradaki
 *    hareketler; hic kapanis yoksa baslangic oncesi tum hareketler (bir kerelik maliyet).
 *  - Hesap dokumu LE# hesap okuyucusuyla (yalnizca o hesabin satirlari).
 */
import { createHash } from 'node:crypto';
import type { CoreRepository } from '../core/repository.js';
import { coreRepository } from '../core/repository.js';
import type { IsoDate } from '../core/types.js';
import { ValidationError, assertId } from '../core/validation.js';
import { DocumentError } from '../documents/errors.js';
import { contentDisposition, financeReportKey } from '../documents/keys.js';
import { formatDateTR, formatTRY } from '../documents/receiptPdf.js';
import { REPORT_TEMPLATE_VERSION, type ReportPdfData, type ReportRow, renderReportPdf } from '../documents/reportPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import { type BudgetReader, budgetReader } from './budgetModel.js';
import {
  type Movement,
  type ReportActivity,
  buildAnnualStatement,
  buildBudgetVsActual,
  buildFundsLedger,
  buildIncomeExpense,
  buildTrialBalance,
  monthsBetween,
} from './ledgerReports.js';
import { nextPeriod, periodBounds, previousPeriod } from './lateFee.js';
import { type FiscalPeriod, formatPeriodTr, netByAccount } from './periodLock.js';
import { monthTotals } from './monthSummary.js';
import { type FiscalRepository, fiscalRepository } from './periodRepository.js';
import { type PeriodCheckSources, defaultPeriodSources } from './periods.js';
import { type FinanceRepository, batchGetTransactions, financeRepository, queryAccountEntries } from './repository.js';
import type { FinanceService } from './service.js';
import type { Transaction } from './types.js';

export type ReportContext = { apartmentId: string; userId: string };

/** Ayin tahakkuku (gelir hesaplarina net alacak) ve tahsilati (tahsilat islemlerinin kasa/banka girisi). */
export type MonthCollection = { period: string; charged: number; collected: number; collectionRatePct?: number };

export function monthCollection(period: string, charged: number, collected: number): MonthCollection {
  return { period, charged, collected, ...(charged > 0 ? { collectionRatePct: Math.round((collected / charged) * 10_000) / 100 } : {}) };
}

export const REPORT_KINDS = ['trial-balance', 'income-expense', 'budget-vs-actual', 'annual-statement', 'debtors', 'funds-ledger'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type ReportServiceDeps = {
  finance: Pick<FinanceRepository, 'listAccounts' | 'listTransactions'> &
    Partial<Pick<FinanceRepository, 'listAccountEntries' | 'getTransactions' | 'getAccount' | 'listMonthSummaries' | 'getMonthSummaryState'>>;
  fiscal: Pick<FiscalRepository, 'listPeriods' | 'getLock'>;
  budgets: BudgetReader;
  ledger: Pick<FinanceService, 'summary' | 'duesStatus'>;
  core: Pick<CoreRepository, 'getSite' | 'listUnits' | 'listBlocks'>;
  sources: PeriodCheckSources;
  store: DocumentStore | undefined;
  now: () => Date;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: IsoDate, n: number): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONTH_SHORT = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const shortMonth = (m: string) => `${MONTH_SHORT[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

function signed(amount: number): string {
  if (amount === 0) return '—';
  return `${formatTRY(Math.abs(amount))} ${amount > 0 ? 'B' : 'A'}`;
}
const tl = (n: number) => (n === 0 ? '—' : formatTRY(n));

export function createReportService(overrides: Partial<ReportServiceDeps> & Pick<ReportServiceDeps, 'ledger'>) {
  const deps: ReportServiceDeps = {
    finance: financeRepository,
    fiscal: fiscalRepository,
    budgets: budgetReader,
    core: coreRepository,
    sources: defaultPeriodSources,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    ...overrides,
  };
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const listEntries = deps.finance.listAccountEntries ?? queryAccountEntries;
  const getTransactions = deps.finance.getTransactions ?? batchGetTransactions;

  // -------------------------------------------------------------------------
  // Veri yukleme
  // -------------------------------------------------------------------------

  const sameVersions = (a: readonly { accountId: string; version: number }[], b: readonly { accountId: string; version: number }[]) => {
    if (a.length !== b.length) return false;
    const v = new Map(a.map((x) => [x.accountId, x.version]));
    return b.every((x) => v.get(x.accountId) === x.version);
  };

  /**
   * P1-c: sitenin hesap-ay ozeti (`MSUM#`) kullanilabilir mi? Site `ready` isaretliyse (backfill
   * dogrulandi veya P1-c sonrasi acildi) ozetler defterle birebirdir; degilse eski yol.
   */
  async function monthSummaryReady(apartmentId: string): Promise<boolean> {
    if (!deps.finance.listMonthSummaries || !deps.finance.getMonthSummaryState) return false;
    return (await deps.finance.getMonthSummaryState(apartmentId))?.ready === true;
  }

  /** (Ay -> hesap -> hareket) ve (ay -> hesap -> tahsilat girisi) ozetten; `toMonth` dahil. */
  async function monthMovements(apartmentId: string, fromMonth: string, toMonth?: string) {
    const items = await (deps.finance.listMonthSummaries as NonNullable<ReportServiceDeps['finance']['listMonthSummaries']>)(apartmentId, fromMonth, toMonth);
    const moves = new Map<string, Map<string, Movement>>();
    const payments = new Map<string, Map<string, number>>();
    for (const item of items) {
      const t = monthTotals(item);
      if (t.d === 0 && t.c === 0 && t.p === 0) continue;
      const bucket = moves.get(item.month) ?? new Map<string, Movement>();
      bucket.set(item.accountId, { debit: t.d, credit: t.c });
      moves.set(item.month, bucket);
      if (t.p) {
        const pb = payments.get(item.month) ?? new Map<string, number>();
        pb.set(item.accountId, t.p);
        payments.set(item.month, pb);
      }
    }
    return { moves, payments };
  }

  /**
   * P1-a: `fromStart` oncesi acilis = canli bakiye - (fromStart ve sonrasi net). Hesaplar, aradaki
   * hareketler (tutarli okuma) ve tekrar hesaplar okunur; surumler degismediyse aradaki yazim yoktur
   * ve sonuc `net(fromStart oncesi tum islemler)` ile birebir aynidir. Es zamanli yazimda tekrar
   * denenir; olmazsa eski yonteme (tam tarama) duser. P1-c: `fromStart` ay basi oldugundan aradaki
   * net hesap-ay ozetinden (ay sayisi kadar kayit) okunur; ozet yoksa islemlerden.
   */
  async function openingFromBalances(apartmentId: string, fromStart: IsoDate, useMsum: boolean): Promise<Map<string, number>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const accounts = await deps.finance.listAccounts(apartmentId);
      let since: Map<string, number>;
      if (useMsum) {
        since = new Map();
        for (const bucket of (await monthMovements(apartmentId, fromStart.slice(0, 7))).moves.values()) {
          for (const [acc, mv] of bucket) since.set(acc, (since.get(acc) ?? 0) + mv.debit - mv.credit);
        }
      } else since = netByAccount((await deps.finance.listTransactions(apartmentId, { from: fromStart, consistent: true })).items);
      if (!sameVersions(accounts, await deps.finance.listAccounts(apartmentId))) continue;
      const opening = new Map<string, number>();
      for (const a of accounts) {
        const value = a.balance - (since.get(a.accountId) ?? 0);
        if (value !== 0) opening.set(a.accountId, value);
      }
      const known = new Set(accounts.map((a) => a.accountId));
      for (const [accountId, net] of since) if (!known.has(accountId) && net !== 0) opening.set(accountId, -net);
      return opening;
    }
    return netByAccount((await deps.finance.listTransactions(apartmentId, { to: addDays(fromStart, -1) })).items);
  }

  /**
   * Rapor verisi. Kapali aylar donem anlik goruntusunden; acik aylar P1-c ile hesap-ay ozetinden
   * (site `ready` ise; yoksa donem islemlerinden - sonuc ayni). `paymentsIn`: ay -> kasa/banka
   * hesaplarina `payment` turu islemlerin borc satirlari toplami (Genel Bakis "tahsilat").
   * `opening: false`: acilis bakiyeleri okunmaz (bos); yalnizca aylik hareket gereken cagiranlar icin
   * (gelir-gider toplamlari acilisi kullanmaz).
   */
  async function loadActivity(
    apartmentId: string,
    fromMonth: string,
    toMonth: string,
    opts: { opening?: boolean } = {},
  ): Promise<ReportActivity & { paymentsIn: Map<string, number> }> {
    const months = monthsBetween(fromMonth, toMonth);
    const [accounts, periods, useMsum] = await Promise.all([deps.finance.listAccounts(apartmentId), deps.fiscal.listPeriods(apartmentId), monthSummaryReady(apartmentId)]);
    const closed = new Map(periods.filter((p) => p.status === 'closed').map((p) => [p.period, p]));
    const closingOf = (p: FiscalPeriod) => new Map(p.snapshot.rows.map((r) => [r.accountId, r.closing]));
    const fromStart = periodBounds(fromMonth).first;
    const fundIds = new Set(accounts.filter((a) => a.type === 'cash' || a.type === 'bank').map((a) => a.accountId));

    // Acilis bakiyeleri
    let opening: Map<string, number>;
    const prev = closed.get(previousPeriod(fromMonth));
    if (opts.opening === false) opening = new Map();
    else if (prev) opening = closingOf(prev);
    else {
      const earlier = [...closed.keys()].filter((m) => m < fromMonth).sort().at(-1);
      if (earlier) {
        const base = closingOf(closed.get(earlier) as FiscalPeriod);
        // Aradaki tam aylar (kapali aydan sonraki aydan rapor basindan onceki aya).
        if (useMsum) {
          for (const bucket of (await monthMovements(apartmentId, nextPeriod(earlier), previousPeriod(fromMonth))).moves.values()) {
            for (const [acc, mv] of bucket) base.set(acc, (base.get(acc) ?? 0) + mv.debit - mv.credit);
          }
        } else {
          const gap = (await deps.finance.listTransactions(apartmentId, { from: addDays(periodBounds(earlier).last, 1), to: addDays(fromStart, -1) })).items;
          for (const [acc, net] of netByAccount(gap)) base.set(acc, (base.get(acc) ?? 0) + net);
        }
        opening = base;
      } else {
        // P1-a: hic kapali ay yoksa acilis = canli bakiye - (rapor basindan bugune net).
        opening = await openingFromBalances(apartmentId, fromStart, useMsum);
      }
    }

    // Aylik hareketler
    const byMonth = new Map<string, Map<string, Movement>>();
    const paymentsIn = new Map<string, number>();
    for (const m of months) {
      const p = closed.get(m);
      if (p) byMonth.set(m, new Map(p.snapshot.rows.map((r) => [r.accountId, { debit: r.debit, credit: r.credit }])));
    }
    const openMonths = months.filter((m) => !closed.has(m));
    if (openMonths.length) {
      // Ardisik acik ay dizileri ayri okunur: kapali aylar (anlik goruntu) yeniden okunmaz.
      const runs: string[][] = [];
      for (const m of openMonths) {
        const run = runs.at(-1);
        if (run && nextPeriod(run.at(-1) as string) === m) run.push(m);
        else runs.push([m]);
      }
      for (const m of openMonths) byMonth.set(m, new Map());
      if (useMsum) {
        // P1-c: acik ay basina hesap sayisi kadar ozet kaydi (islem sayisindan bagimsiz).
        const parts = await Promise.all(runs.map((run) => monthMovements(apartmentId, run[0] as string, run.at(-1) as string)));
        for (const part of parts) {
          for (const [m, bucket] of part.moves) if (byMonth.has(m) && !closed.has(m)) byMonth.set(m, bucket);
          for (const [m, pb] of part.payments) {
            if (closed.has(m)) continue;
            let sum = 0;
            for (const [acc, v] of pb) if (fundIds.has(acc)) sum += v;
            if (sum) paymentsIn.set(m, sum);
          }
        }
      } else {
        const pages = await Promise.all(
          runs.map((run) => deps.finance.listTransactions(apartmentId, { from: periodBounds(run[0] as string).first, to: periodBounds(run.at(-1) as string).last })),
        );
        for (const tx of pages.flatMap((p) => p.items)) {
          const m = tx.date.slice(0, 7);
          const bucket = byMonth.get(m);
          if (!bucket) continue;
          for (const l of tx.lines) {
            const cur = bucket.get(l.accountId) ?? { debit: 0, credit: 0 };
            bucket.set(l.accountId, l.side === 'debit' ? { ...cur, debit: cur.debit + l.amount } : { ...cur, credit: cur.credit + l.amount });
          }
          if (tx.kind === 'payment') {
            const add = tx.lines.filter((l) => l.side === 'debit' && fundIds.has(l.accountId)).reduce((a, l) => a + l.amount, 0);
            if (add) paymentsIn.set(m, (paymentsIn.get(m) ?? 0) + add);
          }
        }
      }
    }
    return { accounts, months, opening, byMonth, closedMonths: months.filter((m) => closed.has(m)), paymentsIn };
  }

  function parseMonth(value: string | undefined, field: string, fallback: string): string {
    if (value === undefined || value === '') return fallback;
    if (!MONTH_RE.test(value)) throw new ValidationError(`${field} YYYY-MM olmali`, field);
    return value;
  }
  function parseYear(value: string | undefined): number {
    if (value === undefined || value === '') return Number(today().slice(0, 4));
    const y = Number(value);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new ValidationError('year 2000-2100 arasinda olmali', 'year');
    return y;
  }
  function parseDate(value: string | undefined, field: string): IsoDate | undefined {
    if (value === undefined || value === '') return undefined;
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ValidationError(`${field} YYYY-MM-DD olmali`, field);
    return value;
  }
  const yearMonths = (y: number) => ({ from: `${y}-01`, to: `${y}-12` });
  /** Yilin "su ana kadarki" son ay indeksi (gecmis yil: 11, gelecek yil: -1). */
  function throughIndex(year: number): number {
    const t = today();
    const y = Number(t.slice(0, 4));
    if (year < y) return 11;
    if (year > y) return -1;
    return Number(t.slice(5, 7)) - 1;
  }

  // -------------------------------------------------------------------------
  // Raporlar
  // -------------------------------------------------------------------------

  async function trialBalance(ctx: ReportContext, q: { from?: string; to?: string }) {
    const current = today().slice(0, 7);
    const to = parseMonth(q.to, 'to', current);
    const from = parseMonth(q.from, 'from', `${to.slice(0, 4)}-01`);
    if (from > to) throw new ValidationError('from, to tarihinden sonra olamaz', 'from');
    const activity = await loadActivity(ctx.apartmentId, from, to);
    return { ...buildTrialBalance(activity), closedMonths: activity.closedMonths };
  }

  async function incomeExpense(ctx: ReportContext, q: { year?: string }) {
    const year = parseYear(q.year);
    const { from, to } = yearMonths(year);
    const activity = await loadActivity(ctx.apartmentId, from, to);
    return { year, ...buildIncomeExpense(activity), closedMonths: activity.closedMonths };
  }

  async function budgetVsActual(ctx: ReportContext, q: { year?: string }) {
    const year = parseYear(q.year);
    const { from, to } = yearMonths(year);
    const [activity, budget] = await Promise.all([loadActivity(ctx.apartmentId, from, to), deps.budgets.approvedFor(ctx.apartmentId, year)]);
    const through = Math.max(throughIndex(year), 0);
    const report = buildBudgetVsActual({ activity, lines: budget?.lines ?? [], throughIndex: through });
    return {
      year,
      budget: budget ? { budgetId: budget.budgetId, revision: budget.revision, ...(budget.decision ? { decision: budget.decision } : {}), approvedAt: budget.approvedAt } : null,
      ...report,
      closedMonths: activity.closedMonths,
    };
  }

  async function annualStatement(ctx: ReportContext, q: { year?: string }) {
    const year = parseYear(q.year);
    const { from, to } = yearMonths(year);
    const [activity, budget] = await Promise.all([loadActivity(ctx.apartmentId, from, to), deps.budgets.approvedFor(ctx.apartmentId, year)]);
    return { year, ...buildAnnualStatement(activity, budget), closedMonths: activity.closedMonths, yearClosed: activity.closedMonths.length === 12 };
  }

  async function debtors(ctx: ReportContext) {
    const [status, blocks] = await Promise.all([deps.ledger.duesStatus(ctx), deps.core.listBlocks(ctx.apartmentId)]);
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const items = status.items
      .filter((i) => i.balance > 0)
      .map((i) => ({
        unitId: i.unitId,
        label: blockName.get(i.blockId) ? `${blockName.get(i.blockId)} · ${i.unitNumber}` : i.unitNumber,
        owner: i.owner.balance,
        occupant: i.occupant.balance,
        former: i.former?.balance ?? 0,
        balance: i.balance,
        overdue: i.overdue,
        lateFee: i.lateFee,
        daysOverdue: i.daysOverdue,
        oldestUnpaidDueDate: i.owner.oldestUnpaidDueDate ?? i.occupant.oldestUnpaidDueDate,
      }))
      .sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
    return {
      asOf: status.asOf,
      items,
      totals: {
        balance: items.reduce((s, i) => s + i.balance, 0),
        overdue: items.reduce((s, i) => s + i.overdue, 0),
        lateFee: items.reduce((s, i) => s + i.lateFee, 0),
        count: items.length,
      },
    };
  }

  async function fundsLedger(ctx: ReportContext, q: { accountId?: string; from?: string; to?: string }) {
    const accountId = assertId(q.accountId, 'accountId');
    const accounts = await deps.finance.listAccounts(ctx.apartmentId);
    const account = accounts.find((a) => a.accountId === accountId);
    if (!account || (account.type !== 'cash' && account.type !== 'bank')) throw new ValidationError('accountId bir kasa veya banka hesabi olmali', 'accountId');
    const to = parseDate(q.to, 'to') ?? today();
    const from = parseDate(q.from, 'from') ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new ValidationError('from, to tarihinden sonra olamaz', 'from');
    // P1-a: kasa/banka "sicak" hesaplardir; acilis tum gecmis satirlarindan degil, canli bakiye -
    // (from ve sonrasi satirlar) ile bulunur. Hesap surumu okuma boyunca degismediyse birebir ayni.
    const net = (list: readonly { side: string; amount: number }[]) => list.reduce((s, e) => s + (e.side === 'debit' ? e.amount : -e.amount), 0);
    let opening: number | undefined;
    let inRange: Awaited<ReturnType<typeof listEntries>> = [];
    let base = account;
    for (let attempt = 0; attempt < 3 && opening === undefined; attempt++) {
      const since = await listEntries(ctx.apartmentId, accountId, { from });
      const again = deps.finance.getAccount
        ? await deps.finance.getAccount(ctx.apartmentId, accountId)
        : (await deps.finance.listAccounts(ctx.apartmentId)).find((a) => a.accountId === accountId);
      if (again && again.version === base.version) {
        opening = base.balance - net(since);
        inRange = since.filter((e) => e.date <= to);
      } else if (again) base = again;
    }
    if (opening === undefined) {
      const [before, range] = await Promise.all([listEntries(ctx.apartmentId, accountId, { to: addDays(from, -1) }), listEntries(ctx.apartmentId, accountId, { from, to })]);
      opening = net(before);
      inRange = range;
    }
    const txs = inRange.length ? await getTransactions(ctx.apartmentId, [...new Set(inRange.map((e) => e.transactionId))]) : [];
    return {
      account: { accountId, name: account.name, type: account.type, ...(account.code ? { code: account.code } : {}) },
      from,
      to,
      ...buildFundsLedger({ opening, entries: inRange, transactions: new Map(txs.map((t) => [t.transactionId, t])) }),
    };
  }

  // -------------------------------------------------------------------------
  // Genel Bakis
  // -------------------------------------------------------------------------

  async function dashboard(ctx: ReportContext) {
    const t = today();
    const current = t.slice(0, 7);
    const year = Number(t.slice(0, 4));
    let first = current;
    for (let i = 0; i < 11; i++) first = previousPeriod(first);
    const [summary, activity, budget, lock, sources] = await Promise.all([
      deps.ledger.summary(ctx),
      loadActivity(ctx.apartmentId, first, current),
      deps.budgets.approvedFor(ctx.apartmentId, year),
      deps.fiscal.getLock(ctx.apartmentId),
      Promise.all([
        deps.sources.reviewPayments(ctx.apartmentId),
        deps.sources.pendingOffsetRequests(ctx.apartmentId),
        deps.sources.meterPeriods(ctx.apartmentId),
      ]),
    ]);
    const ie = buildIncomeExpense(activity);
    const series = activity.months.map((m, i) => ({ period: m, income: ie.totals.income[i] ?? 0, expense: ie.totals.expense[i] ?? 0, result: ie.totals.result[i] ?? 0 }));

    const thisMonth = monthCollection(current, series.at(-1)?.income ?? 0, activity.paymentsIn.get(current) ?? 0);

    // Butce kullanimi: yilbasindan bu aya kadar gider butcesi vs gerceklesen.
    let budgetInfo: { year: number; expenseBudgetYtd: number; expenseActualYtd: number; utilizationPct?: number } | null = null;
    if (budget) {
      const yearActivity = { ...activity, months: activity.months.filter((m) => m.startsWith(String(year))) };
      const bva = buildBudgetVsActual({ activity: yearActivity, lines: budget.lines.map((l) => ({ ...l, months: l.months.slice(12 - (12 - 0)).slice(0, 12) })).map((l) => ({ ...l, months: l.months.slice(0, yearActivity.months.length) })), throughIndex: yearActivity.months.length - 1 });
      const { budgetYtd, actualYtd } = bva.totals.expense;
      budgetInfo = { year, expenseBudgetYtd: budgetYtd, expenseActualYtd: actualYtd, ...(budgetYtd > 0 ? { utilizationPct: Math.round((actualYtd / budgetYtd) * 10_000) / 100 } : {}) };
    }

    // Bekleyen isler
    const [review, offsets, meterPeriods] = sources;
    const bankIds = activity.accounts.filter((a) => a.type === 'bank').map((a) => a.accountId);
    const unmatched = bankIds.length ? await deps.sources.unmatchedBankLines(ctx.apartmentId, bankIds, '2000-01-01', t) : 0;
    const meterPending = meterPeriods.filter((p) => p.status === 'draft' || p.status === 'calculated' || p.status === 'posting' || p.status === 'reversing').length;
    const lastClosed = lock?.lastClosedPeriod;
    const previousMonth = previousPeriod(current);
    const unclosed = lastClosed ? Math.max(monthsBetween(lastClosed, previousMonth).length - 1, 0) : undefined;
    const pending = [
      { code: 'bank_unmatched', count: unmatched, message: 'Eşleşmemiş banka satırı' },
      { code: 'payment_review', count: review, message: 'İnceleme bekleyen online ödeme' },
      { code: 'offset_requests_pending', count: offsets, message: 'Bekleyen mahsup talebi' },
      { code: 'meter_pending', count: meterPending, message: 'Onay bekleyen sayaç dönemi' },
      lastClosed
        ? { code: 'periods_unclosed', count: unclosed ?? 0, message: 'Kapatılmamış geçmiş ay' }
        : { code: 'periods_never_closed', count: 1, message: 'Henüz dönem kapanışı yapılmadı' },
    ].filter((p) => p.count > 0);

    return {
      asOf: t,
      funds: { cash: summary.cash, bank: summary.bank, total: summary.totalFunds },
      receivables: summary.receivables,
      advances: summary.advances,
      overdue: summary.overdue,
      overdueUnitCount: summary.overdueUnitCount,
      accruedLateFees: summary.accruedLateFees,
      formerReceivables: summary.formerReceivables,
      payables: summary.payables,
      thisMonth,
      series,
      budget: budgetInfo,
      lockedThrough: lock?.lockedThrough ?? null,
      pending,
    };
  }

  /**
   * Bu ayin tahakkuk / tahsilati: Genel Bakis'in `thisMonth` alaniyla ayni hesap, ama yalnizca bu
   * ayin hareketleri okunur (12 aylik seri, butce ve acilis yok). Yonetim portfoyu kullanir.
   */
  async function collection(ctx: ReportContext): Promise<MonthCollection> {
    const current = today().slice(0, 7);
    const activity = await loadActivity(ctx.apartmentId, current, current, { opening: false });
    const ie = buildIncomeExpense(activity);
    return monthCollection(current, ie.totals.income[0] ?? 0, activity.paymentsIn.get(current) ?? 0);
  }

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------

  async function pdfData(ctx: ReportContext, kind: ReportKind, q: Record<string, string | undefined>): Promise<{ data: Omit<ReportPdfData, 'apartmentName' | 'generatedAt' | 'dataHash'>; slug: string; payload: unknown }> {
    switch (kind) {
      case 'trial-balance': {
        const r = await trialBalance(ctx, q);
        const rows: ReportRow[] = r.rows.map((x) => ({ cells: [x.code ?? '', x.name, signed(x.opening), tl(x.debit), tl(x.credit), x.closing > 0 ? tl(x.closing) : '—', x.closing < 0 ? tl(-x.closing) : '—'] }));
        rows.push({ bold: true, rule: true, cells: ['', 'Toplam', signed(r.totals.opening), tl(r.totals.debit), tl(r.totals.credit), '', ''] });
        return {
          slug: `${r.from}_${r.to}`,
          payload: r,
          data: {
            title: 'Mizan',
            subtitle: `${formatPeriodTr(r.from as string)} – ${formatPeriodTr(r.to as string)} · ${r.balanced ? 'Mizan dengede' : 'UYARI: mizan dengede değil'}`,
            sections: [
              {
                columns: [
                  { header: 'Kod', width: 0.7 },
                  { header: 'Hesap', width: 3.2 },
                  { header: 'Açılış', width: 1.6, align: 'right' },
                  { header: 'Borç', width: 1.5, align: 'right' },
                  { header: 'Alacak', width: 1.5, align: 'right' },
                  { header: 'Borç bakiye', width: 1.5, align: 'right' },
                  { header: 'Alacak bakiye', width: 1.5, align: 'right' },
                ],
                rows,
              },
            ],
            notes: ['Açılış sütununda B: borç, A: alacak bakiyesidir. Kapalı aylar dönem kapanış görüntüsünden alınmıştır.'],
          },
        };
      }
      case 'income-expense': {
        const r = await incomeExpense(ctx, q);
        const cols = [{ header: 'Hesap', width: 2.6 }, ...r.months.map((m) => ({ header: shortMonth(m), width: 1, align: 'right' as const })), { header: 'Toplam', width: 1.3, align: 'right' as const }];
        const money = (n: number) => (n === 0 ? '—' : (n / 100).toLocaleString('tr-TR', { maximumFractionDigits: 0 }));
        const lines = (rows: typeof r.income, label: string, totals: number[], total: number): ReportRow[] => [
          ...rows.map((x) => ({ cells: [x.name, ...x.months.map(money), money(x.total)] })),
          { bold: true, rule: true, cells: [label, ...totals.map(money), money(total)] },
        ];
        return {
          slug: String(r.year),
          payload: r,
          data: {
            title: 'Gelir - Gider Tablosu',
            subtitle: `${r.year} · tutarlar TL (kuruşsuz)`,
            sections: [
              { title: 'Gelirler', columns: cols, rows: lines(r.income, 'Toplam gelir', r.totals.income, r.totals.incomeTotal) },
              { title: 'Giderler', columns: cols, rows: lines(r.expense, 'Toplam gider', r.totals.expense, r.totals.expenseTotal) },
              { title: 'Dönem sonucu', columns: cols, rows: [{ bold: true, cells: ['Gelir − gider', ...r.totals.result.map(money), money(r.totals.resultTotal)] }] },
            ],
          },
        };
      }
      case 'budget-vs-actual': {
        const r = await budgetVsActual(ctx, q);
        const row = (l: (typeof r.lines)[number]): ReportRow => ({
          cells: [l.name, tl(l.budgetTotal), tl(l.budgetYtd), tl(l.actualYtd), l.variance === 0 ? '—' : `${l.variance > 0 ? '+' : '−'}${formatTRY(Math.abs(l.variance))}`, l.variancePct === undefined ? '—' : `%${l.variancePct.toLocaleString('tr-TR')}`],
        });
        const cols = [
          { header: 'Kalem', width: 3 },
          { header: 'Yıllık bütçe', width: 1.5, align: 'right' as const },
          { header: 'Bütçe (dönem)', width: 1.5, align: 'right' as const },
          { header: 'Gerçekleşen', width: 1.5, align: 'right' as const },
          { header: 'Fark', width: 1.5, align: 'right' as const },
          { header: 'Sapma', width: 0.9, align: 'right' as const },
        ];
        return {
          slug: String(r.year),
          payload: r,
          data: {
            title: 'Bütçe – Gerçekleşen',
            subtitle: `${r.year} · ${r.budget ? `onaylı bütçe r${r.budget.revision}${r.budget.decision ? ` (karar ${r.budget.decision.ref}, ${formatDateTR(r.budget.decision.date)})` : ''}` : 'onaylı bütçe yok'} · dönem: Ocak – ${r.throughMonth ? formatPeriodTr(r.throughMonth) : '—'}`,
            sections: [
              { title: 'Gelirler', columns: cols, rows: r.lines.filter((l) => l.kind === 'income').map(row) },
              { title: 'Giderler', columns: cols, rows: r.lines.filter((l) => l.kind === 'expense').map(row) },
            ],
            notes: ['Giderde pozitif fark bütçe aşımını, gelirde pozitif fark beklenenden fazla geliri gösterir.'],
          },
        };
      }
      case 'annual-statement': {
        const r = await annualStatement(ctx, q);
        const two = [{ header: 'Kalem', width: 4 }, { header: 'Tutar', width: 1.6, align: 'right' as const }];
        return {
          slug: String(r.year),
          payload: r,
          data: {
            title: 'Kesin Hesap',
            subtitle: `${r.year} · ${r.yearClosed ? 'tüm aylar kapalı' : 'yıl kapanmadı; açık aylar defterden hesaplandı'}`,
            sections: [
              { title: 'Kasa ve banka', columns: [{ header: 'Hesap', width: 4 }, { header: 'Yıl başı', width: 1.6, align: 'right' }, { header: 'Yıl sonu', width: 1.6, align: 'right' }], rows: [...r.funds.rows.map((x) => ({ cells: [x.name, tl(x.opening), tl(x.closing)] })), { bold: true, rule: true, cells: ['Toplam', tl(r.funds.opening), tl(r.funds.closing)] }] },
              { title: 'Gelirler', columns: two, rows: [...r.income.rows.map((x) => ({ cells: [x.name, tl(x.total)] })), { bold: true, rule: true, cells: ['Toplam gelir', tl(r.income.total)] }] },
              { title: 'Giderler', columns: two, rows: [...r.expense.rows.map((x) => ({ cells: [x.name, tl(x.total)] })), { bold: true, rule: true, cells: ['Toplam gider', tl(r.expense.total)] }] },
              {
                title: 'Sonuç ve devir',
                columns: two,
                rows: [
                  { bold: true, cells: ['Dönem sonucu (gelir − gider)', r.result < 0 ? `−${formatTRY(-r.result)}` : tl(r.result)] },
                  { cells: ['Yıl sonu sakin alacakları', tl(r.receivables.closing)] },
                  { cells: ['Yıl sonu sakin avansları', tl(r.receivables.advancesClosing)] },
                  { cells: ['Yıl sonu tedarikçi borçları', tl(r.payables.closing)] },
                  ...(r.budget ? [{ muted: true, cells: ['Bütçelenen gelir / gider', `${tl(r.budget.income)} / ${tl(r.budget.expense)}`] }] : []),
                ],
              },
            ],
          },
        };
      }
      case 'debtors': {
        const r = await debtors(ctx);
        return {
          slug: r.asOf,
          payload: r,
          data: {
            title: 'Borçlu Listesi',
            subtitle: `${formatDateTR(r.asOf)} itibarıyla · ${r.totals.count} bağımsız bölüm`,
            sections: [
              {
                columns: [
                  { header: 'Bölüm', width: 1.4 },
                  { header: 'Kat maliki', width: 1.3, align: 'right' },
                  { header: 'Kiracı / sakin', width: 1.3, align: 'right' },
                  { header: 'Ayrılan cari', width: 1.2, align: 'right' },
                  { header: 'Toplam borç', width: 1.3, align: 'right' },
                  { header: 'Vadesi geçen', width: 1.3, align: 'right' },
                  { header: 'Gecikme taz.', width: 1.2, align: 'right' },
                  { header: 'Gün', width: 0.6, align: 'right' },
                ],
                rows: [
                  ...r.items.map((i) => ({ cells: [i.label, tl(i.owner), tl(i.occupant), tl(i.former), tl(i.balance), tl(i.overdue), tl(i.lateFee), i.daysOverdue ? String(i.daysOverdue) : '—'] })),
                  { bold: true, rule: true, cells: ['Toplam', '', '', '', tl(r.totals.balance), tl(r.totals.overdue), tl(r.totals.lateFee), ''] },
                ],
              },
            ],
          },
        };
      }
      case 'funds-ledger': {
        const r = await fundsLedger(ctx, q);
        return {
          slug: `${r.account.accountId}_${r.from}_${r.to}`,
          payload: r,
          data: {
            title: 'Hesap Dökümü',
            subtitle: `${r.account.name} · ${formatDateTR(r.from)} – ${formatDateTR(r.to)}`,
            sections: [
              {
                columns: [
                  { header: 'Tarih', width: 1 },
                  { header: 'Açıklama', width: 4 },
                  { header: 'Giriş', width: 1.3, align: 'right' },
                  { header: 'Çıkış', width: 1.3, align: 'right' },
                  { header: 'Bakiye', width: 1.4, align: 'right' },
                ],
                rows: [
                  { muted: true, cells: [formatDateTR(r.from), 'Devreden bakiye', '', '', formatTRY(r.opening)] },
                  ...r.rows.map((x) => ({ cells: [x.date.split('-').reverse().join('.'), x.description, tl(x.in), tl(x.out), formatTRY(x.balance)] })),
                  { bold: true, rule: true, cells: ['', 'Toplam / kapanış', tl(r.totals.in), tl(r.totals.out), formatTRY(r.closing)] },
                ],
              },
            ],
          },
        };
      }
    }
  }

  /** Rapor PDF'i: veri ozetiyle S3'te onbelleklenir, 5 dk imzali link doner. */
  async function pdf(ctx: ReportContext, kind: string, q: Record<string, string | undefined>) {
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new ValidationError('Bilinmeyen rapor', 'kind');
    if (!deps.store) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    const [{ data, slug, payload }, site] = await Promise.all([pdfData(ctx, kind as ReportKind, q), deps.core.getSite(ctx.apartmentId)]);
    const apartmentName = site?.name ?? 'Apartman';
    const dataHash = createHash('sha256').update(JSON.stringify({ v: REPORT_TEMPLATE_VERSION, kind, apartmentName, payload })).digest('hex');
    const key = financeReportKey(ctx.apartmentId, today(), kind, slug, dataHash);
    if (!(await deps.store.head(key))) {
      const bytes = await renderReportPdf({ ...data, apartmentName, generatedAt: deps.now().toISOString(), dataHash });
      await deps.store.put(key, bytes, 'application/pdf');
    }
    const fileName = `${kind}-${slug}.pdf`;
    const url = await deps.store.presignGet(key, { contentDisposition: contentDisposition(fileName, 'inline'), contentType: 'application/pdf', expiresIn: URL_TTL_SECONDS });
    return { url, fileName, contentType: 'application/pdf', expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString() };
  }

  return { trialBalance, incomeExpense, budgetVsActual, annualStatement, debtors, fundsLedger, dashboard, collection, pdf };
}

export type ReportService = ReturnType<typeof createReportService>;
