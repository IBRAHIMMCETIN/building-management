import { z } from 'zod';
import { apiClient } from './client';

/*
 * Finans 2.2 sonrasi - tedarikci avansi ve avans mahsubu (apps/api/src/modules/finance/supplierAdvances.ts).
 *   GET  /api/finance/supplier-advances?accountId&status       avanslar (acik kalan, mahsuplar)
 *   POST /api/finance/supplier-advances                        { idempotencyKey, payableAccountId, fundsAccountId, amount, date?, description?, reference? }
 *   GET  /api/finance/supplier-advances/:id/offset-preview     acik avans, acik borc, acik faturalar
 *   POST /api/finance/supplier-advances/:id/offsets            { idempotencyKey, amount, date?, settles?, reason }
 *   POST /api/finance/supplier-advances/:id/reverse            { reason } (mahsup edilmemis avans)
 *   POST /api/finance/supplier-advance-offsets/:id/reverse     { reason }
 *   GET  /api/finance/payables/:accountId/statement?from&to    tedarikci ekstresi
 * Tutarlar kurus cinsinden tam sayidir.
 */

const kurus = z.number().int();

export const advanceOffsetSchema = z.object({
  offsetId: z.string(),
  advanceId: z.string(),
  amount: kurus,
  date: z.string(),
  settles: z.array(z.object({ transactionId: z.string(), amount: kurus })),
  transactionId: z.string(),
  status: z.enum(['completed', 'reversed']),
  reason: z.string(),
  reversal: z.object({ at: z.string(), reason: z.string(), transactionId: z.string() }).optional(),
  createdAt: z.string(),
});
export type AdvanceOffset = z.infer<typeof advanceOffsetSchema>;

export const supplierAdvanceSchema = z.object({
  advanceId: z.string(),
  payableAccountId: z.string(),
  fundsAccountId: z.string(),
  amount: kurus,
  applied: kurus,
  open: kurus,
  date: z.string(),
  description: z.string(),
  reference: z.string().optional(),
  transactionId: z.string(),
  status: z.enum(['open', 'applied', 'reversed']),
  reversal: z.object({ at: z.string(), reason: z.string(), transactionId: z.string() }).optional(),
  offsets: z.array(advanceOffsetSchema).default([]),
  createdAt: z.string(),
});
export type SupplierAdvance = z.infer<typeof supplierAdvanceSchema>;

const openItemSchema = z.object({
  transactionId: z.string(),
  date: z.string(),
  description: z.string(),
  reference: z.string().optional(),
  amount: kurus,
  open: kurus,
  advanceApplied: kurus.optional(),
});
export type SupplierOpenItem = z.infer<typeof openItemSchema>;

export const offsetPreviewSchema = z.object({
  advanceId: z.string(),
  payableAccountId: z.string(),
  advanceOpen: kurus,
  openBalance: kurus,
  maxAmount: kurus,
  openItems: z.array(openItemSchema),
});
export type AdvanceOffsetPreview = z.infer<typeof offsetPreviewSchema>;

export const STATEMENT_CATEGORIES = ['invoice', 'payment', 'advance', 'advance_offset', 'reversal', 'other'] as const;
export type StatementCategory = (typeof STATEMENT_CATEGORIES)[number];

const balances = z.object({ payableBalance: z.number().int(), advanceBalance: z.number().int(), net: z.number().int() });

export const supplierStatementSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  opening: balances,
  closing: balances,
  rows: z.array(
    z.object({
      date: z.string(),
      transactionId: z.string(),
      category: z.enum(STATEMENT_CATEGORIES),
      description: z.string(),
      reference: z.string().optional(),
      reversalOf: z.string().optional(),
      payableChange: z.number().int(),
      advanceChange: z.number().int(),
      payableBalance: z.number().int(),
      advanceBalance: z.number().int(),
      net: z.number().int(),
    }),
  ),
  totals: z.object({ invoice: kurus, payment: kurus, advanceGiven: kurus, advanceApplied: kurus }),
  summary: z.object({ billed: kurus, paid: kurus, advanceApplied: kurus, openBalance: kurus, advanceOpen: kurus, net: z.number().int() }),
  openItems: z.array(openItemSchema),
  openAdvances: z.array(z.object({ advanceId: z.string(), date: z.string(), description: z.string(), amount: kurus, applied: kurus, open: kurus })),
});
export type SupplierStatement = z.infer<typeof supplierStatementSchema>;

export type CreateAdvanceInput = {
  idempotencyKey: string;
  payableAccountId: string;
  fundsAccountId: string;
  amount: number;
  date?: string;
  description?: string;
  reference?: string;
};

export type CreateAdvanceOffsetInput = {
  idempotencyKey: string;
  amount: number;
  date?: string;
  settles?: { transactionId: string; amount: number }[];
  reason: string;
};

const enc = encodeURIComponent;

export const supplierAdvancesApi = {
  list: (query: { accountId?: string; status?: SupplierAdvance['status'] }, signal?: AbortSignal) =>
    apiClient.get('/api/finance/supplier-advances', { signal, query, schema: z.object({ items: z.array(supplierAdvanceSchema), totalOpen: kurus }) }),
  create: (input: CreateAdvanceInput) =>
    apiClient.post('/api/finance/supplier-advances', input, { schema: z.object({ replayed: z.boolean(), advance: supplierAdvanceSchema }) }),
  offsetPreview: (advanceId: string, signal?: AbortSignal) =>
    apiClient.get(`/api/finance/supplier-advances/${enc(advanceId)}/offset-preview`, { signal, schema: offsetPreviewSchema }),
  offset: (advanceId: string, input: CreateAdvanceOffsetInput) =>
    apiClient.post(`/api/finance/supplier-advances/${enc(advanceId)}/offsets`, input, {
      schema: z.object({ replayed: z.boolean(), offset: advanceOffsetSchema, advance: supplierAdvanceSchema }),
    }),
  reverseAdvance: (advanceId: string, reason: string) =>
    apiClient.post(`/api/finance/supplier-advances/${enc(advanceId)}/reverse`, { reason }, { schema: z.object({ advance: supplierAdvanceSchema }) }),
  reverseOffset: (offsetId: string, reason: string) =>
    apiClient.post(`/api/finance/supplier-advance-offsets/${enc(offsetId)}/reverse`, { reason }, {
      schema: z.object({ offset: advanceOffsetSchema, advance: supplierAdvanceSchema }),
    }),
  statement: (accountId: string, query: { from?: string; to?: string }, signal?: AbortSignal) =>
    apiClient.get(`/api/finance/payables/${enc(accountId)}/statement`, { signal, query, schema: supplierStatementSchema }),
};
