import type { Context } from 'hono';
import type { AuthClaims, Authenticator } from '../../auth/claims.js';
import type { FeatureKey, ResolvedFeatures } from '../features/catalog.js';
import { FeatureDisabledError, type SiteFeatureReader } from '../features/guard.js';
import {
  type BillingSettingsView,
  PLAN_FEATURES,
  type PlanFeatures,
  type PlanLimits,
  READ_ONLY_STATUSES,
  type Subscription,
  type SubscriptionStatus,
  allFeatures,
} from './types.js';

/**
 * Abonelik yetkileri (entitlement). Ayri bir ozellik anahtari sistemi DEGILDIR: plan, Adim 1 site
 * ozellik katalogunun `licensable` anahtarlarini kisitlar (modules/features/catalog.ts) ve kapali
 * modul ayni hatayla (`403 feature_disabled`, web'de ayni bildirim) reddedilir.
 *
 *  - Platform ayari kapaliysa (varsayilan; `PLATFORM#SETTINGS`) veya apartmanin abonelik kaydi yoksa
 *    `legacy`: kisit yok, site bugunku gibi davranir.
 *  - Etkin ozellik = site ayari VE plan izni (`createLicensedFeatureReader`); mevcut `requireFeature`
 *    guard'lari (or. `payments.online`) bunu otomatik kullanir. Kendi guard'i olmayan modul yollari
 *    `FEATURE_ROUTES` ile merkezden ayni hatayi alir.
 *  - `suspended` / `cancelled` -> SALT OKUNUR: yazma istekleri `423 subscription_read_only`.
 *    Haric: okumalar (GET/HEAD; raporlar ve PDF disa aktarimi dahil), sakin portali (`/api/portal/*`:
 *    aidat odemesi dahil; sakin aboneligin tarafi degildir), abonelik ekrani, denetim zinciri
 *    dogrulamasi ve dogrudan `platform_admin`.
 *  - Bolum / ekip limiti ilgili serviste (`assertUnitCapacity`, `assertStaffCapacity`): `403 plan_limit_exceeded`.
 *
 * Okumalar Lambda konteyneri icinde kisa sure (30 sn) onbelleklenir; platform degisikligi ayni
 * konteynerde onbellegi hemen temizler. Okuma hatasi varsayilan olarak YUTULMAZ (fail closed);
 * yalnizca `ENTITLEMENTS_FAIL_OPEN=true` ile acikca istenirse legacy kabul edilip loglanir.
 */

export type Entitlement = {
  legacy: boolean;
  status: SubscriptionStatus | 'legacy';
  readOnly: boolean;
  /** Plan izinleri (`licensable` anahtarlar). */
  features: PlanFeatures;
  limits: PlanLimits;
};

export function entitlementOf(sub: Pick<Subscription, 'status' | 'plan'> | undefined): Entitlement {
  if (!sub) return { legacy: true, status: 'legacy', readOnly: false, features: allFeatures(), limits: { maxUnits: null, maxStaffUsers: null } };
  return {
    legacy: false,
    status: sub.status,
    readOnly: READ_ONLY_STATUSES.includes(sub.status),
    // Plan anlik goruntusunde olmayan (sonradan eklenmis) anahtar katalog varsayilani gibi acik.
    features: Object.fromEntries(PLAN_FEATURES.map((f) => [f, sub.plan.features[f] ?? true])) as PlanFeatures,
    limits: { maxUnits: sub.plan.limits.maxUnits ?? null, maxStaffUsers: sub.plan.limits.maxStaffUsers ?? null },
  };
}

export type EntitlementReader = {
  resolve(apartmentId: string): Promise<Entitlement>;
  invalidate(apartmentId?: string): void;
};

/** Yetki okuyucusunun veri kaynaklari (production: abonelik deposu). */
export type EntitlementSource = {
  getSubscription: (apartmentId: string) => Promise<Pick<Subscription, 'status' | 'plan'> | undefined>;
  /** Platform ayari; verilmezse sistem acik kabul edilir (testler). */
  getSettings?: () => Promise<Pick<BillingSettingsView, 'enabled'>>;
};

export type EntitlementReaderDeps = EntitlementSource & {
  ttlMs?: number;
  /** Okuma hatasinin onbellekte tutulma suresi (art arda istekler depoyu dovmesin). */
  errorTtlMs?: number;
  now?: () => number;
  /** true: abonelik okuma hatasinda legacy (yalnizca acikca yapilandirilirsa). */
  failOpen?: boolean;
  log?: Pick<Console, 'error'>;
};

/**
 * Platform ayari KAPALIYKEN sifir etki: ayar okunamazsa son bilinen deger, hic yoksa KAPALI
 * (kisit yok) kabul edilir; ayar okuma hatasi hicbir istegi dusurmez. Yalnizca sistem ACIK
 * bilindiginde abonelik kaydinin okuma hatasi fail closed'dir (`failOpen` ile legacy). Hatalar
 * kisa sure (varsayilan 5 sn) onbellekte tutulur.
 */
