/**
 * Adim 1 - site bazli ozellik anahtarlari (API: apps/api/src/modules/features/catalog.ts).
 * Liste API ile birebir aynidir; API testi (`site-features.test.ts`) iki listenin esitligini dogrular.
 * Etiket ve aciklamalar API'den (`catalog`) gelir; buradakiler yalnizca yedektir.
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
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureProfile = 'legacy' | 'simple';
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
};

export const PROFILE_LABELS: Record<FeatureProfile, string> = {
  legacy: 'Tam (eski siteler)',
  simple: 'Sade mod',
};

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}

/** Tum anahtarlar ayni degerde (yukleniyor: false = gizli; saglayici yok: true = eski davranis). */
export function uniformFeatures(value: boolean): FeatureMap {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, value])) as FeatureMap;
}

export const FEATURE_AREA_LABELS = {
  resident: 'Sakin ekranları',
  admin: 'Yönetici ekranları',
  channels: 'Bildirim kanalları',
  auth: 'Giriş',
  payments: 'Ödeme',
} as const;
