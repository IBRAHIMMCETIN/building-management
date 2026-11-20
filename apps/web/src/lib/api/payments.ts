import { z } from 'zod';
import { apiClient } from './client';

/*
 * Online odeme (apps/api/src/modules/payments). Tum tutarlar kurus cinsinden tam sayidir.
 *   Sakin     : GET  /api/portal/payments/quote?unitId   POST /api/portal/payments
 *               GET  /api/portal/payments/:intentId?refresh=1
 *   Yonetici  : GET  /api/finance/online-payments?status&limit&cursor   GET .../account
 *   Platform  : GET  /api/admin/payments/apartments
 *               GET|POST|PATCH /api/admin/payments/apartments/:apartmentId/account
 *               GET  /api/admin/payments/review
 *               GET  /api/admin/payments/apartments/:apartmentId/intents/:intentId/check
 *               POST /api/admin/payments/apartments/:apartmentId/intents/:intentId/resolve
 * Kart verisi bu uygulamaya hic gelmez: odeme saglayicinin (iyzico) sayfasinda yapilir.
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);
export type LiableParty = z.infer<typeof party>;

export const INTENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'REFUND_PENDING', 'REFUNDED'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

// ----- Sakin -----

const openDue = z.object({
  transactionId: z.string(),
  liableParty: party,
  description: z.string(),
  date: z.string(),
  dueDate: z.string(),
  amount: kurus,
  paid: kurus,
  remaining: kurus,
  overdue: z.boolean(),
  daysOverdue: z.number().int(),
  lateFee: z.boolean().optional(),
});
export type OpenDue = z.infer<typeof openDue>;

const partyQuote = z.object({
  liableParty: party,
  balance: kurus,
  debt: kurus,
  advance: kurus,
  accruedLateFee: kurus,
  totalDue: kurus,
  /** Secilebilir anapara kalemleri, en eski vade once (yalnizca bastan kesintisiz secilir). */
  items: z.array(openDue),
  /** Deftere yazilmis acik tazminat kalemleri: yalnizca toplam odemede kapanir. */
  postedLateFees: z.array(openDue),
});
export type PartyQuote = z.infer<typeof partyQuote>;

export const quoteSchema = z.object({
  unitId: z.string(),
  currency: z.literal('TRY'),
  onlinePaymentEnabled: z.boolean(),
  requiresGsmNumber: z.boolean().default(false),
  asOf: z.string(),
  lateFeeMonthlyBasisPoints: z.number().int(),
  parties: z.array(partyQuote),
  totalDue: kurus,
});
export type PaymentQuote = z.infer<typeof quoteSchema>;

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

export const paymentAccountSchema = z.object({
  apartmentId: z.string(),
  provider: z.string(),
  subMerchantKey: z.string(),
  subMerchantType: z.enum(SUB_MERCHANT_TYPES),
  ibanMasked: z.string().optional(),
  status: z.enum(['active', 'disabled']),
  platformFeeBasisPoints: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  version: z.number().int(),
});
export type PaymentAccount = z.infer<typeof paymentAccountSchema>;

export const platformApartmentsSchema = z.object({
  provider: z.string().nullable(),
  sandbox: z.boolean().nullable(),
  items: z.array(
    z.object({
      apartmentId: z.string(),
      name: z.string(),
      city: z.string(),
      district: z.string(),
      siteStatus: z.string(),
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
};

export type AccountPatch = { status?: 'active' | 'disabled'; platformFeeBasisPoints?: number };

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
};
