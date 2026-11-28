import { z } from 'zod';

/*
 * Sakin yapilandirma (taksit) talebi (apps/api/src/modules/finance/planRequests.ts): web + mobil
 * ortak semalar, etiketler ve saf hesaplar.
 *   GET  /api/portal/plan-requests/options?unitId   sinirlar ve carilerin durumu
 *   GET  /api/portal/plan-requests                  kendi talepleri
 *   POST /api/portal/plan-requests                  { idempotencyKey, unitId?, liableParty?, installments, note? }
 *   POST /api/portal/plan-requests/:id/withdraw     bekleyen talebi geri ceker
 * Tutarlar kurus cinsinden tam sayidir; nihai dogrulama API'dedir.
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);

export const PLAN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type PlanRequestStatus = (typeof PLAN_REQUEST_STATUSES)[number];

/** Talep acilamama nedeni (API `reason`). */
export const PLAN_REQUEST_BLOCKS = ['disabled', 'no_overdue', 'active_plan', 'pending_request', 'too_small'] as const;
export type PlanRequestBlock = (typeof PLAN_REQUEST_BLOCKS)[number];

export const planRequestOptionsSchema = z.object({
  unitId: z.string(),
  settings: z.object({ enabled: z.boolean(), maxInstallments: z.number().int(), minInstallmentAmount: kurus, includeLateFees: z.boolean() }),
  minInstallments: z.number().int(),
  accounts: z.array(
    z.object({
      accountId: z.string(),
      liableParty: party,
      overdue: kurus,
      accruedLateFee: kurus,
      total: kurus,
      maxInstallments: z.number().int(),
      eligible: z.boolean(),
      reason: z.enum(PLAN_REQUEST_BLOCKS).optional(),
      /** Bekleyen talep: kendi talebi mi, ayni cariyi goren baska uyenin mi (KVKK: ayrinti yok). */
      pendingRequest: z.enum(['mine', 'other']).optional(),
      pendingRequestId: z.string().optional(),
    }),
  ),
});
export type PlanRequestOptions = z.infer<typeof planRequestOptionsSchema>;
export type PlanRequestAccount = PlanRequestOptions['accounts'][number];

export const myPlanRequestSchema = z.object({
  requestId: z.string(),
  unitId: z.string(),
  accountId: z.string(),
  liableParty: party,
  installments: z.number().int(),
  note: z.string().optional(),
  estimate: z.object({ overdue: kurus, accruedLateFee: kurus, total: kurus, installmentAmount: kurus }),
  status: z.enum(PLAN_REQUEST_STATUSES),
  decision: z
    .object({
      at: z.string(),
      mode: z.enum(['as_is', 'changed', 'rejected', 'withdrawn']),
      reason: z.string(),
      planId: z.string().optional(),
      installments: z.number().int().optional(),
      firstDueDate: z.string().optional(),
      total: kurus.optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MyPlanRequest = z.infer<typeof myPlanRequestSchema>;

export const myPlanRequestsSchema = z.object({ items: z.array(myPlanRequestSchema) });
export const planRequestWriteSchema = z.object({ replayed: z.boolean(), request: myPlanRequestSchema });
export const planRequestWithdrawSchema = z.object({ request: myPlanRequestSchema });

export type CreatePlanRequestInput = {
  idempotencyKey: string;
  unitId?: string;
  liableParty?: 'owner' | 'occupant';
  installments: number;
  note?: string;
};

export const PLAN_REQUEST_NOTE_MAX = 300;

export const PLAN_REQUEST_STATUS_LABELS: Record<PlanRequestStatus, string> = {
  pending: 'Onay bekliyor',
  approved: 'Onaylandı',
  rejected: 'Reddedildi',
  withdrawn: 'Geri çekildi',
};

export const PLAN_REQUEST_STATUS_TONES: Record<PlanRequestStatus, 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
};

/** Talep acilamadiginda sakine gosterilen aciklama. */
export const PLAN_REQUEST_BLOCK_TEXT: Record<PlanRequestBlock, string> = {
  disabled: 'Yönetim şu anda taksit talebi almıyor.',
  no_overdue: 'Vadesi geçmiş borcunuz yok.',
  active_plan: 'Bu borç için zaten bir taksit planınız var.',
  pending_request: 'Bu borç için yönetimin değerlendirdiği bir talep var.',
  too_small: 'Gecikmiş borç tutarı taksitlendirme için çok düşük.',
};

export const PARTY_LABELS: Record<'owner' | 'occupant', string> = { owner: 'Kat maliki', occupant: 'Sakin (oturan)' };

/** Kurus kaybi olmadan esit bolme; artan kuruslar ilk taksitlere (API ile ayni). */
export function splitInstallments(total: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1 || total < 0) return [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Secilebilir taksit sayilari (API sinirlari: en az `min`, en fazla carinin `maxInstallments`'i). */
export function installmentChoices(account: Pick<PlanRequestAccount, 'maxInstallments'>, min = 2): number[] {
  const out: number[] = [];
  for (let n = min; n <= account.maxInstallments; n++) out.push(n);
  return out;
}

/** "3 taksit · aylık yaklaşık 1.033,34 TL" icin en buyuk taksit (artan kuruslar ilk taksitte). */
export function monthlyAmount(total: number, n: number): number {
  return splitInstallments(total, n)[0] ?? 0;
}
