import { z } from 'zod';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';

/*
 * Finans 2.4 uclari (apps/api/src/modules/finance/routes.ts):
 *   GET  /api/finance/periods | /periods/:ay | /periods/:ay/checklist
 *   POST /api/finance/periods/:ay/close { expectedLockVersion, acknowledgeWarnings }
 *   POST /api/finance/periods/:ay/reopen { reason }
 *   GET  /api/finance/reports/<rapor>?…[&format=pdf] | /dashboard
 *   GET|POST /api/finance/budgets, GET|PUT|DELETE /budgets/:id, POST /budgets/:id/approve,
 *   GET /budgets/:id/dues-preview, POST /budgets/:id/apply-dues-plan
 * Tum tutarlar kurus cinsinden tam sayidir.
 */

const kurus = z.number().int();

// ---------------------------------------------------------------------------
// Donem kapanisi
// ---------------------------------------------------------------------------

export const checklistItemSchema = z.object({ code: z.string(), message: z.string(), count: z.number().optional(), amount: z.number().optional() });
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

const snapshotTotalsSchema = z.object({ debit: kurus, credit: kurus, opening: kurus, closing: kurus, transactions: z.number().int() }).partial();

export const fiscalPeriodSchema = z.object({
  period: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.enum(['closed', 'reopened']),
  closedAt: z.string(),
  closedBy: z.string(),
  acknowledgedWarnings: z.array(checklistItemSchema).default([]),
  revision: z.number().int(),
  reopenHistory: z.array(z.object({ at: z.string(), by: z.string(), reason: z.string(), revision: z.number().int() })).default([]),
  totals: snapshotTotalsSchema.optional(),
  hash: z.string().optional(),
});
export type FiscalPeriodView = z.infer<typeof fiscalPeriodSchema>;

export const periodStatusSchema = z.object({
  lockedThrough: z.string().optional(),
  lastClosedPeriod: z.string().optional(),
  closing: z.string().optional(),
  lockVersion: z.number().int(),
  nextClosable: z.string().optional(),
  firstClose: z.boolean(),
  periods: z.array(fiscalPeriodSchema),
});
export type PeriodStatus = z.infer<typeof periodStatusSchema>;

export const checklistSchema = z.object({
  period: z.string(),
  canClose: z.boolean(),
  sequenceError: z.string().optional(),
  blockers: z.array(checklistItemSchema),
  warnings: z.array(checklistItemSchema),
  lockVersion: z.number().int(),
  preview: z.object({ totals: snapshotTotalsSchema }).optional(),
});
export type PeriodChecklist = z.infer<typeof checklistSchema>;

// ---------------------------------------------------------------------------
// Raporlar
// ---------------------------------------------------------------------------

const accountRef = { accountId: z.string(), name: z.string(), code: z.string().optional(), type: z.string() };

export const trialBalanceSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  rows: z.array(z.object({ ...accountRef, opening: kurus, debit: kurus, credit: kurus, closing: kurus })),
  totals: z.object({ opening: kurus, debit: kurus, credit: kurus, closing: kurus }),
  balanced: z.boolean(),
  closedMonths: z.array(z.string()),
});

const monthlyRow = z.object({ ...accountRef, months: z.array(kurus), total: kurus });
export const incomeExpenseSchema = z.object({
  year: z.number().int(),
  months: z.array(z.string()),
  income: z.array(monthlyRow),
  expense: z.array(monthlyRow),
  totals: z.object({
    income: z.array(kurus),
    expense: z.array(kurus),
    result: z.array(kurus),
    incomeTotal: kurus,
    expenseTotal: kurus,
    resultTotal: kurus,
  }),
  closedMonths: z.array(z.string()),
});

const bvaTotals = z.object({ budget: kurus, actual: kurus, budgetYtd: kurus, actualYtd: kurus });
export const budgetVsActualSchema = z.object({
  year: z.number().int(),
  budget: z.object({ budgetId: z.string(), revision: z.number().int(), decision: z.object({ ref: z.string(), date: z.string() }).optional() }).nullable(),
  months: z.array(z.string()),
  throughMonth: z.string().optional(),
  lines: z.array(
    z.object({
      ...accountRef,
      kind: z.enum(['income', 'expense']),
      budgetTotal: kurus,
      actualTotal: kurus,
      budgetYtd: kurus,
      actualYtd: kurus,
      variance: kurus,
      variancePct: z.number().optional(),
    }),
  ),
  totals: z.object({ income: bvaTotals, expense: bvaTotals }),
  closedMonths: z.array(z.string()),
});

