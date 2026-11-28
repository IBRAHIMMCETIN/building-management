import {
  type CreatePlanRequestInput,
  type PlanRequestStatus,
  myPlanRequestSchema,
  myPlanRequestsSchema,
  planRequestOptionsSchema,
  planRequestWithdrawSchema,
  planRequestWriteSchema,
} from '@bm/shared/api/planRequests';
import { z } from 'zod';
import { apiClient } from './client';

/*
 * Finans 2.2 - avans mahsubu ve borc yapilandirma (apps/api/src/modules/finance/offsets.ts, plans.ts).
 *   Yonetici: /api/finance/offsets*, /api/finance/offset-requests*, /api/finance/plans*
 *   Sakin:    /api/portal/my-plans, /api/portal/offset-options, /api/portal/offset-requests
 * Tutarlar kurus cinsinden tam sayidir; yazma isteklerinde `idempotencyKey` zorunludur.
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);

// ---------------------------------------------------------------------------
// Avans mahsubu
// ---------------------------------------------------------------------------

export const openItemSchema = z.object({
  chargeId: z.string(),
  description: z.string(),
  dueDate: z.string(),
  remaining: kurus,
  overdue: z.boolean(),
  lateFee: z.boolean().optional(),
  plan: z.object({ planId: z.string(), no: z.number().int() }).optional(),
});
export type OpenItem = z.infer<typeof openItemSchema>;

export const offsetPreviewSchema = z.object({
  sourceAccountId: z.string(),
  targetAccountId: z.string(),
  sourceAdvance: kurus,
  targetOpenDebt: kurus,
  maxAmount: kurus,
  samePerson: z.boolean(),
  consentRequired: z.boolean(),
  targetOpenItems: z.array(openItemSchema),
});
export type OffsetPreview = z.infer<typeof offsetPreviewSchema>;

export const offsetSchema = z.object({
  offsetId: z.string(),
  sourceAccountId: z.string(),
  targetAccountId: z.string(),
  sourceUnitId: z.string(),
  targetUnitId: z.string(),
  amount: kurus,
  date: z.string(),
  samePerson: z.boolean(),
  consent: z.object({ thirdParty: z.literal(true), note: z.string() }).optional(),
  requestId: z.string().optional(),
  transactionId: z.string(),
  status: z.enum(['completed', 'reversed']),
  reason: z.string(),
  reversal: z.object({ at: z.string(), by: z.string(), reason: z.string(), transactionId: z.string() }).optional(),
  createdAt: z.string(),
});
export type AccountOffset = z.infer<typeof offsetSchema>;

export const OFFSET_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type OffsetRequestStatus = (typeof OFFSET_REQUEST_STATUSES)[number];

export const offsetRequestSchema = z.object({
  requestId: z.string(),
  userId: z.string(),
  unitId: z.string(),
  sourceAccountId: z.string(),
  targetAccountId: z.string(),
  amount: kurus,
  note: z.string().optional(),
  status: z.enum(OFFSET_REQUEST_STATUSES),
  decision: z.object({ at: z.string(), by: z.string(), reason: z.string(), offsetId: z.string().optional(), amount: kurus.optional() }).optional(),
  createdAt: z.string(),
});
export type OffsetRequest = z.infer<typeof offsetRequestSchema>;

export type OffsetConsent = { thirdParty: true; note: string };
export type CreateOffsetInput = {
  idempotencyKey: string;
  sourceAccountId: string;
  targetAccountId: string;
  amount: number;
  settles?: { chargeId: string; amount: number }[];
  consent?: OffsetConsent;
  reason: string;
};
export type ApproveOffsetRequestInput = { amount?: number; consent?: OffsetConsent; reason?: string };

// ---------------------------------------------------------------------------
// Borc yapilandirma
// ---------------------------------------------------------------------------

export const planRuleSchema = z.object({
  consecutive: z.number().int(),
  total: z.number().int(),
  graceDays: z.number().int(),
  autoAccelerate: z.boolean(),
});
export type PlanRule = z.infer<typeof planRuleSchema>;

const planItemSchema = z.object({ no: z.number().int(), description: z.string(), dueDate: z.string(), amount: kurus, feeBase: kurus });

export const planOpenItemsSchema = z.object({
  accountId: z.string(),
  date: z.string(),
  lateFeeMonthlyBasisPoints: z.number().int(),
  accruedLateFee: kurus,
  activePlanId: z.string().optional(),
  items: z.array(
    z.object({
      chargeId: z.string(),
      description: z.string(),
      dueDate: z.string(),
      amount: kurus,
      remaining: kurus,
      overdue: z.boolean(),
      lateFee: z.boolean(),
      planId: z.string().optional(),
    }),
  ),
});
export type PlanOpenItems = z.infer<typeof planOpenItemsSchema>;

export const planPreviewSchema = z.object({
  accountId: z.string(),
  date: z.string(),
  lateFeeMonthlyBasisPoints: z.number().int(),
  frozenLateFee: kurus,
  includeLateFees: z.boolean(),
  selected: z.array(z.object({ chargeId: z.string(), description: z.string(), dueDate: z.string(), amount: kurus, feeBase: kurus, lateFee: z.boolean() })),
  total: kurus,
  feeBaseTotal: kurus,
  installments: z.array(planItemSchema),
  rule: planRuleSchema,
});
export type PlanPreview = z.infer<typeof planPreviewSchema>;

export const PLAN_DISPLAY_STATUSES = ['active', 'accelerated', 'completed', 'cancelled'] as const;
export type PlanDisplayStatus = (typeof PLAN_DISPLAY_STATUSES)[number];

const installmentStateSchema = planItemSchema.extend({
  chargeId: z.string(),
  paid: kurus,
  remaining: kurus,
  overdue: z.boolean(),
  daysOverdue: z.number().int(),
  settledByAcceleration: z.boolean(),
});

export const planSchema = z.object({
  planId: z.string(),
  accountId: z.string(),
  unitId: z.string(),
  liableParty: party,
  date: z.string(),
  frozenLateFee: kurus,
  includeLateFees: z.boolean(),
  total: kurus,
  feeBaseTotal: kurus,
  installments: z.array(planItemSchema.extend({ chargeId: z.string() })),
  rule: planRuleSchema,
  status: z.enum(['active', 'accelerated', 'cancelled']),
  default: z.object({ detectedAt: z.string(), overdueNos: z.array(z.number().int()) }).optional(),
  acceleration: z
    .object({ at: z.string(), mode: z.enum(['manual', 'auto', 'pull_forward']), amount: kurus, reason: z.string() })
    .optional(),
  cancellation: z.object({ at: z.string(), reason: z.string() }).optional(),
  reason: z.string(),
  createdAt: z.string(),
  state: z.object({
    installments: z.array(installmentStateSchema),
    accelerated: z
      .object({ chargeId: z.string(), dueDate: z.string(), amount: kurus, paid: kurus, remaining: kurus, overdue: z.boolean() })
      .optional(),
    paid: kurus,
    remaining: kurus,
    overdueNos: z.array(z.number().int()),
    inDefault: z.boolean(),
    completed: z.boolean(),
    displayStatus: z.enum(PLAN_DISPLAY_STATUSES),
  }),
});
export type InstallmentPlan = z.infer<typeof planSchema>;

export type PlanInput = {
  accountId: string;
  chargeIds: string[];
  installments: number;
  firstDueDate: string;
  includeLateFees: boolean;
  rule: PlanRule;
};
export type CreatePlanInput = PlanInput & { idempotencyKey: string; reason: string };
export type PlanAction = 'accelerate' | 'pull-forward' | 'cancel';

// ---------------------------------------------------------------------------
// Sakin portali
// ---------------------------------------------------------------------------

export const myPlansSchema = z.object({
  unitId: z.string(),
  items: z.array(
    z.object({
      planId: z.string(),
      liableParty: party,
      date: z.string(),
      total: kurus,
      frozenLateFee: kurus,
      status: z.enum(PLAN_DISPLAY_STATUSES),
      paid: kurus,
      remaining: kurus,
      inDefault: z.boolean(),
      rule: z.object({ consecutive: z.number().int(), total: z.number().int(), graceDays: z.number().int() }),
      installments: z.array(
        z.object({ no: z.number().int(), dueDate: z.string(), amount: kurus, paid: kurus, remaining: kurus, overdue: z.boolean(), accelerated: z.boolean().optional() }),
      ),
      accelerated: z.object({ dueDate: z.string(), amount: kurus, paid: kurus, remaining: kurus, overdue: z.boolean() }).optional(),
    }),
  ),
});
export type MyPlan = z.infer<typeof myPlansSchema>['items'][number];

export const offsetOptionsSchema = z.object({
  unitId: z.string(),
  sources: z.array(z.object({ accountId: z.string(), name: z.string(), advance: kurus })),
  targets: z.array(z.object({ accountId: z.string(), name: z.string(), openDebt: kurus })),
});
export type OffsetOptions = z.infer<typeof offsetOptionsSchema>;

export type CreateOffsetRequestInput = {
  idempotencyKey: string;
  unitId?: string;
  sourceAccountId: string;
  targetAccountId: string;
  amount: number;
  note?: string;
};

// ---------------------------------------------------------------------------
// Sakin yapilandirma talebi (Finans 2.2 sonrasi): yonetim kuyrugu ve ayarlar
// ---------------------------------------------------------------------------

export const planRequestSettingsSchema = z.object({
  enabled: z.boolean(),
  maxInstallments: z.number().int(),
  minInstallmentAmount: kurus,
  includeLateFees: z.boolean(),
});
export type PlanRequestSettings = z.infer<typeof planRequestSettingsSchema>;
export const planRequestSettingsResponseSchema = z.object({ settings: planRequestSettingsSchema, version: z.number().int() });

/** Yonetim gorunumu (sakin gorunumune ek olarak talebi acan kullanici ve karari veren). */
export const planRequestSchema = myPlanRequestSchema.extend({
  userId: z.string(),
  decision: myPlanRequestSchema.shape.decision.unwrap().extend({ by: z.string() }).optional(),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;

export const planRequestDetailSchema = z.object({
  request: planRequestSchema,
  settings: planRequestSettingsSchema,
  current: z
    .object({ overdue: kurus, accruedLateFee: kurus, total: kurus, activePlanId: z.string().optional(), items: planOpenItemsSchema.shape.items })
    .optional(),
  asIs: z
    .object({ accountId: z.string(), chargeIds: z.array(z.string()), installments: z.number().int(), firstDueDate: z.string(), includeLateFees: z.boolean() })
    .optional(),
});
export type PlanRequestDetail = z.infer<typeof planRequestDetailSchema>;

export type ApprovePlanRequestInput = { installments?: number; firstDueDate?: string; includeLateFees?: boolean; chargeIds?: string[]; reason?: string };

const unitQuery = (unitId?: string) => (unitId ? { unitId } : undefined);
const enc = encodeURIComponent;

export const restructureApi = {
  // ----- Yonetici: mahsup -----
  previewOffset: (input: { sourceAccountId: string; targetAccountId: string }, signal?: AbortSignal) =>
    apiClient.post('/api/finance/offsets/preview', input, { signal, schema: offsetPreviewSchema }),
  createOffset: (input: CreateOffsetInput) =>
    apiClient.post('/api/finance/offsets', input, { schema: z.object({ replayed: z.boolean(), offset: offsetSchema }) }),
  listOffsets: (accountId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/finance/offsets', { signal, query: accountId ? { accountId } : undefined, schema: z.object({ items: z.array(offsetSchema) }) }),
  reverseOffset: (offsetId: string, reason: string) =>
    apiClient.post(`/api/finance/offsets/${enc(offsetId)}/reverse`, { reason }, { schema: z.object({ offset: offsetSchema }) }),
  listOffsetRequests: (status: OffsetRequestStatus | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/finance/offset-requests', {
      signal,
      query: status ? { status } : undefined,
      schema: z.object({ items: z.array(offsetRequestSchema) }),
    }),
  approveOffsetRequest: (requestId: string, input: ApproveOffsetRequestInput) =>
    apiClient.post(`/api/finance/offset-requests/${enc(requestId)}/approve`, input, {
      schema: z.object({ request: offsetRequestSchema, offset: offsetSchema }),
    }),
  rejectOffsetRequest: (requestId: string, reason: string) =>
    apiClient.post(`/api/finance/offset-requests/${enc(requestId)}/reject`, { reason }, { schema: z.object({ request: offsetRequestSchema }) }),

  // ----- Yonetici: yapilandirma -----
  planOpenItems: (accountId: string, signal?: AbortSignal) =>
    apiClient.get('/api/finance/plans/open-items', { signal, query: { accountId }, schema: planOpenItemsSchema }),
  previewPlan: (input: PlanInput, signal?: AbortSignal) => apiClient.post('/api/finance/plans/preview', input, { signal, schema: planPreviewSchema }),
  createPlan: (input: CreatePlanInput) =>
    apiClient.post('/api/finance/plans', input, { schema: z.object({ replayed: z.boolean(), plan: planSchema }) }),
  listPlans: (query: { accountId?: string; status?: PlanDisplayStatus }, signal?: AbortSignal) =>
    apiClient.get('/api/finance/plans', { signal, query, schema: z.object({ items: z.array(planSchema) }) }),
  planAction: (planId: string, action: PlanAction, reason: string) =>
    apiClient.post(`/api/finance/plans/${enc(planId)}/${action}`, { reason }, { schema: z.object({ plan: planSchema }) }),

  // ----- Sakin -----
  myPlans: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-plans', { signal, query: unitQuery(unitId), schema: myPlansSchema }),
  offsetOptions: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/offset-options', { signal, query: unitQuery(unitId), schema: offsetOptionsSchema }),
  myOffsetRequests: (signal?: AbortSignal) =>
    apiClient.get('/api/portal/offset-requests', { signal, schema: z.object({ items: z.array(offsetRequestSchema) }) }),
  createOffsetRequest: (input: CreateOffsetRequestInput) =>
    apiClient.post('/api/portal/offset-requests', input, { schema: z.object({ replayed: z.boolean(), request: offsetRequestSchema }) }),

  // ----- Sakin: yapilandirma talebi -----
  planRequestOptions: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/plan-requests/options', { signal, query: unitQuery(unitId), schema: planRequestOptionsSchema }),
  myPlanRequests: (signal?: AbortSignal) => apiClient.get('/api/portal/plan-requests', { signal, schema: myPlanRequestsSchema }),
  createPlanRequest: (input: CreatePlanRequestInput) => apiClient.post('/api/portal/plan-requests', input, { schema: planRequestWriteSchema }),
  withdrawPlanRequest: (requestId: string) => apiClient.post(`/api/portal/plan-requests/${enc(requestId)}/withdraw`, {}, { schema: planRequestWithdrawSchema }),

  // ----- Yonetici: yapilandirma talepleri -----
  listPlanRequests: (status: PlanRequestStatus | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/finance/plan-requests', {
      signal,
      query: status ? { status } : undefined,
      schema: z.object({ items: z.array(planRequestSchema), pendingCount: z.number().int() }),
    }),
  planRequest: (requestId: string, signal?: AbortSignal) => apiClient.get(`/api/finance/plan-requests/${enc(requestId)}`, { signal, schema: planRequestDetailSchema }),
  approvePlanRequest: (requestId: string, input: ApprovePlanRequestInput) =>
    apiClient.post(`/api/finance/plan-requests/${enc(requestId)}/approve`, input, {
      schema: z.object({ request: planRequestSchema, plan: planSchema, replayed: z.boolean() }),
    }),
  rejectPlanRequest: (requestId: string, reason: string) =>
    apiClient.post(`/api/finance/plan-requests/${enc(requestId)}/reject`, { reason }, { schema: z.object({ request: planRequestSchema }) }),
  planRequestSettings: (signal?: AbortSignal) => apiClient.get('/api/finance/plan-requests/settings', { signal, schema: planRequestSettingsResponseSchema }),
  savePlanRequestSettings: (input: Partial<PlanRequestSettings> & { version: number }) =>
    apiClient.put('/api/finance/plan-requests/settings', input, { schema: planRequestSettingsResponseSchema }),
};
