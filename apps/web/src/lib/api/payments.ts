import { quoteSchema } from '@bm/shared/api/payments';
import { z } from 'zod';
import { apiClient } from './client';

/*
 * Online odeme (apps/api/src/modules/payments). Tum tutarlar kurus cinsinden tam sayidir.
 *   Sakin     : GET  /api/portal/payments/quote?unitId   POST /api/portal/payments
 *               GET  /api/portal/payments/:intentId?refresh=1
 *   Yonetici  : GET  /api/finance/online-payments?status&limit&cursor   GET .../account
 *   Platform  : GET  /api/admin/payments/apartments
 *               GET|POST|PATCH /api/admin/payments/apartments/:apartmentId/account
 *               GET|PUT /api/admin/payments/apartments/:apartmentId/settings      (P5: saglayici secimi)
 *               GET  /api/admin/payments/review
 *               GET  /api/admin/payments/apartments/:apartmentId/intents/:intentId/check
 *               POST /api/admin/payments/apartments/:apartmentId/intents/:intentId/resolve
 *               GET  /api/admin/payments/settlements | POST .../intents/:intentId/release     (P5)
 *               GET  /api/admin/payments/payouts     | POST .../payouts/:transferId/resend    (P5)
 *               GET  /api/admin/payments/invoices    | POST .../invoices/draft|:id/issue|:id/cancel (P5)
 * Kart verisi bu uygulamaya hic gelmez: odeme saglayicinin (iyzico / PayTR) sayfasinda yapilir.
 * Tam IBAN yalnizca platform formundan API'ye gider (KMS ile sifrelenir); hicbir yanitta donmez.
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);
export type LiableParty = z.infer<typeof party>;

export const INTENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'REFUND_PENDING', 'REFUNDED'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

// ----- Sakin -----

// Teklif semalari (acik kalemler, cari bazli teklif) web + mobil ortak: packages/shared/src/api/payments.ts.
export { type OpenDue, type PartyQuote, type PaymentQuote, quoteSchema } from '@bm/shared/api/payments';

export const intentSchema = z.object({
  intentId: z.string(),
  status: z.enum(INTENT_STATUSES),
  mode: z.enum(['total', 'items']),
  unitId: z.string(),
  currency: z.literal('TRY'),
  amount: kurus,
  allocations: z.array(
    z.object({ liableParty: party, principal: kurus, lateFee: kurus, amount: kurus, transactionIds: z.array(z.string()) }),
  ),
  paymentPageUrl: z.string().url().optional(),
  /** Yalnizca PENDING iken: tam sayfa yonlendirme (iyzico) veya gomulu iframe (PayTR). */
  checkoutKind: z.enum(['redirect', 'iframe']).optional(),
  paidAt: z.string().optional(),
  paymentIds: z.array(z.string()).optional(),
  receiptNumbers: z.array(z.string()).optional(),
  failureMessage: z.string().optional(),
  expiresAt: z.string(),
  createdAt: z.string(),
  replayed: z.boolean().optional(),
});
export type PaymentIntent = z.infer<typeof intentSchema>;

export type CreatePaymentInput = {
  idempotencyKey: string;
  unitId?: string;
  mode: 'total' | 'items';
  items?: { liableParty: LiableParty; transactionId: string }[];
  /** Yalnizca canli saglayicida; saklanmaz, saglayiciya iletilir. */
  gsmNumber?: string;
  identityNumber?: string;
};

// ----- Yonetici -----

