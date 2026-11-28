import { z } from 'zod';

/*
 * Adim 1 - site bazli ozellik anahtarlari: istemci tarafi (mobil; web'in yerel kopyasi
 * apps/web/src/lib/features/catalog.ts). Asil katalog ve kurallar API'de:
 * apps/api/src/modules/features/catalog.ts. Liste API ve web ile birebir aynidir (esitlik testi:
 * apps/mobile/src/context/SiteFeaturesProvider.test.tsx). Etiketler API'nin `catalog`'undan gelir; buradakiler yedektir.
 *
 *   GET /api/site-features -> { apartmentId, version, profile, inherited, overrides, features, catalog }
 *   Kapali ozellige ait uclar: 403 { error: 'feature_disabled', feature, message }
 */

export const FEATURE_KEYS = [
  'resident.restructure',
  'resident.advanceOffset',
  'resident.notificationPrefs',
  'resident.mfa',
  'admin.sharedOwnership',
  'admin.debtRestructure',
  'resident.expenseChart',
  'channels.whatsapp',
  'auth.phoneOtp',
  'payments.online',
  'modules.gate',
  'modules.reservations',
  'modules.pollsAssemblies',
  'modules.tenders',
  'modules.equipment',
  'modules.portfolio',
  'modules.bulkJobs',
  'channels.push',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureMap = Record<FeatureKey, boolean>;

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  'resident.restructure': 'Sakinde taksit planı kartı',
  'resident.advanceOffset': 'Sakinde avans mahsubu kartı',
  'resident.notificationPrefs': 'Sakinde bildirim tercihleri',
  'resident.mfa': 'Sakinde iki adımlı doğrulama',
  'admin.sharedOwnership': 'Hisseli mülkiyet ve devir sihirbazı',
  'admin.debtRestructure': 'Borç yapılandırma ve muacceliyet',
  'resident.expenseChart': 'Sakinde gider halka grafiği',
  'channels.whatsapp': 'WhatsApp bildirimleri',
  'auth.phoneOtp': 'Telefon + WhatsApp kodu ile giriş',
  'payments.online': 'Online aidat ödemesi',
  'modules.gate': 'Güvenlik kapısı',
  'modules.reservations': 'Ortak alan rezervasyonu',
  'modules.pollsAssemblies': 'Anket, oylama ve genel kurul',
  'modules.tenders': 'İhale / teklif toplama',
  'modules.equipment': 'Ekipman sicili',
  'modules.portfolio': 'Yönetim firması portföyü',
  'modules.bulkJobs': 'Arka plan toplu işleri',
  'channels.push': 'Mobil bildirim (push)',
};

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}

/** Tum anahtarlar ayni degerde (yukleniyor / hata: false = gizli; saglayici yok: true = eski davranis). */
export function uniformFeatures(value: boolean): FeatureMap {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, value])) as FeatureMap;
}

/**
 * `GET /api/site-features` yaniti (istemcinin kullandigi alanlar). Bilinmeyen (yeni) anahtar
 * reddedilmez, yok sayilir; yanitta olmayan anahtar KAPALI sayilir (fail closed).
 */
export const siteFeaturesSchema = z.object({
  apartmentId: z.string(),
  profile: z.string().optional(),
  features: z.record(z.string(), z.boolean()),
  catalog: z.array(z.object({ key: z.string(), label: z.string(), description: z.string().optional() }).loose()).optional(),
});
export type SiteFeatures = z.infer<typeof siteFeaturesSchema>;

/** Yanittan etkin harita: yalnizca bilinen anahtarlar, `true` olmayan her sey kapali. */
export function featureMapOf(view: Pick<SiteFeatures, 'features'>): FeatureMap {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, view.features[k] === true])) as FeatureMap;
}

/** Ozelligin okunur adi: API katalogu, yoksa yerel yedek. */
export function featureLabel(key: FeatureKey, catalog?: SiteFeatures['catalog']): string {
  return catalog?.find((d) => d.key === key)?.label ?? FEATURE_LABELS[key];
}

/** API'nin kapali ozellik hatasi (403 `feature_disabled`). */
export const FEATURE_DISABLED_CODE = 'feature_disabled';
