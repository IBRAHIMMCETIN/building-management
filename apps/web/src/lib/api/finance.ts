import { z } from 'zod';
import { jobAcceptedSchema } from './bulkJobs';
import { apiClient } from './client';

/*
 * Finans uclari (apps/api/src/modules/finance/routes.ts). Apartman JWT claim'inden gelir.
 *   GET  /api/finance/summary | /dues-status | /transactions?from&to&limit&cursor | /accounts?type
 *   POST /api/finance/payments | /expenses | /dues
 * Tum tutarlar kurus cinsinden tam sayidir. Yazma isteklerinde `idempotencyKey` zorunludur:
 * ayni anahtarla tekrar gonderim (cift tiklama, ag hatasi sonrasi yeniden deneme) ikinci
 * kayit olusturmaz.
 */

const kurus = z.number().int();
const isoDate = z.string();
const party = z.enum(['owner', 'occupant']);

export const summarySchema = z.object({
  asOf: isoDate,
  cash: kurus,
  bank: kurus,
  totalFunds: kurus,
  receivables: kurus,
  advances: kurus,
  payables: kurus,
  overdue: kurus,
  /** Islemis, henuz deftere yazilmamis kistelyevm gecikme tazminati (eski API'de yok). */
  accruedLateFees: kurus.default(0),
  overdueUnitCount: z.number().int(),
  pendingUnitCount: z.number().int(),
  /** Tasinma kapamasiyla acilmis ayrilan sakin/malik carilerindeki borc (ayri izlenir). */
  formerReceivables: kurus.default(0),
  formerDebtorCount: z.number().int().default(0),
  fundsAccounts: z.array(z.object({ accountId: z.string(), name: z.string(), type: z.enum(['cash', 'bank']), balance: kurus })),
});

export const TRANSACTION_CATEGORIES = ['income', 'expense', 'transfer', 'accrual', 'reversal'] as const;
export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export const transactionSchema = z.object({
  transactionId: z.string(),
  date: isoDate,
  dueDate: isoDate.optional(),
  description: z.string(),
  /** transfer: tasinmada cari devri (kapama), refund: avans iadesi; offset: avans mahsubu, restructure: borc yapilandirma (Finans 2.2). */
  kind: z.enum(['dues_charge', 'payment', 'expense', 'reversal', 'late_fee', 'opening_balance', 'transfer', 'refund', 'payable_payment', 'offset', 'restructure']),
  category: z.enum(TRANSACTION_CATEGORIES),
  amount: kurus,
  funds: z.array(
    z.object({
      accountId: z.string(),
      accountName: z.string(),
      accountType: z.enum(['cash', 'bank']),
      direction: z.enum(['in', 'out']),
      amount: kurus,
    }),
  ),
  netFundsChange: kurus,
  unitId: z.string().optional(),
  unitNumber: z.string().optional(),
  liableParty: party.optional(),
  reference: z.string().optional(),
  reversalOf: z.string().optional(),
  reason: z.string().optional(),
  /** Tahsilat: makbuz PDF'i indirilebilir (eski API'de yok). */
  hasReceipt: z.boolean().default(false),
  /** Gidere bagli fatura dosyasi. */
  invoice: z.object({ fileName: z.string() }).optional(),
});

export const transactionPageSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().optional(),
});

const partyDues = z.object({
  charged: kurus,
  paid: kurus,
  balance: kurus,
  overdue: kurus,
  oldestUnpaidDueDate: isoDate.optional(),
});

export const DUES_STATUSES = ['overdue', 'pending', 'paid', 'advance', 'none'] as const;
export type DuesStatus = (typeof DUES_STATUSES)[number];

export const duesStatusSchema = z.object({
  asOf: isoDate,
  items: z.array(
    z.object({
      unitId: z.string(),
      unitNumber: z.string(),
      blockId: z.string(),
      owner: partyDues,
      occupant: partyDues,
      /** Bu dairenin ayrilan sakin/malik carileri toplami (bakiye/gecikmeye dahil degil). */
      former: partyDues.optional(),
      balance: kurus,
      overdue: kurus,
      lateFee: kurus.default(0),
      daysOverdue: z.number().int(),
      status: z.enum(DUES_STATUSES),
      lastPaymentDate: isoDate.optional(),
    }),
  ),
});

