import type { Context } from 'hono';
import type { AuthClaims, Authenticator } from '../../auth/claims.js';
import {
  PLAN_FEATURES,
  PLAN_FEATURE_LABELS,
  type PlanFeature,
  type PlanFeatures,
  type PlanLimits,
  READ_ONLY_STATUSES,
  type Subscription,
  type SubscriptionStatus,
  allFeatures,
} from './types.js';

/**
 * Abonelik yetkileri (entitlement) - API'nin TEK kontrol noktasi.
 *
 * `withEntitlements` rol gerektiren tum uclarin kimlik dogrulayicisini sarar (app.ts; MFA ve destek
 * erisiminden sonra). Kararlar aktif apartmanin aboneligine gore:
 *  - Abonelik kaydi yok -> `legacy` (Abonelik oncesi siteler): tum ozellikler acik, limit yok.
 *    Gelistirme ortaminda ve mevcut sitelerde hicbir sey degismez.
 *  - `suspended` / `cancelled` -> SALT OKUNUR: yazma istekleri `423 subscription_read_only`.
 *    Haric: okumalar (GET/HEAD; raporlar ve PDF disa aktarimi dahil), sakin portali (`/api/portal/*`:
 *    aidat odemesi dahil; sakin aboneligin tarafi degildir), abonelik ekrani, denetim zinciri
 *    dogrulamasi ve dogrudan `platform_admin`.
 *  - Plan ozelligi kapali modul -> `403 feature_not_in_plan` (tum yontemler; `FEATURE_ROUTES`).
 *  - Bolum / ekip limiti ilgili serviste (`assertUnitCapacity`, `assertStaffCapacity`): `403 plan_limit_exceeded`.
 *
 * Okuma Lambda konteyneri icinde kisa sure (30 sn) onbelleklenir; platform degisikligi ayni
 * konteynerde onbellegi hemen temizler. Okuma hatasi varsayilan olarak YUTULMAZ (fail closed);
 * yalnizca `ENTITLEMENTS_FAIL_OPEN=true` ile acikca istenirse legacy kabul edilip loglanir.
 */

export type Entitlement = {
  legacy: boolean;
  status: SubscriptionStatus | 'legacy';
  readOnly: boolean;
  features: PlanFeatures;
  limits: PlanLimits;
};

export const LEGACY_ENTITLEMENT: Readonly<Entitlement> = Object.freeze({
  legacy: true,
  status: 'legacy',
  readOnly: false,
  features: allFeatures(),
  limits: { maxUnits: null, maxStaffUsers: null },
});

export function entitlementOf(sub: Pick<Subscription, 'status' | 'plan'> | undefined): Entitlement {
  if (!sub) return { ...LEGACY_ENTITLEMENT, features: allFeatures(), limits: { ...LEGACY_ENTITLEMENT.limits } };
  return {
    legacy: false,
    status: sub.status,
    readOnly: READ_ONLY_STATUSES.includes(sub.status),
    features: Object.fromEntries(PLAN_FEATURES.map((f) => [f, sub.plan.features[f] === true])) as PlanFeatures,
    limits: { maxUnits: sub.plan.limits.maxUnits ?? null, maxStaffUsers: sub.plan.limits.maxStaffUsers ?? null },
  };
}

export type EntitlementReader = {
  resolve(apartmentId: string): Promise<Entitlement>;
  invalidate(apartmentId?: string): void;
};

export type EntitlementReaderDeps = {
  getSubscription: (apartmentId: string) => Promise<Pick<Subscription, 'status' | 'plan'> | undefined>;
  ttlMs?: number;
  now?: () => number;
  /** true: okuma hatasinda legacy (yalnizca acikca yapilandirilirsa). */
  failOpen?: boolean;
  log?: Pick<Console, 'error'>;
};