const nameTotal = z.object({ ...accountRef, total: kurus });
export const annualStatementSchema = z.object({
  year: z.number().int(),
  funds: z.object({ rows: z.array(z.object({ ...accountRef, opening: kurus, closing: kurus })), opening: kurus, closing: kurus }),
  income: z.object({ rows: z.array(nameTotal), total: kurus }),
  expense: z.object({ rows: z.array(nameTotal), total: kurus }),
  result: kurus,
  receivables: z.object({ opening: kurus, closing: kurus, advancesClosing: kurus }),
  /** Tedarikcilere verilen avanslar (sakin alacaklarina dahil degil; eski API'de yok). */
  supplierAdvances: z.object({ opening: kurus, closing: kurus }).default({ opening: 0, closing: 0 }),
  payables: z.object({ opening: kurus, closing: kurus }),
  budget: z.object({ income: kurus, expense: kurus, result: kurus }).optional(),
  balanced: z.boolean(),
  yearClosed: z.boolean(),
  closedMonths: z.array(z.string()),
});

export const debtorsSchema = z.object({
  asOf: z.string(),
  items: z.array(
    z.object({
      unitId: z.string(),
      label: z.string(),
      owner: kurus,
      occupant: kurus,
      former: kurus,
      balance: kurus,
      overdue: kurus,
      lateFee: kurus,
      daysOverdue: z.number().int(),
      oldestUnpaidDueDate: z.string().optional(),
    }),
  ),
  totals: z.object({ balance: kurus, overdue: kurus, lateFee: kurus, count: z.number().int() }),
});

export const fundsLedgerSchema = z.object({
  account: z.object({ accountId: z.string(), name: z.string(), type: z.enum(['cash', 'bank']), code: z.string().optional() }),
  from: z.string(),
  to: z.string(),
  opening: kurus,
  closing: kurus,
  rows: z.array(
    z.object({ date: z.string(), transactionId: z.string(), kind: z.string().optional(), description: z.string(), reference: z.string().optional(), in: kurus, out: kurus, balance: kurus }),
  ),
  totals: z.object({ in: kurus, out: kurus }),
});