export const managerIntentSchema = z.object({
  intentId: z.string(),
  status: z.enum(INTENT_STATUSES),
  mode: z.enum(['total', 'items']),
  unitId: z.string(),
  userId: z.string(),
  amount: kurus,
  platformFee: kurus,
  allocations: z.array(z.object({ liableParty: party, principal: kurus, lateFee: kurus, amount: kurus })),
  provider: z.string(),
  providerPaymentId: z.string().optional(),
  paidAt: z.string().optional(),
  paymentIds: z.array(z.string()).optional(),
  receiptNumbers: z.array(z.string()).optional(),
  failure: z.object({ code: z.string(), message: z.string(), at: z.string() }).optional(),
  review: z.object({ reason: z.string(), at: z.string() }).optional(),
  /** Platform ekibinin karari (yalnizca inceleme sonuclandiysa). */
  resolution: z.object({ action: z.enum(['approve', 'refund', 'close']), note: z.string(), at: z.string() }).optional(),
  /** Iade edilen toplam (yalnizca iade kararinda). */
  refundedAmount: kurus.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagerIntent = z.infer<typeof managerIntentSchema>;

const managerListSchema = z.object({ items: z.array(managerIntentSchema), nextCursor: z.string().optional() });

export const SUB_MERCHANT_TYPES = ['PRIVATE_COMPANY', 'LIMITED_OR_JOINT_STOCK_COMPANY', 'PERSONAL'] as const;
export type SubMerchantType = (typeof SUB_MERCHANT_TYPES)[number];

export const accountSummarySchema = z.object({
  configured: z.boolean(),
  provider: z.string().optional(),
  sandbox: z.boolean().optional(),
  status: z.enum(['not_registered', 'active', 'disabled']),
  subMerchantType: z.enum(SUB_MERCHANT_TYPES).optional(),
  ibanMasked: z.string().optional(),
  platformFeeBasisPoints: z.number().int().optional(),
  updatedAt: z.string().optional(),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

// ----- Platform -----

const invoiceRecipientSchema = z.object({ title: z.string(), taxNumber: z.string(), taxOffice: z.string() });
export type InvoiceRecipient = z.infer<typeof invoiceRecipientSchema>;

export const paymentAccountSchema = z.object({
  apartmentId: z.string(),
  provider: z.string(),
  subMerchantKey: z.string(),
  subMerchantType: z.enum(SUB_MERCHANT_TYPES),
  ibanMasked: z.string().optional(),
  /** P4: aktarim alicisi (IBAN + ad) KMS ile sifreli kayitli mi (PayTR transferi icin zorunlu). */
  payeeOnFile: z.boolean().optional(),
  status: z.enum(['active', 'disabled']),
  platformFeeBasisPoints: z.number().int(),
  /** Hesaba ozel POS orani / sabit ucret; yoksa ortam varsayilani. */
  posRateBasisPoints: z.number().int().optional(),
  posFixedFeeKurus: kurus.optional(),
  effectiveFees: z
    .object({ platformBasisPoints: z.number().int(), posRateBasisPoints: z.number().int(), posFixedFeeKurus: kurus })
    .optional(),
  /** Platform komisyon faturasinin muhatabi (VKN). Yoksa fatura taslagi NEEDS_RECIPIENT olur. */
  invoiceRecipient: invoiceRecipientSchema.optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  version: z.number().int(),
});
export type PaymentAccount = z.infer<typeof paymentAccountSchema>;

const providerInfoSchema = z.object({ name: z.string(), sandbox: z.boolean(), capabilities: z.record(z.string(), z.unknown()).optional() });
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

export const platformApartmentsSchema = z.object({
  /** Ortam varsayilan saglayicisi (yoksa null: online odeme kapali). */
  provider: z.string().nullable(),
  sandbox: z.boolean().nullable(),
  /** Bu ortamda acik saglayicilar. */
  providers: z.array(providerInfoSchema).default([]),
  items: z.array(
    z.object({
      apartmentId: z.string(),
      name: z.string(),
      city: z.string(),
      district: z.string(),
      siteStatus: z.string(),
      /** Apartman tercihi; null = ortam varsayilani. */
      paymentProvider: z.string().nullable().default(null),
      effectiveProvider: z.string().nullable().default(null),
      account: paymentAccountSchema.nullable(),
    }),
  ),
});
export type PlatformApartment = z.infer<typeof platformApartmentsSchema>['items'][number];

export type SubMerchantInput = {
  subMerchantType: SubMerchantType;
  name?: string;
  email: string;
  gsmNumber: string;
  address: string;
  iban: string;
  taxOffice?: string;
  taxNumber?: string;
  legalCompanyTitle?: string;
  contactName?: string;
  contactSurname?: string;
  identityNumber?: string;
  platformFeeBasisPoints: number;
  /** Banka hesabindaki ad/unvan (PayTR aktarim alicisi); verilmezse unvan / ad soyad. */
  accountHolderName?: string;
  /** Saglayici (verilmezse apartmanin cozumlenen saglayicisi). */
  provider?: string;
  posRateBasisPoints?: number;
  posFixedFeeKurus?: number;
  invoiceRecipient?: InvoiceRecipient | null;
};

export type AccountPatch = {
  provider?: string;
  status?: 'active' | 'disabled';
  platformFeeBasisPoints?: number;
  /** null: ortam varsayilanina don. */
  posRateBasisPoints?: number | null;
  posFixedFeeKurus?: number | null;
  /** IBAN ve hesap sahibi adi birlikte gonderilir (sifreli alici yeniden olusturulur). */
  iban?: string;
  accountHolderName?: string;
  invoiceRecipient?: InvoiceRecipient | null;
};

// ----- Platform: saglayici secimi (P5) -----

export const paymentSettingsSchema = z.object({
  apartmentId: z.string(),
  paymentProvider: z.string().nullable(),
  defaultProvider: z.string().nullable(),
  effectiveProvider: z.string().nullable(),
  source: z.string().optional(),
  available: z.array(providerInfoSchema),
  version: z.number().int(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>;

// ----- Platform: aktarimlar (P5) -----

export const PAYOUT_STATUSES = ['SENT', 'SETTLED', 'RETURNED', 'RESEND_PENDING', 'RESEND_SENT', 'RESENT', 'RESEND_FAILED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const errorInfo = z.object({ code: z.string(), message: z.string(), at: z.string() });

export const payoutSchema = z.object({
  apartmentId: z.string(),
  apartmentName: z.string().nullable().optional(),
  provider: z.string(),
  intentId: z.string(),
  itemId: z.string(),
  transferId: z.string(),
  providerPaymentId: z.string(),
  amount: kurus,
  grossAmount: kurus,
  ibanMasked: z.string(),
  status: z.enum(PAYOUT_STATUSES),
  sentAt: z.string(),
  providerReference: z.string().optional(),
  settledAt: z.string().optional(),
  returned: z.object({ refNo: z.string(), detectedAt: z.string(), returnedOn: z.string().optional(), amount: kurus }).optional(),
  resendCount: z.number().int().optional(),
  resend: z
    .object({
      resendId: z.string(),
      requestedAt: z.string(),
      requestedBy: z.string(),
      note: z.string(),
      ibanMasked: z.string(),
      attempts: z.number().int(),
      sentAt: z.string().optional(),
      completedAt: z.string().optional(),
      error: errorInfo.optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type Payout = z.infer<typeof payoutSchema>;
const payoutListSchema = z.object({ items: z.array(payoutSchema) });

export type ResendInput = { note: string; expectedVersion: number; iban?: string; accountHolderName?: string };

export const settlementSchema = z.object({
  apartmentId: z.string(),
  apartmentName: z.string().nullable(),
  intentId: z.string(),
  unitId: z.string(),
  provider: z.string(),
  amount: kurus,
  transferAmount: kurus,
  paidAt: z.string().optional(),
  settlementStatus: z.enum(['pending', 'approved', 'failed']),
  approvals: z.array(
    z.object({
      itemId: z.string(),
      status: z.string(),
      attempts: z.number().int(),
      releaseAfter: z.string().optional(),
      transferId: z.string().optional(),
      error: errorInfo.optional(),
    }),
  ),
  version: z.number().int(),
});
export type Settlement = z.infer<typeof settlementSchema>;
const settlementListSchema = z.object({ items: z.array(settlementSchema) });

// ----- Platform: komisyon faturalari (P5) -----

export const INVOICE_STATUSES = ['DRAFT', 'NEEDS_RECIPIENT', 'ISSUED', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const platformInvoiceSchema = z.object({
  invoiceId: z.string(),
  apartmentId: z.string(),
  apartmentName: z.string().nullable().optional(),
  mode: z.enum(['monthly', 'per_payment']),
  period: z.string(),
  status: z.enum(INVOICE_STATUSES),
  recipient: invoiceRecipientSchema.optional(),
  lines: z.array(z.object({ intentId: z.string(), paidAt: z.string().optional(), amount: kurus, platformFee: kurus })),
  netAmount: kurus,
  vatRateBasisPoints: z.number().int(),
  vatMode: z.enum(['exclusive', 'inclusive']),
  vatAmount: kurus,
  totalAmount: kurus,
  invoiceProvider: z.string(),
  invoiceNumber: z.string().optional(),
  issuedAt: z.string().optional(),
  issuedBy: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type PlatformInvoice = z.infer<typeof platformInvoiceSchema>;

const invoicePeriodSchema = z.object({
  period: z.string(),
  items: z.array(platformInvoiceSchema),
  totals: z.object({ net: kurus, vat: kurus, total: kurus }),
});
export type InvoicePeriod = z.infer<typeof invoicePeriodSchema>;
const draftResultSchema = z.object({}).passthrough();

// ----- Platform: inceleme sonuclandirma -----

export const REVIEW_ACTIONS = ['approve', 'refund', 'close'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const providerCheckSchema = z.object({
  status: z.enum(['success', 'failure', 'pending']),
  providerPaymentId: z.string().optional(),
  paidAmount: kurus.optional(),
  currency: z.string().optional(),
  fraudApproved: z.boolean().optional(),
  problems: z.array(z.string()),
  errorMessage: z.string().optional(),
  checkedAt: z.string(),
});
export type ProviderCheck = z.infer<typeof providerCheckSchema>;

const refundItemSchema = z.object({
  paymentTransactionId: z.string(),
  itemId: z.string(),
  amount: kurus,
  status: z.enum(['pending', 'succeeded', 'failed']),
  attempts: z.number().int(),
  attemptedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string(), at: z.string() }).optional(),
});
export type RefundItem = z.infer<typeof refundItemSchema>;

export const reviewIntentSchema = managerIntentSchema.extend({
  apartmentId: z.string(),
  version: z.number().int(),
  resolution: z
    .object({ action: z.enum(REVIEW_ACTIONS), note: z.string(), by: z.string(), at: z.string(), providerCheck: providerCheckSchema })
    .optional(),
  refund: z
    .object({ items: z.array(refundItemSchema), requestedAt: z.string(), requestedBy: z.string(), completedAt: z.string().optional() })
    .optional(),
});
export type ReviewIntent = z.infer<typeof reviewIntentSchema>;

const reviewQueueSchema = z.object({ items: z.array(reviewIntentSchema.extend({ apartmentName: z.string() })) });
export type ReviewQueueItem = z.infer<typeof reviewQueueSchema>['items'][number];

export const reviewCheckSchema = z.object({
  intent: reviewIntentSchema,
  check: providerCheckSchema.nullable(),
  actions: z.array(z.object({ action: z.enum(REVIEW_ACTIONS), allowed: z.boolean(), reason: z.string().optional() })),
});
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;

const resolveResultSchema = z.object({ intent: reviewIntentSchema });

export type ResolveInput = { action: ReviewAction; note: string; expectedVersion: number };

// ----- Istemci -----

export const paymentsApi = {
  quote: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/payments/quote', { signal, query: unitId ? { unitId } : undefined, schema: quoteSchema }),
  create: (input: CreatePaymentInput) => apiClient.post('/api/portal/payments', input, { schema: intentSchema }),
  get: (intentId: string, refresh: boolean, signal?: AbortSignal) =>
    apiClient.get(`/api/portal/payments/${encodeURIComponent(intentId)}`, {
      signal,
      query: refresh ? { refresh: 1 } : undefined,
      schema: intentSchema,
    }),

  managerList: (params: { status?: IntentStatus; limit?: number; cursor?: string }, signal?: AbortSignal) =>
    apiClient.get('/api/finance/online-payments', { signal, query: params, schema: managerListSchema }),
  managerAccount: (signal?: AbortSignal) =>
    apiClient.get('/api/finance/online-payments/account', { signal, schema: accountSummarySchema }),

  platformApartments: (signal?: AbortSignal) =>
    apiClient.get('/api/admin/payments/apartments', { signal, schema: platformApartmentsSchema }),
  onboard: (apartmentId: string, input: SubMerchantInput) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/account`, input, {
      schema: paymentAccountSchema,
    }),
  reviewQueue: (signal?: AbortSignal) => apiClient.get('/api/admin/payments/review', { signal, schema: reviewQueueSchema }),
  reviewCheck: (apartmentId: string, intentId: string, signal?: AbortSignal) =>
    apiClient.get(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/intents/${encodeURIComponent(intentId)}/check`, {
      signal,
      schema: reviewCheckSchema,
    }),
  resolveReview: (apartmentId: string, intentId: string, input: ResolveInput) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/intents/${encodeURIComponent(intentId)}/resolve`, input, {
      schema: resolveResultSchema,
    }),
  updateAccount: (apartmentId: string, patch: AccountPatch) =>
    apiClient.patch(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/account`, patch, {
      schema: paymentAccountSchema,
    }),

  settings: (apartmentId: string, signal?: AbortSignal) =>
    apiClient.get(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/settings`, { signal, schema: paymentSettingsSchema }),
  updateSettings: (apartmentId: string, input: { paymentProvider: string | null; expectedVersion: number }) =>
    apiClient.put(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/settings`, input, { schema: paymentSettingsSchema }),

  payouts: (params: { status?: PayoutStatus | 'all'; days?: number }, signal?: AbortSignal) =>
    apiClient.get('/api/admin/payments/payouts', { signal, query: params, schema: payoutListSchema }),
  resendPayout: (apartmentId: string, transferId: string, input: ResendInput) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/payouts/${encodeURIComponent(transferId)}/resend`, input, {
      schema: draftResultSchema,
    }),
  settlements: (params: { status?: 'pending' | 'failed'; days?: number }, signal?: AbortSignal) =>
    apiClient.get('/api/admin/payments/settlements', { signal, query: params, schema: settlementListSchema }),
  releaseSettlement: (apartmentId: string, intentId: string, input: { note: string; expectedVersion: number }) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/intents/${encodeURIComponent(intentId)}/release`, input, {
      schema: draftResultSchema,
    }),

  invoices: (period: string, signal?: AbortSignal) =>
    apiClient.get('/api/admin/payments/invoices', { signal, query: { period }, schema: invoicePeriodSchema }),
  draftInvoices: (apartmentId: string, period: string) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/invoices/draft`, { period }, { schema: draftResultSchema }),
  issueInvoice: (apartmentId: string, invoiceId: string, input: { expectedVersion: number; invoiceNumber: string }) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/invoices/${encodeURIComponent(invoiceId)}/issue`, input, {
      schema: draftResultSchema,
    }),
  cancelInvoice: (apartmentId: string, invoiceId: string, input: { expectedVersion: number; reason: string }) =>
    apiClient.post(`/api/admin/payments/apartments/${encodeURIComponent(apartmentId)}/invoices/${encodeURIComponent(invoiceId)}/cancel`, input, {
      schema: draftResultSchema,
    }),
};
