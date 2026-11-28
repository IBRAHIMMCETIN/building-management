import { z } from 'zod';
import { type FeatureKey, LICENSABLE_KEYS } from '@/lib/features/catalog';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';

/*
 * Abonelik / lisans (apps/api/src/modules/subscriptions). Tutarlar KDV HARIC kurus (fatura: KDV ayri).
 *   Yonetici  : GET /api/subscription/status (tum yonetim paneli rolleri), GET /api/subscription,
 *               GET /api/subscription/invoices/:invoiceId/pdf
 *   Platform  : GET|PUT /api/admin/billing/settings (varsayilan kapali; otomasyon ayri), GET|POST /api/admin/billing/plans, POST /plans/seed, GET|PUT /plans/:code, POST /plans/:code/status
 *               GET /api/admin/billing/subscriptions?status=, GET|POST /subscriptions/:apartmentId,
 *               POST /subscriptions/:apartmentId/plan|status|sync
 *               GET /api/admin/billing/invoices?status=&cursor=, POST /invoices/:apt/:id/paid|void, GET .../pdf
 * Platform komisyon faturalari (online odeme) ayri ekrandir: lib/api/payments.ts.
 */

const kurus = z.number().int();

/** Plan modulleri Adim 1 site ozellik katalogunun `licensable` anahtarlaridir (ayri bir liste yok). */
export const PLAN_FEATURES: readonly FeatureKey[] = LICENSABLE_KEYS;
export type PlanFeature = FeatureKey;

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type SubscriptionListStatus = SubscriptionStatus | 'legacy';

export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const PRICING_MODELS = ['flat', 'per_unit', 'tiered'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const SUBSCRIPTION_ACTIONS = ['extend_trial', 'activate', 'suspend', 'cancel', 'reactivate'] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'online', 'other'] as const;
export type InvoicePaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVOICE_STATUSES = ['issued', 'paid', 'void'] as const;
export type SubscriptionInvoiceStatus = (typeof INVOICE_STATUSES)[number];

const tierSchema = z.object({ maxUnits: z.number().int().nullable(), monthlyKurus: kurus, annualKurus: kurus });
export type PriceTier = z.infer<typeof tierSchema>;

export const pricingSchema = z.object({
  model: z.enum(PRICING_MODELS),
  monthlyKurus: kurus,
  annualKurus: kurus,
  perUnitMonthlyKurus: kurus.optional(),
  perUnitAnnualKurus: kurus.optional(),
  tiers: z.array(tierSchema).optional(),
  vatRateBps: z.number().int(),
});
export type PlanPricing = z.infer<typeof pricingSchema>;

const featuresSchema = z.record(z.string(), z.boolean());
const limitsSchema = z.object({ maxUnits: z.number().int().nullable(), maxStaffUsers: z.number().int().nullable() });
export type PlanLimits = z.infer<typeof limitsSchema>;

