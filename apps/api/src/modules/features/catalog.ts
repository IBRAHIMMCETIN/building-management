/**
 * Adim 1 - Site bazli ozellik anahtarlari: merkezi ve tip guvenli katalog.
 *
 * Kurallar:
 *  - Calisan hicbir modul silinmez; kapali ozellik yalnizca gizlenir / reddedilir
 *    (HTTP 403 `feature_disabled`, zamanlanmis islerde `skipped: feature_disabled`).
 *  - Anahtarlar `site.settings.features` altinda saklanir:
 *      { profile: 'legacy' | 'simple', overrides: { '<anahtar>': boolean } }
 *    Kayit yoksa (Adim 1 oncesi acilmis siteler) profil `legacy`dir: mevcut davranis aynen surer.
 *    Yeni olusturulan siteler `simple` (sade mod) profiliyle baslar.
 *  - Etkin deger = override varsa override, yoksa profilin varsayilani.
 *  - Yalnizca `platform_admin` degistirir; yonetici gorur ve "acilmasini istiyorum" talebi gonderir.
 *
 *  - Abonelik: `licensable` anahtarlari abonelik plani da kisitlayabilir (modules/subscriptions):
 *    etkin deger = site ayari VE plan izni; plan modulleri ayri bir anahtar sistemi degildir.
 *
 * Yeni anahtar eklemek: `FEATURE_KEYS`'e ekle + `FEATURE_CATALOG`'a tanim yaz (web ayni listeyi
 * `apps/web/src/lib/features/catalog.ts` icinde tutar; test iki listenin esitligini dogrular).
 */

