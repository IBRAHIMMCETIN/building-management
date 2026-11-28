import type { Context, MiddlewareHandler } from 'hono';
import type { AuthClaims } from '../../auth/claims.js';
import type { Env } from '../../http/helpers.js';
import type { Site } from '../core/types.js';
import { FEATURE_CATALOG, type FeatureKey, type ResolvedFeatures, resolveFeatures } from './catalog.js';

export const FEATURE_DISABLED_CODE = 'feature_disabled';

/** Kapali ozellige istek -> 403 `{ error: 'feature_disabled', feature, message }`. */
export class FeatureDisabledError extends Error {
  readonly feature: FeatureKey;
  constructor(feature: FeatureKey) {
    super(`Bu özellik siteniz için kapalı: ${FEATURE_CATALOG[feature].label}`);
    this.name = 'FeatureDisabledError';
    this.feature = feature;
  }
}

export function featureDisabledBody(feature: FeatureKey) {
  return { error: FEATURE_DISABLED_CODE, feature, message: new FeatureDisabledError(feature).message };
}

/**
 * Sitenin etkin ozellikleri. Her korumali istekte okunur; Lambda konteyneri icinde kisa sure
 * (varsayilan 30 sn) onbelleklenir. Platform guncellemesi ayni konteynerde onbellegi hemen
 * temizler; diger konteynerler en gec TTL sonunda yeni degeri gorur.
 *
 * Okuma hatasi yutulmaz (fail closed): istek 5xx alir, kapali ozellik asla "acik" sayilmaz.
 */
export type SiteFeatureReader = {
  resolve(apartmentId: string): Promise<ResolvedFeatures>;
  invalidate(apartmentId?: string): void;
};

export type SiteFeatureReaderDeps = {
  getSite: (apartmentId: string) => Promise<Pick<Site, 'settings'> | undefined>;
  ttlMs?: number;
  now?: () => number;
};

export function createSiteFeatureReader({ getSite, ttlMs = 30_000, now = Date.now }: SiteFeatureReaderDeps): SiteFeatureReader {
  const cache = new Map<string, { at: number; value: ResolvedFeatures }>();
  return {
    async resolve(apartmentId) {
      const hit = cache.get(apartmentId);
      if (hit && ttlMs > 0 && now() - hit.at < ttlMs) return hit.value;
      const site = await getSite(apartmentId);
      // Site yoksa: legacy (asil uc zaten 404/403 doner).
      const value = resolveFeatures(site?.settings.features);
      if (ttlMs > 0) cache.set(apartmentId, { at: now(), value });
      return value;
    },
    invalidate(apartmentId) {
      if (apartmentId) cache.delete(apartmentId);
      else cache.clear();
    },
  };
}

/** Sabit durum (testler): verilmeyen anahtarlar legacy varsayilanlarini alir. */
export function staticSiteFeatureReader(overrides: Partial<ResolvedFeatures> = {}): SiteFeatureReader {
  const value = { ...resolveFeatures(undefined), ...overrides };
  return { resolve: async () => value, invalidate: () => {} };
}

/** Adim 1 oncesi davranis: tum mevcut ozellikler acik (sahte servislerle kurulan testler). */
export const legacySiteFeatureReader: SiteFeatureReader = staticSiteFeatureReader();

/**
 * `platform_admin` (destek oturumu disinda) ozellik kontrolunden muaftir: kurulumda platform
 * ekibi kapali ozelligi kullanabilir. Destek oturumu (salt okunur `observer`) muaf DEGILDIR.
 */
function bypasses(claims: AuthClaims): boolean {
  return claims.role === 'platform_admin' && !claims.supportSessionId;
}

/** Ozellik acik mi? Aktif apartman yoksa karar asil uca birakilir (true). */
export async function featureAllowed(reader: SiteFeatureReader | undefined, claims: AuthClaims | null | undefined, key: FeatureKey): Promise<boolean> {
  if (!reader || !claims || bypasses(claims) || !claims.apartmentId) return true;
  return (await reader.resolve(claims.apartmentId))[key];
}

/**
 * Ortak Hono ara katmani. `reader` verilmezse (eski testler / dogrudan rota testleri) kontrol yok.
 * Kimlik dogrulamadan SONRA baglanmalidir (`claims` gerekir).
 */
export function requireFeature(reader: SiteFeatureReader | undefined, key: FeatureKey): MiddlewareHandler<Env> {
  return async (c: Context<Env>, next) => {
    if (!(await featureAllowed(reader, c.get('claims'), key))) {
      c.header('Cache-Control', 'no-store');
      return c.json(featureDisabledBody(key), 403);
    }
    await next();
  };
}