export const accountSchema = z.object({
  accountId: z.string(),
  type: z.enum(['cash', 'bank', 'receivable', 'payable', 'income', 'expense', 'equity']),
  name: z.string(),
  status: z.enum(['active', 'inactive']),
  balance: kurus,
  system: z.boolean().optional(),
  /** Finans 2.4: hesap plani kodu. */
  code: z.string().optional(),
  /** Alt cari (receivable) ise daire ve taraf. */
  unitId: z.string().optional(),
  liableParty: party.optional(),
  /** Finans 2.1: `split` faturalamada paydasin malik alt carisi. */
  coOwner: z.object({ userId: z.string() }).optional(),
});

export type FinanceSummary = z.infer<typeof summarySchema>;
export type LedgerTransaction = z.infer<typeof transactionSchema>;
export type UnitDues = z.infer<typeof duesStatusSchema>['items'][number];
export type FinanceAccount = z.infer<typeof accountSchema>;
export type LiableParty = z.infer<typeof party>;

export type RecordPaymentInput = {
  idempotencyKey: string;
  unitId: string;
  liableParty: LiableParty;
  /** Ayrilan sakin/malik carisine tahsilat (ana cari icin bos birakilir). */
  accountId?: string;
  amount: number;
  method: 'cash' | 'bank_transfer';
  paidAt: string;
  payerName?: string;
  note?: string;
};

export type RecordExpenseInput = {
  idempotencyKey: string;
  expenseAccountId: string;
  /** cash | bank (pesin) veya payable (vadeli, tedarikci borcu) */
  creditAccountId: string;
  amount: number;
  date: string;
  description: string;
  supplier?: string;
  invoiceNumber?: string;
  /** documentsApi.uploadInvoice sonucu: yuklenmis fatura dosyasi. */
  invoiceUpload?: { uploadId: string; fileName: string };
};

export type ChargeDuesInput =
  | {
      idempotencyKey: string;
      unitId: string;
      liableParty: LiableParty;
      amount: number;
      date: string;
      dueDate: string;
      description: string;
      /** Finans 2.4: alacak yazilacak gelir hesabi (yoksa aidat gelirleri). */
      incomeAccountId?: string;
    }
  | ({ idempotencyKey: string } & DuesBulkInput);

/** Toplu tahakkuk (ve onizlemesi): kapsam `blockIds`, muafiyet `expenseCategory`. */
export type DuesBulkInput = {
  liableParty: LiableParty;
  totalAmount: number;
  distributionKey: 'equal' | 'area' | 'land_share';
  date: string;
  dueDate: string;
  description: string;
  blockIds?: string[];
  expenseCategory?: string;
  /** Finans 2.4: alacak yazilacak gelir hesabi (yoksa aidat gelirleri). */
  incomeAccountId?: string;
};

/**
 * Gider kalemleri (muafiyet kategorileri). API kodla eslestirir (Unit.exemptions);
 * etiketler yalnizca burada tutulur.
 */
export const EXPENSE_CATEGORIES = [
  { value: 'elevator', label: 'Asansör' },
  { value: 'playground', label: 'Çocuk parkı' },
  { value: 'pool', label: 'Havuz' },
  { value: 'garden', label: 'Bahçe' },
  { value: 'heating', label: 'Isınma' },
  { value: 'parking', label: 'Otopark' },
] as const;

export const expenseCategoryLabel = (value: string) =>
  EXPENSE_CATEGORIES.find((c) => c.value === value)?.label ?? value;

const exemptUnitSchema = z.object({ unitId: z.string(), blockId: z.string(), number: z.string(), reason: z.string().optional() });

export const duesPreviewSchema = z.object({
  count: z.number().int(),
  totalAmount: kurus,
  distributedAmount: kurus,
  items: z.array(
    z.object({ unitId: z.string(), blockId: z.string(), number: z.string(), amount: kurus, liableParty: party.optional() }),
  ),
  exempt: z.array(exemptUnitSchema),
  /** Bos daire kurali: tahakkuk tarihinde oturan olmadigi icin kat malikine yazilacak bolumler. */
  vacant: z.array(z.object({ unitId: z.string(), blockId: z.string(), number: z.string() })).default([]),
  /** Uyelik kaydi olmadigi icin kuralin uygulanamadigi bolumler (sakin carisinde kalir). */
  unknownOccupancy: z.array(z.object({ unitId: z.string(), blockId: z.string(), number: z.string() })).default([]),
});
export type DuesPreview = z.infer<typeof duesPreviewSchema>;

