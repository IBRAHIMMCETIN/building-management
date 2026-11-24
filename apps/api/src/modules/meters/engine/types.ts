/**
 * Finans 2.3 - Sayac / endeks dagitimi: hesaplama motoru tipleri (saf, I/O yok).
 *
 * Kurallar:
 *  - Endeksler tam sayi saklanir: gercek deger x 10^scale (123,456 m3, scale 3 -> 123456).
 *  - Katsayi (radyator katsayisi) rasyoneldir; agirliklar BigInt ile ortak paydaya genisletilir.
 *  - Tutarlar kurus cinsinden tam sayidir; dagitim en buyuk kalan yontemiyle kurusuna kadar korunur.
 */
import type { IsoDate, LandShare } from '../../core/types.js';

export const METER_KINDS = ['heat_allocator', 'heat_meter', 'hot_water', 'cold_water'] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/** Ortak payin dagitim anahtari (mevcut toplu tahakkuk anahtarlariyla ayni adlar). */
export const COMMON_KEYS = ['equal', 'area', 'land_share'] as const;
export type CommonKey = (typeof COMMON_KEYS)[number];

export const BPS_TOTAL = 10_000;
/** Merkezi isitma yonetmelik varsayilani (m.8): %30 ortak (kullanim alani) + %70 tuketim. */
export const CENTRAL_HEATING_COMMON_BPS = 3_000;
/** Bir dagitimda en fazla sayac olcegi (ondalik basamak). */
export const MAX_SCALE = 6;
/** Sicrama uyarisi: tuketim, gecmis gunluk ortalamanin bu kati asarsa. */
export const SPIKE_MULTIPLIER = 3n;

export type Rational = { num: number; den: number };

/** Sayac sicil kaydinin motorun ihtiyac duydugu kismi. */
export type MeterRecord = {
  meterId: string;
  unitId: string;
  kind: MeterKind;
  /** Endeks ondalik basamak sayisi (0-6). */
  scale: number;
  /** Radyator / cihaz katsayisi; varsayilan 1/1. */
  factor?: Rational;
  /** Tur atma hesabi icin sayacin gosterebilecegi en buyuk endeks (olcekli). */
  maxIndex?: number;
  openingIndex: number;
  installedAt: IsoDate;
  /** Sokulen / emekliye ayrilan sayacin kapanisi (degisim kaydi olmadan emeklilik). */
  retiredAt?: IsoDate;
  closingIndex?: number;
};

/** Sayac degisim / sifirlama kaydi (kural 3). Sifirlama da yeni bir sayac parcasidir. */
export type MeterSwapRecord = {
  swapId: string;
  oldMeterId: string;
  newMeterId: string;
  swapDate: IsoDate;
  oldClosingIndex: number;
  newOpeningIndex: number;
  status: 'active' | 'reversed';
};

/** Sayacin son onayli (geri alinmamis) okumasi: bir sonraki donemin baslangic endeksi. */
export type ApprovedReading = { index: number; date: IsoDate };

/** Donem okumasi (MREAD). `estimated`: yonetici onerilen tahmini acikca onayladi. */
export type PeriodReading = { endIndex: number; estimated?: boolean; rolloverConfirmed?: boolean };

/** Gecmis donem tuketimi (sicrama uyarisi ve tahmin onerisi icin), olcekli tam sayi. */
export type ConsumptionHistory = { delta: number; days: number };

export type SegmentStartSource = 'last_reading' | 'opening' | 'swap_opening';
export type SegmentEndSource = 'reading' | 'swap_closing' | 'retire_closing';

/** Bir sayacin donem icindeki tuketim parcasi. Degisimde eski ve yeni sayac ayri parcadir. */
export type Segment = {
  meterId: string;
  unitId: string;
  kind: MeterKind;
  scale: number;
  factor: Rational;
  maxIndex?: number;
  startIndex: number;
  startDate: IsoDate;
  startSource: SegmentStartSource;
  /** Okuma yoksa tanimsiz (onayi engeller). */
  endIndex?: number;
  endDate: IsoDate;
  endSource?: SegmentEndSource;
  estimated?: boolean;
  rolloverConfirmed?: boolean;
  /** Parcanin gun sayisi (en az 1). */
  days: number;
  history?: ConsumptionHistory[];
};

/** Dagitim kapsamindaki bagimsiz bolum (muafiyet / blok filtresi servis katmaninda yapilir). */
export type DistributionUnit = {
  unitId: string;
  grossAreaTenthsM2: number;
  landShare?: LandShare;
};

export type DistributionTemplate = {
  /** Ortak pay, baz puan (0-10000). Merkezi isitma varsayilani 3000. */
  commonShareBps: number;
  commonKey: CommonKey;
  meterKind: MeterKind;
};

export type DistributionInput = {
  /** Fatura toplami (kurus). */
  totalAmount: number;
  template: DistributionTemplate;
  units: readonly DistributionUnit[];
  segments: readonly Segment[];
};

export type EngineIssueCode =
  // Engelleyici
  | 'invalid_total'
  | 'invalid_ratio'
  | 'no_units'
  | 'duplicate_unit'
  | 'missing_area'
  | 'missing_land_share'
  | 'invalid_index'
  | 'invalid_factor'
  | 'invalid_scale'
  | 'kind_mismatch'
  | 'missing_reading'
  | 'negative_delta'
  | 'invalid_rollover'
  | 'already_read'
  | 'invalid_chain'
  // Uyari
  | 'spike'
  | 'estimated'
  | 'rollover'
  | 'zero_consumption_fallback'
  | 'no_meter_common_only'
  | 'no_meter_zero_charge'
  | 'meter_unit_out_of_scope'
  | 'reading_ignored_replaced';

export type EngineIssue = {
  code: EngineIssueCode;
  message: string;
  unitId?: string;
  meterId?: string;
  /** Eksik okumada onerilen tahmin (yonetici acikca onaylarsa `estimated` okuma olarak girilir). */
  suggestion?: { startIndex: number; suggestedDelta: number; suggestedEndIndex: number };
};

export type SegmentResult = {
  meterId: string;
  startIndex: number;
  endIndex: number;
  startSource: SegmentStartSource;
  endSource: SegmentEndSource;
  delta: number;
  rollover: boolean;
  estimated: boolean;
  factor: Rational;
  scale: number;
};

export type DistributionLine = {
  unitId: string;
  hasMeter: boolean;
  estimated: boolean;
  segments: SegmentResult[];
  /** Tuketim agirligi: ortak olcek ve katsayi paydasina genisletilmis tam sayi. */
  consumptionWeight: bigint;
  /** Gosterim: tuketim, `consumptionScale` ondalikla (ornegin "123.456"). */
  consumption: string;
  commonWeight: bigint;
  commonAmount: number;
  consumptionAmount: number;
  amount: number;
};

export type DistributionTotals = {
  totalAmount: number;
  commonPool: number;
  consumptionPool: number;
  /** Tuketim toplami sifirsa tum tutar ortak anahtarla dagitildi (karar 3). */
  fallbackToCommon: boolean;
  totalConsumptionWeight: bigint;
  totalConsumption: string;
  consumptionScale: number;
  /** Katsayi ortak paydasi (agirlik / (10^scale x payda) = gercek tuketim). */
  consumptionDenominator: bigint;
};

export type DistributionResult =
  | { ok: true; lines: DistributionLine[]; totals: DistributionTotals; warnings: EngineIssue[] }
  | { ok: false; errors: EngineIssue[]; warnings: EngineIssue[] };
