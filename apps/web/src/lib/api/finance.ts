import { z } from 'zod';
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
  overdueUnitCount: z.number().int(),
  pendingUnitCount: z.number().int(),
  fundsAccounts: z.array(z.object({ accountId: z.string(), name: z.string(), type: z.enum(['cash', 'bank']), balance: kurus })),
});

export const TRANSACTION_CATEGORIES = ['income', 'expense', 'transfer', 'accrual', 'reversal'] as const;
export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export const transactionSchema = z.object({
  transactionId: z.string(),
  date: isoDate,
  dueDate: isoDate.optional(),
  description: z.string(),
  kind: z.enum(['dues_charge', 'payment', 'expense', 'reversal', 'late_fee']),
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
      balance: kurus,
      overdue: kurus,
      daysOverdue: z.number().int(),
      status: z.enum(DUES_STATUSES),
      lastPaymentDate: isoDate.optional(),
    }),
  ),
});

export const accountSchema = z.object({
  accountId: z.string(),
  type: z.enum(['cash', 'bank', 'receivable', 'payable', 'income', 'expense']),
  name: z.string(),
  status: z.enum(['active', 'inactive']),
  balance: kurus,
  system: z.boolean().optional(),
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
    }
  | {
      idempotencyKey: string;
      liableParty: LiableParty;
      totalAmount: number;
      distributionKey: 'equal' | 'area' | 'land_share';
      date: string;
      dueDate: string;
      description: string;
    };

const paymentResultSchema = z.object({
  replayed: z.boolean(),
  payment: z.object({ paymentId: z.string(), receiptNumber: z.string(), amount: kurus }),
});
const expenseResultSchema = z.object({ replayed: z.boolean(), expense: z.object({ expenseId: z.string(), amount: kurus }) });
const duesResultSchema = z.union([
  z.object({ mode: z.literal('single'), replayed: z.boolean(), transaction: z.object({ transactionId: z.string() }) }),
  z.object({
    mode: z.literal('bulk'),
    replayed: z.boolean(),
    count: z.number().int(),
    distributedAmount: kurus,
  }),
]);

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
  recordPayment: (input: RecordPaymentInput) =>
    apiClient.post('/api/finance/payments', input, { schema: paymentResultSchema }),
  recordExpense: (input: RecordExpenseInput) =>
    apiClient.post('/api/finance/expenses', input, { schema: expenseResultSchema }),
  chargeDues: (input: ChargeDuesInput) => apiClient.post('/api/finance/dues', input, { schema: duesResultSchema }),
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