export const FEATURE_KEYS = [
  // Sakin tarafi gizlemeleri
  'resident.restructure',
  'resident.advanceOffset',
  'resident.notificationPrefs',
  'resident.mfa',
  // Yonetici tarafi gizlemeleri
  'admin.sharedOwnership',
  'admin.debtRestructure',
  // Sonraki adimlar (3-7) icin hazir kancalar
  'resident.expenseChart',
  'channels.whatsapp',
  'auth.phoneOtp',
  'payments.online',
  // Abonelik: plana baglanabilen moduller (her iki profilde varsayilan acik; mevcut davranis aynen).
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

export const FEATURE_PROFILES = ['legacy', 'simple'] as const;
export type FeatureProfile = (typeof FEATURE_PROFILES)[number];

export type FeatureArea = 'resident' | 'admin' | 'channels' | 'auth' | 'payments' | 'modules';

export type FeatureDefinition = {
  key: FeatureKey;
  area: FeatureArea;
  /** Platform ekraninda gorunen kisa ad. */
  label: string;
  /** Neyi gizledigi / actigi (yalin Turkce). */
  description: string;
  defaults: Record<FeatureProfile, boolean>;
  /** true: ozellik henuz gelistirilmedi (Adim 3-7 kancasi); acmak simdilik bir sey degistirmez. */
  upcoming?: boolean;
  /** true: kurulumda platform ekibinin kullanmasi beklenir (yoneticiden gizli). */
  platformSetup?: boolean;
  /**
   * Abonelik: abonelik plani bu anahtari kisitlayabilir. Etkin deger = site ayari VE plan izni
   * (aboneligi olmayan / legacy site ve abonelik sistemi kapaliyken yalnizca site ayari).
   */
  licensable?: boolean;
};

export const FEATURE_CATALOG: Readonly<Record<FeatureKey, FeatureDefinition>> = {
  'resident.restructure': {
    key: 'resident.restructure',
    area: 'resident',
    label: 'Sakinde taksit planı kartı',
    description: 'Sakin "Borçlarım" ekranında borç yapılandırma / taksit planı kartı.',
    defaults: { legacy: true, simple: false },
  },
  'resident.advanceOffset': {
    key: 'resident.advanceOffset',
    area: 'resident',
    label: 'Sakinde avans mahsubu kartı',
    description: 'Sakinin avansını borcuna mahsup ettirme talebi kartı (yönetici tarafındaki mahsup açık kalır).',
    defaults: { legacy: true, simple: false },
  },
  'resident.notificationPrefs': {
    key: 'resident.notificationPrefs',
    area: 'resident',
    label: 'Sakinde bildirim tercihleri',
    description: 'Sakin "Hesabım" ekranındaki e-posta bildirim tercihleri.',
    defaults: { legacy: true, simple: false },
  },
  'resident.mfa': {
    key: 'resident.mfa',
    area: 'resident',
    label: 'Sakinde iki adımlı doğrulama',
    description: 'Sakin "Hesabım" ekranında doğrulayıcı uygulama kurulumu (yönetici rollerinde zorunlu MFA etkilenmez).',
    defaults: { legacy: true, simple: false },
  },
  'admin.sharedOwnership': {
    key: 'admin.sharedOwnership',
    area: 'admin',
    label: 'Hisseli mülkiyet ve devir sihirbazı',
    description: 'Paydaş alt carileri (bölünmüş cari modu) ve mülk/hisse devri sihirbazı. Kurulumda platform ekibi açıp kullanır.',
    defaults: { legacy: true, simple: false },
    platformSetup: true,
  },
  'admin.debtRestructure': {
    key: 'admin.debtRestructure',
    area: 'admin',
    label: 'Borç yapılandırma ve muacceliyet',
    description: 'Yönetici taksit planları, muacceliyet ve günlük temerrüt taraması.',
    defaults: { legacy: true, simple: false },
  },
  'resident.expenseChart': {
    key: 'resident.expenseChart',
    area: 'resident',
    label: 'Sakinde gider halka grafiği',
    description: 'Sakin ana sayfasında aylık gider dağılımı (Adım 3).',
    defaults: { legacy: false, simple: false },
    upcoming: true,
  },
  'channels.whatsapp': {
    key: 'channels.whatsapp',
    area: 'channels',
    label: 'WhatsApp bildirimleri',
    description: 'Bildirimlerin WhatsApp kanalından gönderilmesi (Adım 4).',
    defaults: { legacy: false, simple: false },
    upcoming: true,
  },
  'auth.phoneOtp': {
    key: 'auth.phoneOtp',
    area: 'auth',
    label: 'Telefon + WhatsApp kodu ile giriş',
    description: 'Sakinlerin telefon numarası ve WhatsApp kodu ile girişi (Adım 5).',
    defaults: { legacy: false, simple: false },
    upcoming: true,
  },
  'payments.online': {
    key: 'payments.online',
    area: 'payments',
    label: 'Online aidat ödemesi',
    description: 'Sakinin kartla online ödeme başlatması (Adım 7). Banka/sağlayıcı geri bildirimleri her zaman işlenir.',
    defaults: { legacy: true, simple: false },
    licensable: true,
  },
  'modules.gate': {
    key: 'modules.gate',
    area: 'modules',
    label: 'Güvenlik kapısı',
    description: 'Misafir QR / kod, plaka sorgusu, kurye ve kapı günlüğü (yönetim, güvenlik ve sakin ekranları).',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'modules.reservations': {
    key: 'modules.reservations',
    area: 'modules',
    label: 'Ortak alan rezervasyonu',
    description: 'Tesis tanımları, rezervasyon onayı ve sakin rezervasyonları.',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'modules.pollsAssemblies': {
    key: 'modules.pollsAssemblies',
    area: 'modules',
    label: 'Anket, oylama ve genel kurul',
    description: 'Anket / oylama ve kat malikleri kurulu (çağrı, hazirun, tutanak).',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'modules.tenders': {
    key: 'modules.tenders',
    area: 'modules',
    label: 'İhale / teklif toplama',
    description: 'Teklif toplama, karşılaştırma ve sakinlerle paylaşım.',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'modules.equipment': {
    key: 'modules.equipment',
    area: 'modules',
    label: 'Ekipman sicili',
    description: 'Ekipman, garanti / sözleşme / periyodik kontrol tarihleri ve belgeler.',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'modules.portfolio': {
    key: 'modules.portfolio',
    area: 'modules',
    label: 'Yönetim firması portföyü',
    description: 'Birden fazla apartmanın özet kartları (aktif apartmana göre).',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'modules.bulkJobs': {
    key: 'modules.bulkJobs',
    area: 'modules',
    label: 'Arka plan toplu işleri',
    description: 'Elle başlatılan arka plan tahakkuk işi (büyük sitelerde otomatik iş ve aylık aidat etkilenmez).',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
  'channels.push': {
    key: 'channels.push',
    area: 'channels',
    label: 'Mobil bildirim (push)',
    description: 'Bildirimlerin mobil uygulamaya push olarak da gönderilmesi (e-posta etkilenmez).',
    defaults: { legacy: true, simple: true },
    licensable: true,
  },
};

/** Abonelik planinin kisitlayabildigi anahtarlar (katalog sirasiyla). */
export const LICENSABLE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter((k) => FEATURE_CATALOG[k].licensable === true);

export type FeatureOverrides = Partial<Record<FeatureKey, boolean>>;

/** `site.settings.features` kaydi. */
export type SiteFeatureSettings = {
  profile: FeatureProfile;
  overrides: FeatureOverrides;
};

export type ResolvedFeatures = Record<FeatureKey, boolean>;

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}

/** Yeni olusturulan sitelerin baslangic kaydi (sade mod). */
export function simpleModeFeatures(): SiteFeatureSettings {
  return { profile: 'simple', overrides: {} };
}

/** Kayit yoksa `legacy`: Adim 1 oncesi sitelerin davranisi degismez. */
export function profileOf(state: SiteFeatureSettings | undefined): FeatureProfile {
  return state && (FEATURE_PROFILES as readonly string[]).includes(state.profile) ? state.profile : 'legacy';
}

export function resolveFeatures(state: SiteFeatureSettings | undefined): ResolvedFeatures {
  const profile = profileOf(state);
  const overrides = state?.overrides ?? {};
  const out = {} as ResolvedFeatures;
  for (const key of FEATURE_KEYS) {
    const o = overrides[key];
    out[key] = typeof o === 'boolean' ? o : FEATURE_CATALOG[key].defaults[profile];
  }
  return out;
}

export function isFeatureEnabled(state: SiteFeatureSettings | undefined, key: FeatureKey): boolean {
  return resolveFeatures(state)[key];
}

/** Bilinmeyen anahtarlari ve boolean olmayan degerleri atar (eski/bozuk kayda karsi). */
export function normalizeFeatureSettings(state: SiteFeatureSettings | undefined): SiteFeatureSettings {
  const overrides: FeatureOverrides = {};
  for (const [k, v] of Object.entries(state?.overrides ?? {})) {
    if (isFeatureKey(k) && typeof v === 'boolean') overrides[k] = v;
  }
  return { profile: profileOf(state), overrides };
}

/** Iki etkin durum arasindaki farklar (denetim kaydi icin). */
export function diffFeatures(before: ResolvedFeatures, after: ResolvedFeatures): { key: FeatureKey; from: boolean; to: boolean }[] {
  return FEATURE_KEYS.filter((k) => before[k] !== after[k]).map((k) => ({ key: k, from: before[k], to: after[k] }));
}

/** Web/platform ekrani icin katalog listesi (sirali). */
export function catalogList(): FeatureDefinition[] {
  return FEATURE_KEYS.map((k) => FEATURE_CATALOG[k]);
}