export function createEntitlementReader({ getSubscription, getSettings, ttlMs = 30_000, errorTtlMs = 5_000, now = Date.now, failOpen = false, log = console }: EntitlementReaderDeps): EntitlementReader {
  const cache = new Map<string, { at: number; value?: Entitlement; error?: unknown }>();
  let settings: { at: number; enabled: boolean; ttl: number } | undefined;
  let lastKnown: boolean | undefined;
  const live = (at: number, ttl: number) => ttl > 0 && now() - at < ttl;

  async function enabled(): Promise<boolean> {
    if (!getSettings) return true;
    if (settings && live(settings.at, settings.ttl)) return settings.enabled;
    try {
      const value = (await getSettings()).enabled === true;
      lastKnown = value;
      settings = { at: now(), enabled: value, ttl: ttlMs };
      return value;
    } catch (err) {
      const fallback = lastKnown ?? false;
      log.error(JSON.stringify({ level: 'error', msg: 'billing_settings_read_failed', fallback, error: err instanceof Error ? err.name : 'unknown' }));
      settings = { at: now(), enabled: fallback, ttl: errorTtlMs };
      return fallback;
    }
  }

  return {
    async resolve(apartmentId) {
      if (!(await enabled())) return entitlementOf(undefined);
      const hit = cache.get(apartmentId);
      if (hit?.value && live(hit.at, ttlMs)) return hit.value;
      if (hit?.error && live(hit.at, errorTtlMs)) {
        if (failOpen) return entitlementOf(undefined);
        throw hit.error;
      }
      try {
        const value = entitlementOf(await getSubscription(apartmentId));
        if (ttlMs > 0) cache.set(apartmentId, { at: now(), value });
        return value;
      } catch (err) {
        cache.set(apartmentId, { at: now(), error: err });
        if (!failOpen) throw err;
        log.error(JSON.stringify({ level: 'error', msg: 'entitlement_read_failed_open', apartmentId, error: err instanceof Error ? err.name : 'unknown' }));
        return entitlementOf(undefined);
      }
    },
    invalidate(apartmentId) {
      settings = undefined;
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

/** Etkin ozellikler: site ayari VE (aboneligi varsa) plan izni. */
export function licensedFeatures(site: ResolvedFeatures, e: Entitlement): ResolvedFeatures {
  if (e.legacy) return site;
  const out = { ...site };
  for (const k of PLAN_FEATURES) out[k] = site[k] && e.features[k] === true;
  return out;
}

/**
 * Adim 1 site ozellik okuyucusunun yerine gecen okuyucu: `requireFeature` / `featureAllowed` ve
 * yonetici `GET /api/site-features` etkin degeri (site VE plan) gorur.
 */
export function createLicensedFeatureReader(site: SiteFeatureReader, entitlements: EntitlementReader): SiteFeatureReader {
  return {
    async resolve(apartmentId) {
      const [features, e] = await Promise.all([site.resolve(apartmentId), entitlements.resolve(apartmentId)]);
      return licensedFeatures(features, e);
    },
    invalidate(apartmentId) {
      site.invalidate(apartmentId);
      entitlements.invalidate(apartmentId);
    },
  };
}

// ---------------------------------------------------------------------------
// Hatalar (kapali modul: Adim 1 `FeatureDisabledError`)
// ---------------------------------------------------------------------------

export type EntitlementErrorCode = 'subscription_read_only' | 'plan_limit_exceeded';

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

// ---------------------------------------------------------------------------
// Kurallar
// ---------------------------------------------------------------------------

/**
 * Kendi `requireFeature` guard'i olmayan modul yollari (onek; `/api/...`) -> katalog anahtari.
 * `payments.online` burada YOK: mevcut guard (teklif + baslatma) site ayariyla ayni kalsin, yoldaki
 * odeme sonuclari her zaman okunabilsin; plan izni o guard'a okuyucu uzerinden zaten eklenir.
 */
export const FEATURE_ROUTES: readonly { prefix: string; feature: FeatureKey; methods?: readonly string[] }[] = [
  { prefix: '/api/gate', feature: 'modules.gate' },
  { prefix: '/api/portal/gate', feature: 'modules.gate' },
  { prefix: '/api/reservations', feature: 'modules.reservations' },
  { prefix: '/api/portal/reservations', feature: 'modules.reservations' },
  { prefix: '/api/polls', feature: 'modules.pollsAssemblies' },
  { prefix: '/api/portal/polls', feature: 'modules.pollsAssemblies' },
  { prefix: '/api/assemblies', feature: 'modules.pollsAssemblies' },
  { prefix: '/api/portal/assemblies', feature: 'modules.pollsAssemblies' },
  { prefix: '/api/tenders', feature: 'modules.tenders' },
  { prefix: '/api/portal/tenders', feature: 'modules.tenders' },
  { prefix: '/api/equipment', feature: 'modules.equipment' },
  { prefix: '/api/portfolio', feature: 'modules.portfolio' },
  // Acik arka plan isi baslatma; buyuk sitede otomatik ise donen tahakkuk ve is durumu sorgusu
  // bilerek baglanmaz (aidat tahakkuku planla kesilmemeli).
  { prefix: '/api/finance/dues/jobs', feature: 'modules.bulkJobs', methods: ['POST'] },
];

/**
 * Salt okunur durumda da yazilabilen yollar (temel islemler; sakinlere ve guvenlige zarar vermemek icin):
 * sakin portali, abonelik ekrani, zincir dogrulamasi, destek; banka ekstresi aktarimi / eslestirme ve
 * elle tahsilat kaydi (sakinin odemesi deftere girsin); guvenlik masasi (QR / kod dogrulama, giris /
 * cikis, kurye, elle gunluk).
 */
export const READ_ONLY_EXEMPT_PREFIXES: readonly string[] = ['/api/portal', '/api/subscription', '/api/audit/verify', '/api/support', '/api/bank'];

/** Tam yol kaliplari: salt okunur durumda acik yazimlar (yalnizca POST) ve yan etkisiz onizlemeler. */
export const READ_ONLY_EXEMPT_PATHS: readonly RegExp[] = [
  /^\/api\/finance\/payments$/,
  /^\/api\/gate\/passes\/verify$/,
  /^\/api\/gate\/passes\/[^/]+\/(entry|exit)$/,
  /^\/api\/gate\/couriers$/,
  /^\/api\/gate\/couriers\/[^/]+\/(entry|exit|cancel)$/,
  /^\/api\/gate\/log$/,
  // Onizlemeler (yazim yok):
  /^\/api\/finance\/dues\/preview$/,
  /^\/api\/finance\/offsets\/preview$/,
  /^\/api\/finance\/plans\/preview$/,
  /^\/api\/imports\/preview$/,
  /^\/api\/ownership\/units\/[^/]+\/transfers\/preview$/,
  /^\/api\/metering\/swaps\/preview$/,
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isWriteMethod = (method: string) => !READ_METHODS.has(method.toUpperCase());

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function readOnlyExempt(method: string, path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return READ_ONLY_EXEMPT_PREFIXES.some((x) => under(p, x)) || (method.toUpperCase() === 'POST' && READ_ONLY_EXEMPT_PATHS.some((r) => r.test(p)));
}

export function featureForRequest(method: string, path: string): FeatureKey | undefined {
  const m = method.toUpperCase();
  return FEATURE_ROUTES.find((r) => under(path, r.prefix) && (!r.methods || r.methods.includes(m)))?.feature;
}

/** Dogrudan `platform_admin` (destek oturumu degil) abonelik kurallarindan muaftir (Adim 1 guard'i gibi). */
export const bypassesEntitlements = (claims: AuthClaims) => claims.role === 'platform_admin' && !claims.supportSessionId;

/** Salt okunur karari (SAF): engel varsa hata, yoksa undefined. */
export function readOnlyCheck(e: Entitlement, req: { method: string; path: string }): EntitlementError | undefined {
  if (e.legacy || !e.readOnly || !isWriteMethod(req.method)) return undefined;
  return readOnlyExempt(req.method, req.path) ? undefined : readOnlyError(e.status);
}

/**
 * Kimlik dogrulayici sarmalayicisi: istek moduldeki isleyiciye ulasmadan karar verilir. Aktif
 * apartmani olmayan istek (platform uclari, baglam secimi) kontrol edilmez. `features` etkin
 * (site VE plan) okuyucudur. Okuma istekleri (GET/HEAD) yalnizca plan modulu yolundaysa
 * abonelik okur; diger okumalar hic ek okuma yapmaz. Salt okunurdan muaf yazimlar da okumaz.
 */
export function withEntitlements(authenticate: Authenticator, deps: { entitlements: EntitlementReader; features: SiteFeatureReader }): Authenticator {
  return async (c: Context) => {
    const claims = await authenticate(c);
    if (!claims || !claims.apartmentId || bypassesEntitlements(claims)) return claims;
    const req = { method: c.req.method, path: c.req.path };
    const key = featureForRequest(req.method, req.path);
    if (key && !(await deps.features.resolve(claims.apartmentId))[key]) {
      c.header('Cache-Control', 'no-store');
      throw new FeatureDisabledError(key);
    }
    if (!isWriteMethod(req.method) || readOnlyExempt(req.method, req.path)) return claims;
    const err = readOnlyCheck(await deps.entitlements.resolve(claims.apartmentId), req);
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