const paymentResultSchema = z.object({
  replayed: z.boolean(),
  payment: z.object({ paymentId: z.string(), receiptNumber: z.string(), amount: kurus }),
});
const expenseResultSchema = z.object({ replayed: z.boolean(), expense: z.object({ expenseId: z.string(), amount: kurus }) });
const duesResultSchema = z.union([
  z.object({
    mode: z.literal('single'),
    replayed: z.boolean(),
    transaction: z.object({ transactionId: z.string(), vacant: z.boolean().optional() }),
  }),
  z.object({
    mode: z.literal('bulk'),
    replayed: z.boolean(),
    count: z.number().int(),
    distributedAmount: kurus,
    exempt: z.array(exemptUnitSchema).default([]),
    vacant: z.array(z.object({ unitId: z.string() })).default([]),
  }),
  // Buyuk kapsam (API `SYNC_BULK_UNITS` ustu): 202 + arka plan isi; ilerleme /api/jobs/:jobId.
  jobAcceptedSchema,
]);

// ----- Faz B3.5: tedarikci borcu -----

export const payableAccountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  status: z.enum(['active', 'inactive']),
  /** Acik borc (kurus, >= 0). */
  openBalance: kurus,
  version: z.number().int(),
  billed: kurus.optional(),
  paid: kurus.optional(),
  openItemCount: z.number().int().optional(),
  lastPaymentDate: z.string().optional(),
  openItems: z
    .array(z.object({ transactionId: z.string(), date: z.string(), description: z.string(), reference: z.string().optional(), amount: kurus, open: kurus }))
    .default([]),
});
export type PayableAccount = z.infer<typeof payableAccountSchema>;

export type RecordPayablePaymentInput = {
  idempotencyKey: string;
  /** Kasa veya banka hesabi (varsayilan: banka). */
  fundsAccountId: string;
  amount: number;
  date: string;
  description?: string;
  reference?: string;
};

export const financeApi = {
  summary: (signal?: AbortSignal) => apiClient.get('/api/finance/summary', { signal, schema: summarySchema }),
  duesStatus: (signal?: AbortSignal) => apiClient.get('/api/finance/dues-status', { signal, schema: duesStatusSchema }),
  transactions: (query: { cursor?: string; limit?: number; from?: string; to?: string }, signal?: AbortSignal) =>
    apiClient.get('/api/finance/transactions', { signal, query, schema: transactionPageSchema }),
  accounts: (type: FinanceAccount['type'] | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/finance/accounts', {
      signal,
      query: { type },
      schema: z.object({ items: z.array(accountSchema) }),
    }),
  /** Finans 2.4: hesap plani (gelir/gider/kasa/banka hesabi ekleme ve duzenleme). */
  createAccount: (input: { type: 'income' | 'expense' | 'bank' | 'cash'; name: string; code?: string }) =>
    apiClient.post('/api/finance/accounts', input, { schema: accountSchema }),
  updateAccount: (accountId: string, input: { name?: string; code?: string | null; status?: 'active' | 'inactive' }) =>
    apiClient.patch(`/api/finance/accounts/${encodeURIComponent(accountId)}`, input, { schema: accountSchema }),
  recordPayment: (input: RecordPaymentInput) =>
    apiClient.post('/api/finance/payments', input, { schema: paymentResultSchema }),
  recordExpense: (input: RecordExpenseInput) =>
    apiClient.post('/api/finance/expenses', input, { schema: expenseResultSchema }),
  chargeDues: (input: ChargeDuesInput) => apiClient.post('/api/finance/dues', input, { schema: duesResultSchema }),
  previewDues: (input: DuesBulkInput, signal?: AbortSignal) =>
    apiClient.post('/api/finance/dues/preview', input, { signal, schema: duesPreviewSchema }),
  payables: (signal?: AbortSignal) =>
    apiClient.get('/api/finance/payables', { signal, schema: z.object({ items: z.array(payableAccountSchema), totalOpen: kurus }) }),
  recordPayablePayment: (accountId: string, input: RecordPayablePaymentInput) =>
    apiClient.post(`/api/finance/payables/${encodeURIComponent(accountId)}/payments`, input, {
      schema: z.object({ replayed: z.boolean(), transaction: z.object({ transactionId: z.string() }), openBalance: kurus }),
    }),
};

export const CATEGORY_LABELS: Record<TransactionCategory, string> = {
  income: 'Gelir',
  expense: 'Gider',
  transfer: 'Transfer',
  accrual: 'Tahakkuk',
  reversal: 'Düzeltme',
};

export const DUES_STATUS_LABELS: Record<DuesStatus, string> = {
  overdue: 'Gecikmede',
  pending: 'Bekliyor',
  paid: 'Ödendi',
  advance: 'Avans',
  none: 'Tahakkuk yok',
};

export const PARTY_LABELS: Record<LiableParty, string> = {
  occupant: 'Sakin (kiracı / oturan)',
  owner: 'Kat maliki',
};
