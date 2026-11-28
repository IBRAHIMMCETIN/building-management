/**
 * Finans 2.4-3 - Defter raporlari (saf): mizan, gelir-gider tablosu, butce-gerceklesen, kesin
 * hesap ve kasa/banka hesap dokumu. Veri `ReportActivity` olarak gelir: kapali aylar donem anlik
 * goruntusunden, acik aylar TX# tarih araligindan (bkz. reportService.loadActivity).
 * Tum tutarlar kurus; isaretli bakiyeler `borc - alacak` (Account.balance ile ayni anlam).
 */
import type { IsoDate } from '../core/types.js';
import { nextPeriod } from './lateFee.js';
import type { Account, AccountType, LedgerEntry, Transaction } from './types.js';

export type Movement = { debit: number; credit: number };

export type ReportActivity = {
  accounts: readonly Account[];
  /** Kapsanan aylar (YYYY-MM, artan). */
  months: string[];
  /** Ilk ayin basindaki hesap bakiyeleri (isaretli). */
  opening: ReadonlyMap<string, number>;
  /** Ay -> hesap -> borc/alacak. */
  byMonth: ReadonlyMap<string, ReadonlyMap<string, Movement>>;
  /** Anlik goruntuden okunan (kapali) aylar. */
  closedMonths: string[];
};

export type AccountRef = { accountId: string; name: string; code?: string; type: AccountType };

const TYPE_ORDER: Record<AccountType, number> = { cash: 0, bank: 1, receivable: 2, payable: 3, income: 4, expense: 5, equity: 6 };
const byChart = (a: AccountRef, b: AccountRef) =>
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.code ?? '￿').localeCompare(b.code ?? '￿') || a.name.localeCompare(b.name, 'tr');

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextPeriod(m)) {
    out.push(m);
    if (out.length > 240) throw new Error('Rapor araligi en fazla 240 ay');
  }
  return out;
}

function refOf(accounts: ReadonlyMap<string, Account>, accountId: string): AccountRef {
  const a = accounts.get(accountId);
  return { accountId, name: a?.name ?? accountId, ...(a?.code ? { code: a.code } : {}), type: a?.type ?? 'equity' };
}