export function createEntitlementReader({ getSubscription, ttlMs = 30_000, now = Date.now, failOpen = false, log = console }: EntitlementReaderDeps): EntitlementReader {
  const cache = new Map<string, { at: number; value: Entitlement }>();
  return {
    async resolve(apartmentId) {
      const hit = cache.get(apartmentId);
      if (hit && ttlMs > 0 && now() - hit.at < ttlMs) return hit.value;
      let value: Entitlement;
      try {
        value = entitlementOf(await getSubscription(apartmentId));
      } catch (err) {
        if (!failOpen) throw err;
        log.error(JSON.stringify({ level: 'error', msg: 'entitlement_read_failed_open', apartmentId, error: err instanceof Error ? err.name : 'unknown' }));
        return entitlementOf(undefined);
      }
      if (ttlMs > 0) cache.set(apartmentId, { at: now(), value });
      return value;
    },
    invalidate(apartmentId) {
      if (apartmentId) cache.delete(apartmentId);
      else cache.clear();
    },
  };
}

/** Sabit durum (testler). */
export function staticEntitlementReader(value: Partial<Entitlement> = {}): EntitlementReader {
  const v = { ...entitlementOf(undefined), ...value };
  return { resolve: async () => v, invalidate: () => {} };
}

/** Sahte servislerle kurulan testler: abonelik oncesi davranis. */
export const legacyEntitlementReader: EntitlementReader = staticEntitlementReader();

export const failOpenFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.ENTITLEMENTS_FAIL_OPEN?.trim().toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------

export type EntitlementErrorCode = 'subscription_read_only' | 'feature_not_in_plan' | 'plan_limit_exceeded';

export class EntitlementError extends Error {
  readonly code: EntitlementErrorCode;
  readonly httpStatus: 403 | 423;
  readonly details: Record<string, string | number | null>;

  constructor(code: EntitlementErrorCode, message: string, details: Record<string, string | number | null> = {}) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.httpStatus = code === 'subscription_read_only' ? 423 : 403;
    this.details = details;
  }
}

export const entitlementErrorBody = (err: EntitlementError) => ({ error: err.code, message: err.message, ...err.details });

export function readOnlyError(status: SubscriptionStatus | 'legacy'): EntitlementError {
  const cancelled = status === 'cancelled';
  return new EntitlementError(
    'subscription_read_only',
    cancelled
      ? 'Aboneliğiniz sona erdi; sistem salt okunur. Kayıtları görüntüleyebilir ve dışa aktarabilirsiniz. Yeniden açmak için platform ekibiyle iletişime geçin.'
      : 'Aboneliğiniz ödeme nedeniyle askıya alındı; sistem salt okunur. Kayıtları görüntüleyebilir ve dışa aktarabilirsiniz, sakin ödemeleri alınmaya devam eder. Ayarlar > Abonelik ekranından faturalarınızı görebilirsiniz.',
    { status },
  );
}

export const featureError = (feature: PlanFeature) =>
  new EntitlementError('feature_not_in_plan', `Bu modül aboneliğinizin planında yok: ${PLAN_FEATURE_LABELS[feature]}. Planınızı yükseltmek için platform ekibiyle iletişime geçin.`, { feature });

// ---------------------------------------------------------------------------
// Kurallar
// ---------------------------------------------------------------------------

/** Plan ozelligine bagli modul yollari (onek; `/api/...`). `methods` verilirse yalnizca o yontemler. */
export const FEATURE_ROUTES: readonly { prefix: string; feature: PlanFeature; methods?: readonly string[] }[] = [
  { prefix: '/api/portal/payments', feature: 'online_payment' },
  { prefix: '/api/finance/online-payments', feature: 'online_payment' },
  { prefix: '/api/gate', feature: 'gate' },
  { prefix: '/api/portal/gate', feature: 'gate' },
  { prefix: '/api/reservations', feature: 'reservations' },
  { prefix: '/api/portal/reservations', feature: 'reservations' },
  { prefix: '/api/polls', feature: 'polls_assemblies' },
  { prefix: '/api/portal/polls', feature: 'polls_assemblies' },
  { prefix: '/api/assemblies', feature: 'polls_assemblies' },
  { prefix: '/api/portal/assemblies', feature: 'polls_assemblies' },
  { prefix: '/api/tenders', feature: 'tenders' },
  { prefix: '/api/portal/tenders', feature: 'tenders' },
  { prefix: '/api/equipment', feature: 'equipment' },
  { prefix: '/api/portfolio', feature: 'portfolio' },
  // Acik arka plan isi baslatma; buyuk sitede otomatik ise donen tahakkuk ve is durumu sorgusu
  // bilerek baglanmaz (aidat tahakkuku planla kesilmemeli).
  { prefix: '/api/finance/dues/jobs', feature: 'bulk_jobs', methods: ['POST'] },
];

