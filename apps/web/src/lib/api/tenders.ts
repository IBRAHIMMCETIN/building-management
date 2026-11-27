import { z } from 'zod';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';

/*
 * Ihale / teklif toplama (apps/api/src/modules/tenders).
 *  - Yonetim: /api/tenders (yazma: yonetici + yonetim firmasi; okuma: + denetci, denetci yalnizca
 *    yayinlanmis ihaleleri gorur)
 *  - Sakin:   /api/portal/tenders (yalnizca yayinlanmis ihaleler; teklif belgeleri 5 dk imzali link)
 * Tutarlar kurus; `totalKurus` KDV dahil normalize toplamdir (karsilastirma bunun uzerinden).
 * Teklif belgesi: once `documentsApi.uploadInvoice` (gider faturasiyla ayni sinirlar), donen
 * `{ uploadId, fileName }` teklif kaydina `document` olarak eklenir.
 */

export const TENDER_STATUSES = ['draft', 'collecting', 'published', 'decided', 'cancelled'] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];
export const TENDER_CATEGORIES = ['mantolama', 'asansor', 'cati', 'boya', 'tesisat', 'elektrik', 'peyzaj', 'other'] as const;
export type TenderCategory = (typeof TENDER_CATEGORIES)[number];

const amounts = { netKurus: z.number(), vatKurus: z.number(), totalKurus: z.number() };

export const quoteSchema = z.object({
  quoteId: z.string(),
  supplierName: z.string(),
  amountKurus: z.number(),
  vatIncluded: z.boolean(),
  vatRate: z.number(),
  validUntil: z.string().optional(),
  deliveryDays: z.number().optional(),
  warrantyMonths: z.number().optional(),
  notes: z.string().optional(),
  document: z.object({ fileName: z.string(), contentType: z.string(), size: z.number() }).optional(),
  /** Yalnizca yonetim: yerine yenisi yuklenen onceki belgeler (eskiden yeniye). */
  documentHistory: z.array(z.object({ fileName: z.string(), contentType: z.string(), size: z.number(), replacedAt: z.string(), replacedBy: z.string() })).optional(),
  status: z.enum(['active', 'withdrawn']),
  withdrawnAt: z.string().optional(),
  withdrawReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ...amounts,
});
export type Quote = z.infer<typeof quoteSchema>;

export const decisionSchema = z.object({
  quoteId: z.string(),
  reason: z.string(),
  reference: z.string().optional(),
  supplierName: z.string(),
  ...amounts,
  decidedAt: z.string(),
  decidedBy: z.string().optional(),
});
export type TenderDecision = z.infer<typeof decisionSchema>;

const ticketLinkSchema = z.object({ ticketId: z.string(), number: z.string(), title: z.string() });