function sumMovements(activity: ReportActivity, months: readonly string[]): Map<string, Movement> {
  const out = new Map<string, Movement>();
  for (const m of months) {
    for (const [acc, mv] of activity.byMonth.get(m) ?? []) {
      const cur = out.get(acc) ?? { debit: 0, credit: 0 };
      out.set(acc, { debit: cur.debit + mv.debit, credit: cur.credit + mv.credit });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mizan
// ---------------------------------------------------------------------------

export type TrialBalanceRow = AccountRef & { opening: number; debit: number; credit: number; closing: number };

export function buildTrialBalance(activity: ReportActivity) {
  const accounts = new Map(activity.accounts.map((a) => [a.accountId, a]));
  const moves = sumMovements(activity, activity.months);
  const ids = new Set([...activity.opening.keys(), ...moves.keys()]);
  const rows: TrialBalanceRow[] = [...ids]
    .map((id) => {
      const opening = activity.opening.get(id) ?? 0;
      const mv = moves.get(id) ?? { debit: 0, credit: 0 };
      return { ...refOf(accounts, id), opening, debit: mv.debit, credit: mv.credit, closing: opening + mv.debit - mv.credit };
    })
    .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0)
    .sort(byChart);
  const totals = {
    opening: rows.reduce((s, r) => s + r.opening, 0),
    debit: rows.reduce((s, r) => s + r.debit, 0),
    credit: rows.reduce((s, r) => s + r.credit, 0),
    closing: rows.reduce((s, r) => s + r.closing, 0),
  };
  return { from: activity.months[0], to: activity.months.at(-1), rows, totals, balanced: totals.debit === totals.credit && totals.closing === 0 };
}

// ---------------------------------------------------------------------------
// Gelir-gider tablosu (aylik sutunlar)
// ---------------------------------------------------------------------------

export type MonthlyRow = AccountRef & { months: number[]; total: number };

/** Gelir: alacak - borc; gider: borc - alacak (ters kayitlar dogal olarak duser). */
export function buildIncomeExpense(activity: ReportActivity) {
  const accounts = new Map(activity.accounts.map((a) => [a.accountId, a]));
  const rowsOf = (type: 'income' | 'expense'): MonthlyRow[] => {
    // Yalnizca donemde hareketi olan hesaplar (hareketsiz hazir hesaplar tabloyu kalabaliklastirmaz).
    const ids = new Set<string>();
    for (const m of activity.months) for (const [acc] of activity.byMonth.get(m) ?? []) if (accounts.get(acc)?.type === type) ids.add(acc);
    return [...ids]
      .map((id) => {
        const months = activity.months.map((m) => {
          const mv = activity.byMonth.get(m)?.get(id);
          if (!mv) return 0;
          return type === 'income' ? mv.credit - mv.debit : mv.debit - mv.credit;
        });
        return { ...refOf(accounts, id), months, total: months.reduce((s, v) => s + v, 0) };
      })
      .sort(byChart);
  };
  const income = rowsOf('income');
  const expense = rowsOf('expense');
  const col = (rows: MonthlyRow[]) => activity.months.map((_, i) => rows.reduce((s, r) => s + (r.months[i] ?? 0), 0));
  const incomeTotals = col(income);
  const expenseTotals = col(expense);
  const result = incomeTotals.map((v, i) => v - (expenseTotals[i] ?? 0));
  return {
    months: activity.months,
    income,
    expense,
    totals: {
      income: incomeTotals,
      expense: expenseTotals,
      result,
      incomeTotal: incomeTotals.reduce((s, v) => s + v, 0),
      expenseTotal: expenseTotals.reduce((s, v) => s + v, 0),
      resultTotal: result.reduce((s, v) => s + v, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Butce - gerceklesen
// ---------------------------------------------------------------------------

export type BudgetLineInput = { accountId: string; kind: 'income' | 'expense'; months: number[] };

export type BudgetVsActualLine = AccountRef & {
  kind: 'income' | 'expense';
  budget: number[];
  actual: number[];
  budgetTotal: number;
  actualTotal: number;
  /** Yilbasindan `throughMonth` dahil. */
  budgetYtd: number;
  actualYtd: number;
  /** Gerceklesen - butce (yilbasindan). Giderde pozitif = asim. */
  variance: number;
  /** Butceye gore sapma yuzdesi (iki ondalik); butce 0 ise yok. */
  variancePct?: number;
};

export function buildBudgetVsActual(input: {
  activity: ReportActivity;
  lines: readonly BudgetLineInput[];
  /** Ytd icin son ay indeksi (0-11). */
  throughIndex: number;
}) {
  const ie = buildIncomeExpense(input.activity);
  const actualOf = new Map([...ie.income, ...ie.expense].map((r) => [r.accountId, r]));
  const accounts = new Map(input.activity.accounts.map((a) => [a.accountId, a]));
  const seen = new Set<string>();
  const ytd = (xs: number[]) => xs.slice(0, input.throughIndex + 1).reduce((s, v) => s + v, 0);
  const lineOf = (accountId: string, kind: 'income' | 'expense', budget: number[]): BudgetVsActualLine => {
    const actual = actualOf.get(accountId)?.months ?? input.activity.months.map(() => 0);
    const budgetYtd = ytd(budget);
    const actualYtd = ytd(actual);
    const variance = actualYtd - budgetYtd;
    return {
      ...refOf(accounts, accountId),
      kind,
      budget,
      actual,
      budgetTotal: budget.reduce((s, v) => s + v, 0),
      actualTotal: actual.reduce((s, v) => s + v, 0),
      budgetYtd,
      actualYtd,
      variance,
      ...(budgetYtd !== 0 ? { variancePct: Math.round((variance / budgetYtd) * 10_000) / 100 } : {}),
    };
  };
  const lines: BudgetVsActualLine[] = input.lines.map((l) => {
    seen.add(l.accountId);
    return lineOf(l.accountId, l.kind, l.months);
  });
  // Butcede olmayan ama gerceklesen hareketi olan kalemler (butce 0).
  for (const r of [...ie.income, ...ie.expense]) {
    if (!seen.has(r.accountId) && r.total !== 0) lines.push(lineOf(r.accountId, r.type === 'income' ? 'income' : 'expense', input.activity.months.map(() => 0)));
  }
  const sum = (kind: 'income' | 'expense', pick: (l: BudgetVsActualLine) => number) => lines.filter((l) => l.kind === kind).reduce((s, l) => s + pick(l), 0);
  return {
    months: input.activity.months,
    throughMonth: input.activity.months[input.throughIndex],
    lines: lines.sort((a, b) => (a.kind === b.kind ? byChart(a, b) : a.kind === 'income' ? -1 : 1)),
    totals: {
      income: { budget: sum('income', (l) => l.budgetTotal), actual: sum('income', (l) => l.actualTotal), budgetYtd: sum('income', (l) => l.budgetYtd), actualYtd: sum('income', (l) => l.actualYtd) },
      expense: { budget: sum('expense', (l) => l.budgetTotal), actual: sum('expense', (l) => l.actualTotal), budgetYtd: sum('expense', (l) => l.budgetYtd), actualYtd: sum('expense', (l) => l.actualYtd) },
    },
  };
}

// ---------------------------------------------------------------------------
// Kesin hesap (yillik)
// ---------------------------------------------------------------------------

export function buildAnnualStatement(activity: ReportActivity, budget?: { lines: readonly BudgetLineInput[] }) {
  const tb = buildTrialBalance(activity);
  const ie = buildIncomeExpense(activity);
  const sumType = (types: AccountType[], pick: (r: TrialBalanceRow) => number) => tb.rows.filter((r) => types.includes(r.type)).reduce((s, r) => s + pick(r), 0);
  const fundsRows = tb.rows.filter((r) => r.type === 'cash' || r.type === 'bank').map(({ accountId, name, code, type, opening, closing }) => ({ accountId, name, ...(code ? { code } : {}), type, opening, closing }));
  // Tedarikci avans alt hesaplari (`supplierAdvanceOf`) alacak turundedir ama sakin carisi degildir: ayri satir.
  const supplierAdvanceIds = new Set(activity.accounts.filter((a) => a.type === 'receivable' && a.supplierAdvanceOf).map((a) => a.accountId));
  const receivableRows = tb.rows.filter((r) => r.type === 'receivable' && !supplierAdvanceIds.has(r.accountId));
  const supplierAdvanceRows = tb.rows.filter((r) => supplierAdvanceIds.has(r.accountId));
  const budgetTotals = budget
    ? {
        income: budget.lines.filter((l) => l.kind === 'income').reduce((s, l) => s + l.months.reduce((a, b) => a + b, 0), 0),
        expense: budget.lines.filter((l) => l.kind === 'expense').reduce((s, l) => s + l.months.reduce((a, b) => a + b, 0), 0),
      }
    : undefined;
  return {
    from: activity.months[0],
    to: activity.months.at(-1),
    funds: {
      rows: fundsRows,
      opening: sumType(['cash', 'bank'], (r) => r.opening),
      closing: sumType(['cash', 'bank'], (r) => r.closing),
    },
    income: { rows: ie.income.map(({ months: _m, ...r }) => r), total: ie.totals.incomeTotal },
    expense: { rows: ie.expense.map(({ months: _m, ...r }) => r), total: ie.totals.expenseTotal },
    result: ie.totals.resultTotal,
    receivables: {
      opening: receivableRows.reduce((s, r) => s + Math.max(r.opening, 0), 0),
      closing: receivableRows.reduce((s, r) => s + Math.max(r.closing, 0), 0),
      advancesClosing: receivableRows.reduce((s, r) => s + Math.max(-r.closing, 0), 0),
    },
    /** Tedarikcilere verilen, faturayla mahsup edilmemis avanslar (yil basi / yil sonu). */
    supplierAdvances: {
      opening: supplierAdvanceRows.reduce((s, r) => s + r.opening, 0),
      closing: supplierAdvanceRows.reduce((s, r) => s + r.closing, 0),
    },
    payables: { opening: -sumType(['payable'], (r) => r.opening), closing: -sumType(['payable'], (r) => r.closing) },
    ...(budgetTotals ? { budget: { ...budgetTotals, result: budgetTotals.income - budgetTotals.expense } } : {}),
    balanced: tb.balanced,
  };
}

// ---------------------------------------------------------------------------
// Kasa / banka hesap dokumu
// ---------------------------------------------------------------------------

export type FundsLedgerRow = {
  date: IsoDate;
  transactionId: string;
  kind?: Transaction['kind'];
  description: string;
  reference?: string;
  in: number;
  out: number;
  balance: number;
};

export function buildFundsLedger(input: { opening: number; entries: readonly LedgerEntry[]; transactions: ReadonlyMap<string, Transaction> }) {
  let balance = input.opening;
  const rows: FundsLedgerRow[] = [...input.entries]
    .sort((a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId) || a.lineNo - b.lineNo)
    .map((e) => {
      const tx = input.transactions.get(e.transactionId);
      const inAmt = e.side === 'debit' ? e.amount : 0;
      const outAmt = e.side === 'credit' ? e.amount : 0;
      balance += inAmt - outAmt;
      return {
        date: e.date,
        transactionId: e.transactionId,
        ...(tx ? { kind: tx.kind } : {}),
        description: tx?.description ?? '',
        ...(tx?.reference ? { reference: tx.reference } : {}),
        in: inAmt,
        out: outAmt,
        balance,
      };
    });
  return {
    opening: input.opening,
    rows,
    totals: { in: rows.reduce((s, r) => s + r.in, 0), out: rows.reduce((s, r) => s + r.out, 0) },
    closing: balance,
  };
}