export const planSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().optional(),
  pricing: pricingSchema,
  features: featuresSchema,
  limits: limitsSchema,
  trialDays: z.number().int(),
  placeholder: z.boolean().optional(),
  status: z.enum(['active', 'archived']),
  planVersion: z.number().int(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type Plan = z.infer<typeof planSchema>;

const plansSchema = z.object({ items: z.array(planSchema) });
const seedSchema = z.object({ created: z.array(z.string()), plans: z.array(planSchema) });
const createPlanSchema = z.object({ created: z.boolean(), plan: planSchema });

const snapshotSchema = z.object({ code: z.string(), name: z.string(), planVersion: z.number().int(), pricing: pricingSchema, features: featuresSchema, limits: limitsSchema });

export const subscriptionSchema = z.object({
  apartmentId: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  plan: snapshotSchema,
  billingPeriod: z.enum(BILLING_PERIODS),
  trialStartedAt: z.string().optional(),
  trialEndsAt: z.string().optional(),
  currentPeriodStart: z.string().optional(),
  currentPeriodEnd: z.string().optional(),
  unitCountSnapshot: z.number().int(),
  graceDays: z.number().int(),
  paymentTermDays: z.number().int(),
  pastDueSince: z.string().optional(),
  suspendedAt: z.string().optional(),
  suspendedReason: z.enum(['non_payment', 'manual']).optional(),
  cancelledAt: z.string().optional(),
  lastRunOn: z.string().optional(),
  version: z.number().int(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

const lineSchema = z.object({ description: z.string(), quantity: z.number().int(), unitPriceKurus: kurus, amountKurus: kurus });

export const invoiceSchema = z.object({
  apartmentId: z.string(),
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  siteName: z.string(),
  status: z.enum(INVOICE_STATUSES),
  periodStart: z.string(),
  periodEnd: z.string(),
  billingPeriod: z.enum(BILLING_PERIODS),
  planName: z.string(),
  planVersion: z.number().int(),
  unitCount: z.number().int(),
  lines: z.array(lineSchema),
  netKurus: kurus,
  vatRateBps: z.number().int(),
  vatKurus: kurus,
  totalKurus: kurus,
  issueDate: z.string(),
  dueDate: z.string(),
  paidOn: z.string().optional(),
  paymentReference: z.string().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  voidReason: z.string().optional(),
  version: z.number().int(),
});
export type SubscriptionInvoice = z.infer<typeof invoiceSchema>;

const listItemSchema = z.object({
  apartmentId: z.string(),
  siteName: z.string(),
  city: z.string(),
  siteStatus: z.enum(['active', 'inactive']),
  status: z.enum(['legacy', ...SUBSCRIPTION_STATUSES]),
  subscription: subscriptionSchema.optional(),
  daysLeft: z.number().int().optional(),
});
export type SubscriptionListItem = z.infer<typeof listItemSchema>;
const subscriptionListSchema = z.object({ items: z.array(listItemSchema), counts: z.record(z.string(), z.number().int()) });
export type SubscriptionList = z.infer<typeof subscriptionListSchema>;

const totalsSchema = z.object({ net: kurus, vat: kurus, total: kurus, unpaid: kurus });
const invoicePageSchema = z.object({ items: z.array(invoiceSchema), totals: totalsSchema, nextCursor: z.string().optional() });
export type SubscriptionInvoicePage = z.infer<typeof invoicePageSchema>;

const startResultSchema = z.object({ created: z.boolean(), subscription: subscriptionSchema });
const statusResultSchema = z.object({ subscription: subscriptionSchema });
const settleResultSchema = z.object({ invoice: invoiceSchema, subscription: subscriptionSchema });
const syncResultSchema = z.object({ status: z.string() }).passthrough();

// ----- Platform ayari (varsayilan kapali) -----

export const billingSettingsSchema = z.object({ enabled: z.boolean(), automation: z.boolean(), version: z.number().int(), updatedAt: z.string().optional() });
export type BillingSettings = z.infer<typeof billingSettingsSchema>;
export type BillingSettingsInput = { version: number; enabled: boolean; automation: boolean; reason: string };

// ----- Yonetici -----

export const statusViewSchema = z.object({
  status: z.enum(['legacy', ...SUBSCRIPTION_STATUSES]),
  legacy: z.boolean(),
  readOnly: z.boolean(),
  trialEndsAt: z.string().optional(),
  daysLeft: z.number().int().optional(),
  pastDueSince: z.string().optional(),
  suspendOn: z.string().optional(),
  suspendedAt: z.string().optional(),
});
export type SubscriptionStatusView = z.infer<typeof statusViewSchema>;

export const managerViewSchema = statusViewSchema.extend({
  features: featuresSchema,
  limits: limitsSchema,
  usage: z.object({ units: z.number().int(), staffUsers: z.number().int() }),
  plan: z.object({ code: z.string(), name: z.string(), planVersion: z.number().int(), pricing: pricingSchema }).optional(),
  billingPeriod: z.enum(BILLING_PERIODS).optional(),
  trialStartedAt: z.string().optional(),
  currentPeriodStart: z.string().optional(),
  currentPeriodEnd: z.string().optional(),
  graceDays: z.number().int().optional(),
  paymentTermDays: z.number().int().optional(),
  invoices: z.array(invoiceSchema),
});
export type SubscriptionManagerView = z.infer<typeof managerViewSchema>;

// ----- Girdiler -----

export type PlanInput = {
  name: string;
  description?: string;
  pricing: PlanPricing;
  features: Partial<Record<PlanFeature, boolean>>;
  limits: PlanLimits;
  trialDays: number;
};
export type StartInput = { idempotencyKey: string; planCode: string; billingPeriod: BillingPeriod; trialDays?: number; reason?: string };
export type StatusInput = { version: number; action: SubscriptionAction; reason: string; trialEndsAt?: string };
export type ChangePlanInput = { version: number; planCode: string; reason: string };
export type MarkPaidInput = { version: number; method: InvoicePaymentMethod; reference: string; paidOn?: string; note?: string };

const enc = encodeURIComponent;
const B = '/api/admin/billing';

export const subscriptionsApi = {
  // Yonetici
  status: (signal?: AbortSignal) => apiClient.get('/api/subscription/status', { signal, schema: statusViewSchema }),
  mine: (signal?: AbortSignal) => apiClient.get('/api/subscription', { signal, schema: managerViewSchema }),
  myInvoicePdf: (invoiceId: string) => apiClient.get(`/api/subscription/invoices/${enc(invoiceId)}/pdf`, { schema: signedDownloadSchema }),

  // Platform: ayar
  settings: (signal?: AbortSignal) => apiClient.get(`${B}/settings`, { signal, schema: billingSettingsSchema }),
  updateSettings: (input: BillingSettingsInput) => apiClient.put(`${B}/settings`, input, { schema: billingSettingsSchema }),

  // Platform: planlar
  plans: (signal?: AbortSignal) => apiClient.get(`${B}/plans`, { signal, schema: plansSchema }),
  seedPlans: () => apiClient.post(`${B}/plans/seed`, {}, { schema: seedSchema }),
  createPlan: (input: PlanInput & { code: string; idempotencyKey: string }) => apiClient.post(`${B}/plans`, input, { schema: createPlanSchema }),
  updatePlan: (code: string, input: PlanInput & { version: number; reason: string }) => apiClient.put(`${B}/plans/${enc(code)}`, input, { schema: planSchema }),
  setPlanStatus: (code: string, input: { version: number; status: 'active' | 'archived'; reason: string }) =>
    apiClient.post(`${B}/plans/${enc(code)}/status`, input, { schema: planSchema }),

  // Platform: abonelikler
  subscriptions: (signal?: AbortSignal) => apiClient.get(`${B}/subscriptions`, { signal, schema: subscriptionListSchema }),
  start: (apartmentId: string, input: StartInput) => apiClient.post(`${B}/subscriptions/${enc(apartmentId)}`, input, { schema: startResultSchema }),
  changeStatus: (apartmentId: string, input: StatusInput) => apiClient.post(`${B}/subscriptions/${enc(apartmentId)}/status`, input, { schema: statusResultSchema }),
  changePlan: (apartmentId: string, input: ChangePlanInput) => apiClient.post(`${B}/subscriptions/${enc(apartmentId)}/plan`, input, { schema: subscriptionSchema }),
  sync: (apartmentId: string) => apiClient.post(`${B}/subscriptions/${enc(apartmentId)}/sync`, {}, { schema: syncResultSchema }),

  // Platform: faturalar
  invoices: (cursor: string | undefined, signal?: AbortSignal) =>
    apiClient.get(`${B}/invoices`, { signal, query: { limit: '100', ...(cursor ? { cursor } : {}) }, schema: invoicePageSchema }),
  markPaid: (apartmentId: string, invoiceId: string, input: MarkPaidInput) =>
    apiClient.post(`${B}/invoices/${enc(apartmentId)}/${enc(invoiceId)}/paid`, input, { schema: settleResultSchema }),
  voidInvoice: (apartmentId: string, invoiceId: string, input: { version: number; reason: string }) =>
    apiClient.post(`${B}/invoices/${enc(apartmentId)}/${enc(invoiceId)}/void`, input, { schema: settleResultSchema }),
  invoicePdf: (apartmentId: string, invoiceId: string) => apiClient.get(`${B}/invoices/${enc(apartmentId)}/${enc(invoiceId)}/pdf`, { schema: signedDownloadSchema }),
};