/** Salt okunur durumda da yazilabilen yollar (temel islemler). */
export const READ_ONLY_EXEMPT_PREFIXES: readonly string[] = ['/api/portal', '/api/subscription', '/api/audit/verify', '/api/support'];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isWriteMethod = (method: string) => !READ_METHODS.has(method.toUpperCase());

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function featureForRequest(method: string, path: string): PlanFeature | undefined {
  const m = method.toUpperCase();
  return FEATURE_ROUTES.find((r) => under(path, r.prefix) && (!r.methods || r.methods.includes(m)))?.feature;
}

/** Dogrudan `platform_admin` (destek oturumu degil) abonelik kurallarindan muaftir. */
export const bypassesEntitlements = (claims: AuthClaims) => claims.role === 'platform_admin' && !claims.supportSessionId;

/** Istegin karari: engel varsa hata, yoksa undefined (SAF). */
export function checkRequest(e: Entitlement, req: { method: string; path: string }): EntitlementError | undefined {
  if (e.legacy) return undefined;
  const feature = featureForRequest(req.method, req.path);
  if (feature && !e.features[feature]) return featureError(feature);
  if (e.readOnly && isWriteMethod(req.method) && !READ_ONLY_EXEMPT_PREFIXES.some((p) => under(req.path, p))) return readOnlyError(e.status);
  return undefined;
}

/**
 * Kimlik dogrulayici sarmalayicisi: istek moduldeki isleyiciye ulasmadan karar verilir. Aktif
 * apartmani olmayan istek (platform uclari, baglam secimi) kontrol edilmez.
 */
export function withEntitlements(authenticate: Authenticator, reader: EntitlementReader): Authenticator {
  return async (c: Context) => {
    const claims = await authenticate(c);
    if (!claims || !claims.apartmentId || bypassesEntitlements(claims)) return claims;
    const e = await reader.resolve(claims.apartmentId);
    const err = checkRequest(e, { method: c.req.method, path: c.req.path });
    if (err) {
      c.header('Cache-Control', 'no-store');
      throw err;
    }
    return claims;
  };
}

/** Yeni aktif bolum sayisi plan limitini asiyorsa hata (bolum ekleme ve toplu aktarim). */
export async function assertUnitCapacity(reader: EntitlementReader, apartmentId: string, nextActiveUnits: number): Promise<void> {
  const e = await reader.resolve(apartmentId);
  const max = e.limits.maxUnits;
  if (e.legacy || max === null || nextActiveUnits <= max) return;
  throw new EntitlementError(
    'plan_limit_exceeded',
    `Aboneliğinizin bağımsız bölüm sınırı ${max}; yeni bölüm eklenemez. Planınızı yükseltmek için platform ekibiyle iletişime geçin.`,
    { limit: 'maxUnits', max, current: nextActiveUnits - 1 },
  );
}

/** Yeni ekip kullanicisi plan limitini asiyorsa hata (ekip daveti / rol ekleme). */
export async function assertStaffCapacity(reader: EntitlementReader, apartmentId: string, nextActiveStaff: number): Promise<void> {
  const e = await reader.resolve(apartmentId);
  const max = e.limits.maxStaffUsers;
  if (e.legacy || max === null || nextActiveStaff <= max) return;
  throw new EntitlementError(
    'plan_limit_exceeded',
    `Aboneliğinizin ekip kullanıcısı sınırı ${max}; yeni kişi eklenemez. Planınızı yükseltmek için platform ekibiyle iletişime geçin.`,
    { limit: 'maxStaffUsers', max, current: nextActiveStaff - 1 },
  );
}
