import type { SiteFeatureSettings } from '../features/catalog.js';
import type { TicketSettings } from '../tickets/types.js';
/**
 * Faz 1 - Cekirdek modul veri modelleri.
 *
 * Kavramlar:
 *  - Tenant  : Hesap sahibi / yonetim firmasi (Organization). Bir tenant birden
 *              fazla Site'yi portfoy olarak yonetebilir. Bireysel yoneticiler
 *              icin tek siteli bir tenant olusturulur.
 *  - Site    : Apartman veya site. Veri izolasyonu birimidir: `Site.id`,
 *              JWT'deki `apartmentId` claim'i ve DynamoDB partition key'inin
 *              (`APT#<apartmentId>`) kaynagidir.
 *  - Block   : Siteye bagli blok (A Blok, B Blok...). Tek bloklu apartmanlarda
 *              tek varsayilan blok kullanilir.
 *  - Unit    : Bagimsiz bolum (daire, dukkan, ...).
 *
 * Kurallar:
 *  - Para birimi daima TRY; tum tutarlar KURUS cinsinden tam sayidir.
 *  - Tarihler ISO 8601 string; saat dilimi Europe/Istanbul gerektiren
 *    takvim tarihleri `IsoDate` (YYYY-MM-DD) olarak tutulur.
 *  - Silme yok: kayitlar `status` ile pasife alinir.
 */

// ---------------------------------------------------------------------------
// Temel tipler
// ---------------------------------------------------------------------------

/** Kurus cinsinden tam sayi (1.500,50 TL -> 150050). Kayan nokta kullanilmaz. */
export type Kurus = number & { readonly __brand: 'Kurus' };

export function toKurus(value: number): Kurus {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Kurus tam sayi olmalidir: ${value}`);
  }
  return value as Kurus;
}

/** Metrekareyi (ornegin 85,5) 10 ile carpilmis tam sayiya cevirir (855). En az 0,1 m2. */
export function toTenthsM2(m2: number): number {
  if (!Number.isFinite(m2) || m2 <= 0) {
    throw new Error(`Metrekare pozitif olmalidir: ${m2}`);
  }
  const tenths = Math.round(m2 * 10);
  if (tenths < 1 || !Number.isSafeInteger(tenths)) {
    throw new Error(`Metrekare gecersiz veya cok kucuk/buyuk: ${m2}`);
  }
  return tenths;
}

/** `grossAreaTenthsM2` degerini m2'ye cevirir (855 -> 85.5). */
export function tenthsM2ToM2(tenths: number): number {
  if (!Number.isSafeInteger(tenths) || tenths < 1) {
    throw new Error(`grossAreaTenthsM2 pozitif tam sayi olmalidir: ${tenths}`);
  }
  return tenths / 10;
}

/** ISO 8601 zaman damgasi (UTC), ornegin "2026-11-06T09:30:00.000Z". */
export type IsoDateTime = string;

/** Takvim tarihi "YYYY-MM-DD" (Europe/Istanbul). */
export type IsoDate = string;

export type Currency = 'TRY';

export type EntityStatus = 'active' | 'inactive';

/** DynamoDB single-table anahtarlari. Kayit turu `entityType` ile ayristirilir. */
export type TableKeys = {
  /** `APT#<apartmentId>` (tenant'a ait kayitlar) */
  PK: string;
  /** `SITE#..`, `BLOCK#<blockId>`, `UNIT#<unitId>` vb. */
  SK: string;
};

/** Tum kayitlarda bulunan denetim ve surum alanlari. */
export type AuditFields = {
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  /** Optimistic locking icin; her yazimda 1 artar. */
  version: number;
};

type Entity<T extends string> = TableKeys &
  AuditFields & {
    entityType: T;
    status: EntityStatus;
  };

// ---------------------------------------------------------------------------
// Tenant (Organization / yonetim firmasi)
// ---------------------------------------------------------------------------

export type TenantType = 'management_company' | 'individual';

/**
 * Tenant kayitlari apartman partition'indan bagimsizdir:
 *   PK = `ORG#<tenantId>`, SK = `PROFILE`
 */
export type Tenant = TableKeys &
  AuditFields & {
    entityType: 'TENANT';
    tenantId: string;
    name: string;
    type: TenantType;
    taxNumber?: string;
    contactEmail?: string;
    contactPhone?: string;
    status: EntityStatus;
  };

// ---------------------------------------------------------------------------
// Dagitim anahtarlari ve yonetim plani kurallari
// ---------------------------------------------------------------------------

export const DISTRIBUTION_KEYS = ['equal', 'land_share', 'area', 'meter'] as const;
export type DistributionKey = (typeof DISTRIBUTION_KEYS)[number];

/** Gider gruplari; hangi gider hangi dagitim anahtariyla ve kime yazilir. */
export type ExpenseGroup =
  | 'operating' // aidat, temizlik, guvenlik, ortak elektrik/su
  | 'heating' // isinma / payolcer
  | 'capital' // demirbas, mantolama, asansor yenileme
  | 'other';

/** Borcun hangi alt cariye yazilacagi. */
export type LiableParty = 'occupant' | 'owner';

export type ExpenseGroupRule = {
  group: ExpenseGroup;
  defaultKey: DistributionKey;
  /** operating/heating -> occupant (kiraci, yoksa malik); capital -> owner. */
  liableParty: LiableParty;
};

export type MeterSplitRule = {
  /** Ortak tuketim payi, yuzde (ornegin 30). Tam sayi; kalan bireysel paydir. */
  commonSharePercent: number;
  /** Ortak payin dagitim anahtari (genellikle 'area'). */
  commonShareKey: Exclude<DistributionKey, 'meter'>;
};

