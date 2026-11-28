import {
  type QuoteInput,
  type TenderInput,
  assemblyDecisionOptionsSchema,
  tenderWriteSchema as created,
  tenderResponseSchema as one,
  supplierAccountOptionsSchema,
  tenderSummarySchema,
} from '@bm/shared/api/tenders';
import { z } from 'zod';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import type { RecordExpenseInput } from './finance';

/*
 * Ihale / teklif toplama (apps/api/src/modules/tenders).
 *  - Yonetim: /api/tenders (yazma: yonetici + yonetim firmasi; okuma: + denetci, denetci yalnizca
 *    yayinlanmis ihaleleri gorur)
 *  - Sakin:   /api/portal/tenders (yalnizca yayinlanmis ihaleler; teklif belgeleri 5 dk imzali link)
 * Tutarlar kurus; `totalKurus` KDV dahil normalize toplamdir (karsilastirma bunun uzerinden).
 * Teklif belgesi: once `documentsApi.uploadInvoice` (gider faturasiyla ayni sinirlar), donen
 * `{ uploadId, fileName }` teklif kaydina `document` olarak eklenir.
 * Semalar ve tipler web + mobil ortak: packages/shared/src/api/tenders.ts (burada yeniden disa aktarilir).
 */

export {
  TENDER_CATEGORIES,
  TENDER_STATUSES,
  type AssemblyDecisionLink,
  type AssemblyDecisionOption,
  type ExpenseProgress,
  type SupplierAccountOption,
  type TenderExpense,
  commentSchema,
  comparisonSchema,
  decisionSchema,
  quoteSchema,
  tenderSchema,
  tenderSummarySchema,
  type Quote,
  type QuoteComparison,
  type QuoteInput,
  type Tender,
  type TenderCategory,
  type TenderComment,
  type TenderDecision,
  type TenderInput,
  type TenderStatus,
  type TenderSummary,
} from '@bm/shared/api/tenders';

const enc = encodeURIComponent;

export type AssemblyDecisionRef = { assemblyId: string; itemId: string };
export type TenderExpenseInput = RecordExpenseInput & { overrunReason?: string };
const A = '/api/tenders';
const P = '/api/portal/tenders';

export const tendersApi = {
  list: (signal?: AbortSignal) => apiClient.get(A, { signal, schema: z.object({ items: z.array(tenderSummarySchema) }) }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${A}/${enc(id)}`, { signal, schema: one }),
  create: (input: TenderInput & { idempotencyKey: string }) => apiClient.post(A, input, { schema: created }),
  update: (id: string, input: Partial<TenderInput> & { version: number }) => apiClient.patch(`${A}/${enc(id)}`, input, { schema: one }),
  collect: (id: string, input: { version: number }) => apiClient.post(`${A}/${enc(id)}/collect`, input, { schema: one }),
  publish: (id: string, input: { version: number; shortfallReason?: string }) => apiClient.post(`${A}/${enc(id)}/publish`, input, { schema: one }),
  decide: (id: string, input: { version: number; quoteId: string; reason: string; reference?: string; assemblyDecision?: AssemblyDecisionRef }) =>
    apiClient.post(`${A}/${enc(id)}/decide`, input, { schema: one }),
  /** Ayni apartmanin guncel genel kurul kararlari (karar baglantisi secicisi). */
  assemblyDecisions: (signal?: AbortSignal) => apiClient.get(`${A}/assembly-decisions`, { signal, schema: assemblyDecisionOptionsSchema }),
  /** Genel kurul karar bagi; `null` bagi kaldirir. */
  linkAssemblyDecision: (id: string, input: { version: number; assemblyDecision: AssemblyDecisionRef | null }) => apiClient.post(`${A}/${enc(id)}/assembly-decision`, input, { schema: one }),
  /** Eslestirme icin Finans tedarikci hesaplari (firma adina benzeyenler once). */
  supplierAccounts: (id: string, signal?: AbortSignal) => apiClient.get(`${A}/${enc(id)}/supplier-accounts`, { signal, schema: supplierAccountOptionsSchema }),
  /** Kazanan firma -> Finans tedarikci hesabi; `null` bagi kaldirir. */
  linkSupplier: (id: string, input: { version: number; accountId: string | null }) => apiClient.post(`${A}/${enc(id)}/supplier`, input, { schema: one }),
  /** Sakin sorusunu gerekceyle gizler (moderasyon). */
  hideComment: (id: string, commentId: string, input: { reason: string }) => apiClient.post(`${A}/${enc(id)}/comments/${enc(commentId)}/hide`, input, { schema: one }),
  cancel: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/${enc(id)}/cancel`, input, { schema: one }),
  addQuote: (id: string, input: QuoteInput & { idempotencyKey: string }) => apiClient.post(`${A}/${enc(id)}/quotes`, input, { schema: created.extend({ quoteId: z.string() }) }),
  updateQuote: (id: string, quoteId: string, input: Partial<QuoteInput> & { version: number }) => apiClient.patch(`${A}/${enc(id)}/quotes/${enc(quoteId)}`, input, { schema: one }),
  withdrawQuote: (id: string, quoteId: string, input: { version: number; reason: string }) => apiClient.post(`${A}/${enc(id)}/quotes/${enc(quoteId)}/withdraw`, input, { schema: one }),
  /** `history`: degistirilmis onceki belgenin sirasi (yalnizca yonetim). */
  document: (id: string, quoteId: string, history?: number) =>
    apiClient.get(`${A}/${enc(id)}/quotes/${enc(quoteId)}/document`, { query: history === undefined ? undefined : { history: String(history) }, schema: signedDownloadSchema }),
  /** Yonetim yaniti; `replyTo`: belirli soruya yanit (bildirim yalnizca o sorunun yazarina). */
  comment: (id: string, input: { idempotencyKey: string; body: string; replyTo?: string }) => apiClient.post(`${A}/${enc(id)}/comments`, input, { schema: created }),
  /** Karardan Finans gideri / hakedis (birden fazla; gecerli toplam karar tutarini asarsa `overrunReason`). */
  createExpense: (id: string, input: TenderExpenseInput) =>
    apiClient.post(`${A}/${enc(id)}/expense`, input, { schema: created.extend({ expenseId: z.string(), transactionId: z.string() }) }),
};

export const portalTendersApi = {
  list: (signal?: AbortSignal) => apiClient.get(P, { signal, schema: z.object({ items: z.array(tenderSummarySchema) }) }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${P}/${enc(id)}`, { signal, schema: one }),
  document: (id: string, quoteId: string) => apiClient.get(`${P}/${enc(id)}/quotes/${enc(quoteId)}/document`, { schema: signedDownloadSchema }),
  comment: (id: string, input: { idempotencyKey: string; body: string }) => apiClient.post(`${P}/${enc(id)}/comments`, input, { schema: created }),
};