export const REPORT_KINDS = ['trial-balance', 'income-expense', 'budget-vs-actual', 'annual-statement', 'debtors', 'funds-ledger'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_LABELS: Record<ReportKind, string> = {
  'trial-balance': 'Mizan',
  'income-expense': 'Gelir - gider',
  'budget-vs-actual': 'Bütçe – gerçekleşen',
  'annual-statement': 'Kesin hesap',
  debtors: 'Borçlu listesi',
  'funds-ledger': 'Kasa / banka dökümü',
};
export type ReportQuery = { from?: string; to?: string; year?: string; accountId?: string };

const reportSchemas = {
  'trial-balance': trialBalanceSchema,
  'income-expense': incomeExpenseSchema,
  'budget-vs-actual': budgetVsActualSchema,
  'annual-statement': annualStatementSchema,
  debtors: debtorsSchema,
  'funds-ledger': fundsLedgerSchema,
} as const;
export type ReportData<K extends ReportKind> = z.infer<(typeof reportSchemas)[K]>;

export const dashboardSchema = z.object({
  asOf: z.string(),
  funds: z.object({ cash: kurus, bank: kurus, total: kurus }),
  receivables: kurus,
  advances: kurus,
  overdue: kurus,
  overdueUnitCount: z.number().int(),
  accruedLateFees: kurus,
  formerReceivables: kurus,
  payables: kurus,
  thisMonth: z.object({ period: z.string(), charged: kurus, collected: kurus, collectionRatePct: z.number().optional() }),
  series: z.array(z.object({ period: z.string(), income: kurus, expense: kurus, result: kurus })),
  budget: z.object({ year: z.number().int(), expenseBudgetYtd: kurus, expenseActualYtd: kurus, utilizationPct: z.number().optional() }).nullable(),
  lockedThrough: z.string().nullable(),
  pending: z.array(z.object({ code: z.string(), count: z.number().int(), message: z.string() })),
});
export type FinanceDashboard = z.infer<typeof dashboardSchema>;

// ---------------------------------------------------------------------------
// Butce
// ---------------------------------------------------------------------------

export const budgetLineSchema = z.object({ accountId: z.string(), kind: z.enum(['income', 'expense']), months: z.array(kurus), note: z.string().optional() });
export type BudgetLine = z.infer<typeof budgetLineSchema>;
export const DUES_KEYS = ['equal', 'area', 'land_share'] as const;
export type DuesKey = (typeof DUES_KEYS)[number];
export const DUES_KEY_LABELS: Record<DuesKey, string> = { equal: 'Eşit', area: 'Metrekare', land_share: 'Arsa payı' };

export const budgetSchema = z.object({
  budgetId: z.string(),
  year: z.number().int(),
  revision: z.number().int(),
  status: z.enum(['draft', 'approved', 'superseded', 'discarded']),
  title: z.string().optional(),
  lines: z.array(budgetLineSchema),
  dues: z.object({ distributionKey: z.enum(DUES_KEYS), liableParty: z.enum(['owner', 'occupant']), incomeAccountId: z.string().optional() }).optional(),
  decision: z.object({ ref: z.string(), date: z.string() }).optional(),
  approvedAt: z.string().optional(),
  approvedBy: z.string().optional(),
  updatedAt: z.string(),
  version: z.number().int(),
  totals: z.object({ income: kurus, expense: kurus, result: kurus }),
});
export type Budget = z.infer<typeof budgetSchema>;
export type BudgetInput = {
  title?: string | null;
  lines?: { accountId: string; months?: number[]; annual?: number; note?: string }[];
  dues?: Budget['dues'] | null;
};

export const budgetDuesPreviewSchema = z.object({
  budgetId: z.string(),
  status: z.string(),
  month: z.string(),
  incomeAccountId: z.string(),
  amount: kurus,
  uneven: z.boolean(),
  balance: z.object({ income: kurus, expense: kurus, result: kurus, otherIncome: kurus, duesAnnual: kurus, suggestedMonthlyDues: z.array(kurus) }),
  preview: z
    .object({
      count: z.number().int(),
      distributedAmount: kurus,
      items: z.array(z.object({ unitId: z.string(), number: z.string(), amount: kurus })),
      exempt: z.array(z.object({ unitId: z.string(), number: z.string() })).default([]),
    })
    .nullable(),
});
export type BudgetDuesPreview = z.infer<typeof budgetDuesPreviewSchema>;

const warningsSchema = z.array(z.object({ code: z.string(), message: z.string() }));

export const financePeriodsApi = {
  status: (signal?: AbortSignal) => apiClient.get('/api/finance/periods', { signal, schema: periodStatusSchema }),
  checklist: (period: string, signal?: AbortSignal) =>
    apiClient.get(`/api/finance/periods/${encodeURIComponent(period)}/checklist`, { signal, schema: checklistSchema }),
  close: (period: string, input: { expectedLockVersion: number; acknowledgeWarnings: string[] }) =>
    apiClient.post(`/api/finance/periods/${encodeURIComponent(period)}/close`, input, { schema: z.object({ period: fiscalPeriodSchema.partial().passthrough() }).passthrough() }),
  reopen: (period: string, reason: string) =>
    apiClient.post(`/api/finance/periods/${encodeURIComponent(period)}/reopen`, { reason }, { schema: z.object({}).passthrough() }),

  report: <K extends ReportKind>(kind: K, query: ReportQuery, signal?: AbortSignal) =>
    apiClient.get(`/api/finance/reports/${kind}`, { signal, query, schema: reportSchemas[kind] as unknown as z.ZodType<ReportData<K>> }),
  reportPdf: (kind: ReportKind, query: ReportQuery) =>
    apiClient.get(`/api/finance/reports/${kind}`, { query: { ...query, format: 'pdf' }, schema: signedDownloadSchema }),
  dashboard: (signal?: AbortSignal) => apiClient.get('/api/finance/dashboard', { signal, schema: dashboardSchema }),

  budgets: (year: number | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/finance/budgets', { signal, query: { year: year === undefined ? undefined : String(year) }, schema: z.object({ items: z.array(budgetSchema) }) }),
  createBudget: (input: BudgetInput & { year: number; copyFrom?: string }) => apiClient.post('/api/finance/budgets', input, { schema: budgetSchema }),
  updateBudget: (budgetId: string, input: BudgetInput & { version: number }) =>
    apiClient.put(`/api/finance/budgets/${encodeURIComponent(budgetId)}`, input, { schema: budgetSchema }),
  deleteBudget: (budgetId: string, version: number) =>
    apiClient.delete(`/api/finance/budgets/${encodeURIComponent(budgetId)}`, { query: { version: String(version) }, schema: z.object({ deleted: z.boolean() }) }),
  approveBudget: (budgetId: string, input: { version: number; decisionRef: string; decisionDate: string }) =>
    apiClient.post(`/api/finance/budgets/${encodeURIComponent(budgetId)}/approve`, input, { schema: z.object({ budget: budgetSchema, superseded: z.string().optional() }) }),
  budgetDuesPreview: (budgetId: string, month: string | undefined, signal?: AbortSignal) =>
    apiClient.get(`/api/finance/budgets/${encodeURIComponent(budgetId)}/dues-preview`, { signal, query: { month }, schema: budgetDuesPreviewSchema }),
  applyDuesPlan: (budgetId: string, input: { siteVersion: number; month?: string }) =>
    apiClient.post(`/api/finance/budgets/${encodeURIComponent(budgetId)}/apply-dues-plan`, input, {
      schema: z.object({ plan: z.object({ totalAmount: kurus }).passthrough().optional(), siteVersion: z.number().int(), month: z.string(), warnings: warningsSchema }),
    }),
};

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const MONTHS_SHORT = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
/** "2026-11" -> "Kasım 2026". */
export const formatPeriod = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1] ?? period} ${period.slice(0, 4)}`;
/** "2026-11" -> "Kas 26". */
export const formatPeriodShort = (period: string) => `${MONTHS_SHORT[Number(period.slice(5, 7)) - 1] ?? period} ${period.slice(2, 4)}`;
export const MONTH_NAMES = MONTHS;
