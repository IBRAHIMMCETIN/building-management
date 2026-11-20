/**
 * Adim 8b - Online aidat odemesi (iyzico Pazaryeri / alt uye isyeri).
 *
 * Kararlar (20.11.2026):
 *  1. Para akisi: pazaryeri modeli; apartman basina `subMerchantKey` (PaymentAccount).
 *  2. Saglayici: iyzico Checkout Form (hosted odeme sayfasi) + 3D Secure.
 *  3/A. Gecikme tazminati YALNIZCA "toplam borc" odemesinde odeme aninda kesinlestirilip tahsil
 *     edilir. Secili kalem odemesi yalnizca anapara oder; secim alt cari basina en eski vadeden
 *     baslayan kesintisiz dizi olmalidir (defterin FIFO mahsubu ile tutarli).
 *  4. Serbest tutar yok: toplam borc veya secili kalemlerin tam tutari.
 *  B. Komisyon apartmandan kesilir: `subMerchantPrice = tutar - platform payi` (varsayilan 0).
 *  C. TCKN saklanmaz: istekte opsiyonel gelir, yalnizca saglayici istegine aktarilir.
 *
 * Tum tutarlar kurus (tam sayi).
 */
import type { IsoDate, IsoDateTime, Kurus, LiableParty, TableKeys } from '../core/types.js';

export const PAYMENT_PROVIDERS = ['iyzico', 'fake'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_MODES = ['total', 'items'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * PENDING      saglayici sayfasina yonlendirildi, sonuc bekleniyor
 * SUCCEEDED    saglayici onayladi ve deftere yazildi (makbuzlar uretildi)
 * FAILED       odeme basarisiz / iptal / suresi doldu (defterde iz yok)
 * NEEDS_REVIEW saglayici basarili dedi ama dogrulama tutmadi (tutar, sepet, fraud):
 *              deftere YAZILMAZ, alarm uretilir, platform ekibi elle sonuclandirir.
 */
export const INTENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** iyzico alt uye isyeri tipleri. Apartman/site yonetimi icin varsayilan PRIVATE_COMPANY. */
export const SUB_MERCHANT_TYPES = ['PERSONAL', 'PRIVATE_COMPANY', 'LIMITED_OR_JOINT_STOCK_COMPANY'] as const;
export type SubMerchantType = (typeof SUB_MERCHANT_TYPES)[number];

/** Platform payi ust siniri (%20); yanlis yapilandirmaya karsi. */
export const MAX_PLATFORM_FEE_BASIS_POINTS = 2_000;

/** Bir alt cari icin odeme dagilimi. `amount = principal + lateFee`. */
export type IntentAllocation = {
  liableParty: LiableParty;
  /** Kapatilan borc (acik tahakkuklar + deftere yazilmis acik tazminat kalemleri). */
  principal: Kurus;
  /** Odeme aninda kesinlesecek, henuz deftere yazilmamis gecikme tazminati (yalnizca total). */
  lateFee: Kurus;
  amount: Kurus;
  /** Apartmanin IBAN'ina aktarilacak tutar (`amount - platform payi`). */
  subMerchantPrice: Kurus;
  /** Secili kalem odemesinde secilen tahakkuk islemleri (total modunda bos). */
  transactionIds: string[];
};

/**
 * Odeme niyeti.
 *   PK = `APT#<apartmentId>`, SK = `PI#<intentId>`
 * `intentId` = `<YYYYMMDDHHmmss UTC>-<uuid>`: zamana gore siralanir; mutabakat SK araligiyla
 * sorgulanir (GSI gerekmez).
 * Durum gecisleri yalnizca `version` kosuluyla yapilir (callback / webhook / mutabakat yarisi).
 */
export type PaymentIntent = TableKeys & {
  entityType: 'PAYMENT_INTENT';
  intentId: string;
  apartmentId: string;
  unitId: string;
  userId: string;
  mode: PaymentMode;
  allocations: IntentAllocation[];
  amount: Kurus;
  platformFee: Kurus;
  currency: 'TRY';
  /** Tazminatin hesaplandigi gun (Istanbul). Kesinlestirmede ust sinir bu gun itibariyla. */
  lateFeeAsOf: IsoDate;
  lateFeeMonthlyBasisPoints: number;
  provider: PaymentProviderName;
  subMerchantKey: string;
  /** Saglayiciya giden `conversationId` (`<apartmentId>:<intentId>`). */
  conversationId: string;
  status: IntentStatus;
  checkout?: { token: string; paymentPageUrl: string; createdAt: IsoDateTime };
  providerPaymentId?: string;
  paidAt?: IsoDate;
  paymentIds?: string[];
  transactionIds?: string[];
  receiptNumbers?: string[];
  failure?: { code: string; message: string; at: IsoDateTime };
  review?: { reason: string; at: IsoDateTime; providerPaymentId?: string };
  /** Saglayici sayfasinin gecerlilik suresi; sonrasinda mutabakat sonuclandirir. */
  expiresAt: IsoDateTime;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  version: number;
};

/**
 * Niyet olusturma idempotency kaydi (kullanici + istemci anahtari).
 *   PK = `APT#<apartmentId>`, SK = `PIKEY#<userId>#<idempotencyKey>`
 */
export type IntentKeyRecord = TableKeys & {
  entityType: 'PAYMENT_INTENT_KEY';
  intentId: string;
  fingerprint: string;
  createdAt: IsoDateTime;
};

/**
 * Apartmanin saglayicidaki alt uye isyeri hesabi. Site ayarlarindan ayri tutulur: yonetici
 * ayar guncellerken KYC verisine dokunulmaz; yalnizca `platform_admin` yazar.
 *   PK = `APT#<apartmentId>`, SK = `PAYACCT#<provider>`
 */
export type PaymentAccount = TableKeys & {
  entityType: 'PAYMENT_ACCOUNT';
  apartmentId: string;
  provider: PaymentProviderName;
  subMerchantKey: string;
  subMerchantType: SubMerchantType;
  /** Yalnizca son 4 hane gorunur (TR** **** **** **** **** **12 34). */
  ibanMasked?: string;
  status: 'active' | 'disabled';
  /** Apartmandan kesilen platform payi, baz puan (0 = yok). */
  platformFeeBasisPoints: number;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};