export const tenderSummarySchema = z.object({
  tenderId: z.string(),
  title: z.string(),
  category: z.enum(TENDER_CATEGORIES),
  status: z.enum(TENDER_STATUSES),
  deadline: z.string(),
  deadlinePassed: z.boolean(),
  minQuotes: z.number(),
  quoteCount: z.number(),
  lowestTotalKurus: z.number().optional(),
  ticket: ticketLinkSchema.optional(),
  publishedAt: z.string().optional(),
  decision: decisionSchema.optional(),
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
export type TenderSummary = z.infer<typeof tenderSummarySchema>;

export const comparisonSchema = z.object({
  rows: z.array(z.object({ quoteId: z.string(), ...amounts, rank: z.number(), isLowest: z.boolean(), diffKurus: z.number(), diffBps: z.number() })),
  lowestQuoteIds: z.array(z.string()),
  lowestTotalKurus: z.number().optional(),
  highestTotalKurus: z.number().optional(),
  lowestNetQuoteIds: z.array(z.string()),
});
export type QuoteComparison = z.infer<typeof comparisonSchema>;

export const commentSchema = z.object({
  commentId: z.string(),
  body: z.string(),
  authorKind: z.enum(['resident', 'management']),
  mine: z.boolean(),
  createdAt: z.string(),
  authorId: z.string().optional(),
  authorRole: z.string().optional(),
});
export type TenderComment = z.infer<typeof commentSchema>;

export const tenderSchema = tenderSummarySchema.extend({
  description: z.string(),
  shortfallReason: z.string().optional(),
  cancelReason: z.string().optional(),
  cancelledFrom: z.enum(TENDER_STATUSES).optional(),
  quotes: z.array(quoteSchema),
  comparison: comparisonSchema,
  comments: z.array(commentSchema),
  canComment: z.boolean(),
  readiness: z.object({ activeQuotes: z.number(), minQuotes: z.number(), missingDocuments: z.array(z.string()), shortfall: z.boolean() }).optional(),
});
export type Tender = z.infer<typeof tenderSchema>;

export type TenderInput = { title: string; description: string; category: TenderCategory; deadline: string; minQuotes: number; ticketId?: string | null };
export type QuoteInput = {
  supplierName: string;
  amountKurus: number;
  vatIncluded: boolean;
  vatRate: number;
  validUntil?: string | null;
  deliveryDays?: number | null;
  warrantyMonths?: number | null;
  notes?: string | null;
  document?: { uploadId: string; fileName: string };
};

const enc = encodeURIComponent;
const A = '/api/tenders';
const P = '/api/portal/tenders';
const one = z.object({ tender: tenderSchema });
const created = one.extend({ replayed: z.boolean() });

export const tendersApi = {
  list: (signal?: AbortSignal) => apiClient.get(A, { signal, schema: z.object({ items: z.array(tenderSummarySchema) }) }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${A}/${enc(id)}`, { signal, schema: one }),
  create: (input: TenderInput & { idempotencyKey: string }) => apiClient.post(A, input, { schema: created }),
  update: (id: string, input: Partial<TenderInput> & { version: number }) => apiClient.patch(`${A}/${enc(id)}`, input, { schema: one }),
  collect: (id: string, input: { version: number }) => apiClient.post(`${A}/${enc(id)}/collect`, input, { schema: one }),
  publish: (id: string, input: { version: number; shortfallReason?: string }) => apiClient.post(`${A}/${enc(id)}/publish`, input, { schema: one }),
  decide: (id: string, input: { version: number; quoteId: string; reason: string; reference?: string }) => apiClient.post(`${A}/${enc(id)}/decide`, input, { schema: one }),
  cancel: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/${enc(id)}/cancel`, input, { schema: one }),
  addQuote: (id: string, input: QuoteInput & { idempotencyKey: string }) => apiClient.post(`${A}/${enc(id)}/quotes`, input, { schema: created.extend({ quoteId: z.string() }) }),
  updateQuote: (id: string, quoteId: string, input: Partial<QuoteInput> & { version: number }) => apiClient.patch(`${A}/${enc(id)}/quotes/${enc(quoteId)}`, input, { schema: one }),
  withdrawQuote: (id: string, quoteId: string, input: { version: number; reason: string }) => apiClient.post(`${A}/${enc(id)}/quotes/${enc(quoteId)}/withdraw`, input, { schema: one }),
  /** `history`: degistirilmis onceki belgenin sirasi (yalnizca yonetim). */
  document: (id: string, quoteId: string, history?: number) =>
    apiClient.get(`${A}/${enc(id)}/quotes/${enc(quoteId)}/document`, { query: history === undefined ? undefined : { history: String(history) }, schema: signedDownloadSchema }),
  comment: (id: string, input: { idempotencyKey: string; body: string }) => apiClient.post(`${A}/${enc(id)}/comments`, input, { schema: created }),
};

export const portalTendersApi = {
  list: (signal?: AbortSignal) => apiClient.get(P, { signal, schema: z.object({ items: z.array(tenderSummarySchema) }) }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${P}/${enc(id)}`, { signal, schema: one }),
  document: (id: string, quoteId: string) => apiClient.get(`${P}/${enc(id)}/quotes/${enc(quoteId)}/document`, { schema: signedDownloadSchema }),
  comment: (id: string, input: { idempotencyKey: string; body: string }) => apiClient.post(`${P}/${enc(id)}/comments`, input, { schema: created }),
};
