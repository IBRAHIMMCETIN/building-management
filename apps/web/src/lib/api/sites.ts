import { z } from 'zod';
import { apiClient } from './client';

/*
 * Apartman (site) ayarlari (apps/api/src/modules/core). URL'deki kimlik JWT'deki apartmentId
 * ile eslesmek zorundadir (siteGuard).
 *   GET   /api/sites/:siteId
 *   PATCH /api/sites/:siteId   { version, settings: { ...kismi } }  (yonetici / yonetim firmasi)
 * `settings.monthlyDuesPlan: null` plani kaldirir.
 */

export const DUES_PLAN_KEYS = ['equal', 'area', 'land_share'] as const;
export type DuesPlanKey = (typeof DUES_PLAN_KEYS)[number];

export const monthlyDuesPlanSchema = z.object({
  enabled: z.boolean(),
  totalAmount: z.number().int(),
  distributionKey: z.enum(DUES_PLAN_KEYS),
  liableParty: z.enum(['occupant', 'owner']),
  /** Finans 2.4: tahakkukun yazilacagi gelir hesabi (yoksa `income-dues`). */
  incomeAccountId: z.string().optional(),
  /** Finans 2.4: plani olusturan onayli butce. */
  budgetId: z.string().optional(),
});

export const siteSchema = z.object({
  siteId: z.string(),
  name: z.string(),
  version: z.number().int(),
  settings: z.object({
    landShareEnabled: z.boolean(),
    dueDayOfMonth: z.number().int(),
    lateFeeMonthlyBasisPoints: z.number().int(),
    monthlyDuesPlan: monthlyDuesPlanSchema.optional(),
  }),
});

export type Site = z.infer<typeof siteSchema>;
export type MonthlyDuesPlan = z.infer<typeof monthlyDuesPlanSchema>;

export type UpdateSiteSettingsInput = {
  version: number;
  settings: {
    dueDayOfMonth: number;
    lateFeeMonthlyBasisPoints: number;
    monthlyDuesPlan: MonthlyDuesPlan | null;
  };
};

const path = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}`;

export const sitesApi = {
  get: (siteId: string, signal?: AbortSignal) => apiClient.get(path(siteId), { signal, schema: siteSchema }),
  updateSettings: (siteId: string, input: UpdateSiteSettingsInput) => apiClient.patch(path(siteId), input, { schema: siteSchema }),
};