// ---------------------------------------------------------------------------
// Site (apartman / site)
// ---------------------------------------------------------------------------

export type SiteType = 'apartment' | 'site' | 'residence';

export type Address = {
  line1: string;
  line2?: string;
  district: string;
  city: string;
  postalCode?: string;
};

/**
 * Otomatik aylik aidat plani: her ayin 1'inde zamanlanmis gorev toplam tutari dagitim
 * anahtarina gore aktif bagimsiz bolumlere tahakkuk eder (son odeme: `dueDayOfMonth`).
 */
export type MonthlyDuesPlan = {
  enabled: boolean;
  /** Aylik toplam tutar (kurus). */
  totalAmount: Kurus;
  distributionKey: Exclude<DistributionKey, 'meter'>;
  /** Isletme gideri -> occupant (oturan), yatirim -> owner. */
  liableParty: LiableParty;
  /** Finans 2.4: tahakkukun alacak yazilacagi gelir hesabi (varsayilan `income-dues`). */
  incomeAccountId?: string;
  /** Finans 2.4: plani olusturan onayli butce (isletme projesi). */
  budgetId?: string;
};

export type SiteSettings = {
  /** Arsa payi anahtari opsiyoneldir; yonetim plani gerektirmiyorsa false. */
  landShareEnabled: boolean;
  expenseGroupRules: ExpenseGroupRule[];
  meterSplit?: MeterSplitRule;
  /** Aylik aidatin son odeme gunu (1-28). */
  dueDayOfMonth: number;
  /** Aylik gecikme faizi orani, baz puan (100 = %1). Kistelyevm gunluge bolunerek hesaplanir. */
  lateFeeMonthlyBasisPoints: number;
  /** Tanimsiz veya `enabled: false` ise otomatik tahakkuk yapilmaz. */
  monthlyDuesPlan?: MonthlyDuesPlan;
  /** Faz 3 (O1): ariza / talep ayarlari (SLA, gorevli havuzu, otomatik kapanis). Yoksa varsayilanlar. */
  tickets?: TicketSettings;
  /**
   * Adim 1: site bazli ozellik anahtarlari (modules/features/catalog.ts). Yoksa `legacy` profil
   * (Adim 1 oncesi davranis). Yalnizca platform uclari yazar; site PATCH'i bu alani degistiremez.
   */
  features?: SiteFeatureSettings;
  timezone: 'Europe/Istanbul';
  currency: Currency;
};

/**
 *   PK = `APT#<siteId>`, SK = `SITE`
 * `siteId` JWT'deki `apartmentId` claim'ine karsilik gelir.
 */
export type Site = Entity<'SITE'> & {
  siteId: string;
  tenantId: string;
  name: string;
  type: SiteType;
  address: Address;
  /** Mali donem baslangic ayi (1-12). */
  fiscalYearStartMonth: number;
  settings: SiteSettings;
};

// ---------------------------------------------------------------------------
// Blok
// ---------------------------------------------------------------------------

/**
 *   PK = `APT#<siteId>`, SK = `BLOCK#<blockId>`
 */
export type Block = Entity<'BLOCK'> & {
  blockId: string;
  siteId: string;
  /** Ornegin "A Blok". */
  name: string;
  floorCount?: number;
  /** Blok bazli gider muafiyeti/ozel gider dagitimi icin etiketler. */
  tags?: string[];
};

// ---------------------------------------------------------------------------
// Bagimsiz bolum (daire / dukkan)
// ---------------------------------------------------------------------------

export type UnitType = 'flat' | 'duplex' | 'shop' | 'office' | 'parking' | 'storage' | 'other';

/** Tapudaki arsa payi; kesirli sayi hatasini onlemek icin pay/payda tam sayi. */
export type LandShare = {
  numerator: number;
  denominator: number;
};

/** Bir bagimsiz bolumun muaf tutuldugu gider kalemleri. */
export type UnitExemption = {
  /** Ornegin 'elevator', 'playground', 'pool' veya ExpenseGroup. */
  expenseCategory: string;
  reason?: string;
  validFrom?: IsoDate;
  validTo?: IsoDate;
};

/**
 *   PK = `APT#<siteId>`, SK = `UNIT#<unitId>`
 *
 * Malik/kiraci bagi `Membership` ve daire-kisi kayitlarinda (sonraki adim)
 * tutulur; borc kisinin alt carisine yazildigi icin Unit uzerinde bakiye yoktur.
 */
export type Unit = Entity<'UNIT'> & {
  unitId: string;
  siteId: string;
  blockId: string;
  /** Kapi / daire numarasi, ornegin "5". */
  number: string;
  floor?: number;
  type: UnitType;
  /** Brut metrekare; 1 ondalik hassasiyet icin 10 ile carpilmis tam sayi (85,5 m2 -> 855). */
  grossAreaTenthsM2: number;
  landShare?: LandShare;
  /** Dagitim anahtarinda esit pay/ozel katsayi gerekiyorsa. */
  exemptions: UnitExemption[];
};

// ---------------------------------------------------------------------------
// Girdi (create) tipleri - API katmaninin kabul edecegi alanlar
// ---------------------------------------------------------------------------

type CreateInput<T, Generated extends keyof T> = Omit<
  T,
  Generated | keyof TableKeys | keyof AuditFields | 'entityType' | 'status'
>;

export type CreateTenantInput = Omit<
  Tenant,
  keyof TableKeys | keyof AuditFields | 'entityType' | 'tenantId' | 'status'
>;
export type CreateSiteInput = CreateInput<Site, 'siteId'>;
export type CreateBlockInput = CreateInput<Block, 'blockId' | 'siteId'>;
export type CreateUnitInput = CreateInput<Unit, 'unitId' | 'siteId'>;
