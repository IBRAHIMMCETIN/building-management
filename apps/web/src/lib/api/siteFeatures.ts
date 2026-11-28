import { z } from 'zod';
import { FEATURE_KEYS } from '@/lib/features/catalog';
import { apiClient } from './client';

/*
 * Adim 1 - site ozellik anahtarlari (apps/api/src/modules/features/routes.ts).
 *   GET   /api/site-features                    aktif apartmanin etkin ozellikleri (tum roller)
 *   GET   /api/site-features/requests           bekleyen "acilmasini istiyorum" talepleri (yonetim + denetci)
 *   POST  /api/site-features/requests            { feature, note? }  (yonetici / yonetim firmasi)
 *   GET   /api/admin/site-features/requests     platform: tum bekleyen talepler
 *   POST  /api/admin/site-features/requests/:siteId/:feature/dismiss  { reason }
 *   GET   /api/admin/site-features/:siteId      platform: site ozellik durumu
 *   PATCH /api/admin/site-features/:siteId        { version, reason, profile?, features?: { anahtar: true|false|null } }
 */

const featureKeySchema = z.enum(FEATURE_KEYS);
const profileSchema = z.enum(['legacy', 'simple']);

export const featureDefinitionSchema = z.object({
  key: featureKeySchema,
  area: z.enum(['resident', 'admin', 'channels', 'auth', 'payments', 'modules']),
  label: z.string(),
  description: z.string(),
  defaults: z.object({ legacy: z.boolean(), simple: z.boolean() }),
  upcoming: z.boolean().optional(),
  platformSetup: z.boolean().optional(),
  /** Abonelik plani da kisitlayabilir (etkin deger = site ayari VE plan). */
  licensable: z.boolean().optional(),
});
export type FeatureDefinition = z.infer<typeof featureDefinitionSchema>;

export const siteFeatureViewSchema = z.object({
  apartmentId: z.string(),
  version: z.number().int(),
  profile: profileSchema,
  inherited: z.boolean(),
  overrides: z.partialRecord(featureKeySchema, z.boolean()),
  features: z.record(featureKeySchema, z.boolean()),
  /** Site ayarinda acik ama abonelik planinin kapsamadigi anahtarlar (yonetici gorunumu). */
  planRestricted: z.array(featureKeySchema).optional(),
  catalog: z.array(featureDefinitionSchema),
});
export type SiteFeatureView = z.infer<typeof siteFeatureViewSchema>;

export const featureRequestSchema = z.object({
  apartmentId: z.string(),
  feature: featureKeySchema,
  status: z.enum(['pending', 'enabled', 'dismissed']),
  note: z.string().optional(),
  requestedBy: z.string(),
  requestedAt: z.string(),
  count: z.number().int(),
  siteName: z.string().optional(),
});
export type FeatureRequest = z.infer<typeof featureRequestSchema>;

const requestListSchema = z.object({ items: z.array(featureRequestSchema) });
const requestResultSchema = z.object({ created: z.boolean(), request: featureRequestSchema });

export type UpdateSiteFeaturesInput = {
  version: number;
  reason: string;
  profile?: 'legacy' | 'simple';
  features?: Partial<Record<(typeof FEATURE_KEYS)[number], boolean | null>>;
};

const platformPath = (siteId: string) => `/api/admin/site-features/${encodeURIComponent(siteId)}`;

export const siteFeaturesApi = {
  current: (signal?: AbortSignal) => apiClient.get('/api/site-features', { signal, schema: siteFeatureViewSchema }),
  siteRequests: (signal?: AbortSignal) => apiClient.get('/api/site-features/requests', { signal, schema: requestListSchema }),
  requestEnable: (feature: string, note?: string) =>
    apiClient.post('/api/site-features/requests', { feature, ...(note ? { note } : {}) }, { schema: requestResultSchema }),
  platformGet: (siteId: string, signal?: AbortSignal) => apiClient.get(platformPath(siteId), { signal, schema: siteFeatureViewSchema }),
  platformUpdate: (siteId: string, input: UpdateSiteFeaturesInput) => apiClient.patch(platformPath(siteId), input, { schema: siteFeatureViewSchema }),
  pendingRequests: (signal?: AbortSignal) => apiClient.get('/api/admin/site-features/requests', { signal, schema: requestListSchema }),
  dismissRequest: (siteId: string, feature: string, reason: string) =>
    apiClient.post(`/api/admin/site-features/requests/${encodeURIComponent(siteId)}/${encodeURIComponent(feature)}/dismiss`, { reason }),
};
