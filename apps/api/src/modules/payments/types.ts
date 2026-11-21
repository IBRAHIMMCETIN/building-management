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
 *  B. Komisyon apartmandan kesilir (Online Odeme v2 · P1, 21.11.2026): platform payi (%0,75) +
 *     tahmini POS maliyeti `subMerchantPrice`'tan dusulur ve apartman defterine "Online Tahsilat
 *     Komisyon Gideri" olarak yazilir; sakine ek ucret yansitilmaz (`fees.ts`).
 *  C. TCKN saklanmaz: istekte opsiyonel gelir, yalnizca saglayici istegine aktarilir.
 *
 * Tum tutarlar kurus (tam sayi).
 */
import type { IsoDate, IsoDateTime, Kurus, LiableParty, TableKeys } from '../core/types.js';

/** `fake` yalnizca yerel gelistirme/test; `paytr` adaptoru P3'te eklenir. */
export const PAYMENT_PROVIDERS = ['iyzico', 'paytr', 'fake'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];
/** Canli ortamda secilebilen saglayicilar (`DEFAULT_PAYMENT_PROVIDER`, apartman tercihi). */
export const LIVE_PAYMENT_PROVIDERS = ['iyzico', 'paytr'] as const;

export const PAYMENT_MODES = ['total', 'items'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * PENDING      saglayici sayfasina yonlendirildi, sonuc bekleniyor
 * SUCCEEDED    saglayici onayladi ve deftere yazildi (makbuzlar uretildi)
 * FAILED       odeme basarisiz / iptal / suresi doldu (defterde iz yok)
 * NEEDS_REVIEW saglayici basarili dedi ama dogrulama tutmadi (tutar, sepet, fraud) veya defter
 *              yazilamadi: deftere YAZILMAZ, alarm uretilir, platform ekibi elle sonuclandirir.
 * REFUND_PENDING platform ekibi tam iade karari verdi; kalem bazli iade(ler) saglayicida suruyor.
 * REFUNDED     tum kalemler saglayicida iade edildi (defterde iz yok: hic yazilmamisti).
 */
export const INTENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'REFUND_PENDING', 'REFUNDED'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Platform inceleme kuyrugundaki durumlar (GSI1 seyrek kaydi bu durumlarda tutulur). */
export const REVIEW_QUEUE_STATUSES: readonly IntentStatus[] = ['NEEDS_REVIEW', 'REFUND_PENDING'];

/**
 * Elle sonuclandirma (yalnizca `platform_admin`; her biri once saglayicidan guncel sonucu sorgular):
 *   approve  saglayici basarili + dogrulama artik tutuyor -> deftere yaz (SUCCEEDED)
 *   refund   saglayici basarili -> tum kalemleri tam iade et (REFUND_PENDING -> REFUNDED)
 *   close    saglayicida basarili cekim yok -> FAILED
 */
export const REVIEW_ACTIONS = ['approve', 'refund', 'close'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Saglayicinin sepet kalemi bazinda islem kimligi (iyzico `paymentTransactionId`): iade bununla yapilir. */
export type ItemTransaction = {
  /** Sepet kalemi kimligi: `<intentId>-<owner|occupant>`. */
  itemId: string;
  paymentTransactionId: string;
  paidAmount: Kurus;
  /** Saglayicinin bu kalemden aldigi gercek komisyon (iyzico: oran tutari + sabit ucret). */
  providerFee?: Kurus;
};

/**
 * Pazaryeri dagitim onayi (iyzico `item/approve`): onaylanmayan kalemin tutari iyzico havuzunda
 * bekler, alt uye isyerine aktarilmaz. Basarili finalize'dan sonra gonderilir; hata halinde
 * mutabakat (`payment_reconcile`) yeniden dener.
 */
export type ItemApproval = {
  itemId: string;
  paymentTransactionId: string;
  status: 'pending' | 'approved' | 'failed';
  attempts: number;
  lastAttemptAt?: IsoDateTime;
  approvedAt?: IsoDateTime;
  error?: { code: string; message: string; at: IsoDateTime };
  /**
   * P4 (platform transferi): bu andan once gonderilmez (`PAYTR_TRANSFER_DELAY_HOURS`, en erken
   * odemenin ertesi gunu). Platform ekibi elle one cekebilir.
   */
  releaseAfter?: IsoDateTime;
  /** P4: gonderilen transfer talimatinin kimligi (PayTR `trans_id`) ve saglayici referansi. */
  transferId?: string;
  providerReference?: string;
};

/** Odeme sonrasi mutabakat kaydi (niyet uzerinde). */
export type IntentSettlement = {
  /** pending: onay bekleyen kalem var; approved: hepsi onayli; failed: deneme siniri asildi. */
  status: 'pending' | 'approved' | 'failed';
  /** Apartmanin komisyon gideri (platform payi + POS tahmini); deftere bu yazildi. */
  commission: Kurus;
  /** Apartmanin IBAN'ina aktarilacak toplam (`Σ subMerchantPrice`). */
  subMerchantTotal: Kurus;
  /** Saglayicinin gercek komisyonu (bilinmiyorsa yok). */
  providerFee?: Kurus;
  /** POS tahmini - gercek komisyon: pozitif = platform marji, negatif = platform kaybi. */
  posFeeDrift?: Kurus;
  approvals: ItemApproval[];
};

/** Sonuclandirma aninda saglayicidan sorgulanan sonucun ozeti (iz kaydi). */
export type ProviderCheck = {
  status: 'success' | 'failure' | 'pending';
  providerPaymentId?: string;
  paidAmount?: Kurus;
  currency?: string;
  fraudApproved?: boolean;
  /** Niyetle uyusmazliklar; bossa deftere islenebilir. */
  problems: string[];
  errorMessage?: string;
  checkedAt: IsoDateTime;
};

export type RefundItem = {
  paymentTransactionId: string;
  itemId: string;
  amount: Kurus;
  /** `refund-<intentId>-<sira>`: saglayici isteginin izlenebilir kimligi. */
  conversationId: string;
  status: 'pending' | 'succeeded' | 'failed';
  /** Son deneme zamani: dolu ise tekrar denemeden once saglayicida iade edilmis tutar sorgulanir. */
  attemptedAt?: IsoDateTime;
  attempts: number;
  providerRefundId?: string;
  completedAt?: IsoDateTime;
  error?: { code: string; message: string; at: IsoDateTime };
};

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
  /** Apartmanin IBAN'ina aktarilacak tutar (`amount - platformFee - posEstimate`). */
  subMerchantPrice: Kurus;
  /** Bu kalemden kesilen platform payi (P1 oncesi niyetlerde yok). */
  platformFee?: Kurus;
  /** Bu kalem icin tahmini POS maliyeti (P1 oncesi niyetlerde yok). */
  posEstimate?: Kurus;
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
  /** Tahmini POS maliyeti toplami (sozlesme orani); P1 oncesi niyetlerde yok (0 sayilir). */
  posEstimate?: Kurus;
  currency: 'TRY';
  /** Tazminatin hesaplandigi gun (Istanbul). Kesinlestirmede ust sinir bu gun itibariyla. */
  lateFeeAsOf: IsoDate;
  lateFeeMonthlyBasisPoints: number;
  provider: PaymentProviderName;
  subMerchantKey: string;
  /** Saglayiciya giden `conversationId` (`<apartmentId>:<intentId>`). */
  conversationId: string;
  /** Saglayici siparis kimligi (PayTR `merchant_oid`); esleme kaydi `PAYREF#<saglayici>#<ref>`. */
  providerReference?: string;
  status: IntentStatus;
  /** `kind` yoksa `redirect` (P2 oncesi niyetler). */
  checkout?: { token: string; paymentPageUrl: string; kind?: 'redirect' | 'iframe'; createdAt: IsoDateTime };
  providerPaymentId?: string;
  paidAt?: IsoDate;
  paymentIds?: string[];
  transactionIds?: string[];
  receiptNumbers?: string[];
  failure?: { code: string; message: string; at: IsoDateTime };
  /**
   * Imzali bildirimdeki basarisizlik (PayTR). Niyet hemen FAILED olmaz (gec gelen basari kaybolmasin);
   * sayfa suresi dolunca mutabakat bu kodla FAILED yapar. Sakin sonuc ekraninda bilgilendirilir.
   */
  providerNotice?: { status: 'failure'; code?: string; message?: string; at: IsoDateTime };
  review?: { reason: string; at: IsoDateTime; providerPaymentId?: string };
  /** Saglayicinin kalem islem kimlikleri (basarili sonucta kaydedilir; iade icin gerekir). */
  itemTransactions?: ItemTransaction[];
  /** Elle sonuclandirma kaydi (yalnizca eklenir; ayni niyette tekrar iade denemesi `refund` icinde izlenir). */
  resolution?: { action: ReviewAction; note: string; by: string; at: IsoDateTime; providerCheck: ProviderCheck };
  /** Tam iade (yalnizca `refund` kararinda). */
  refund?: { items: RefundItem[]; requestedAt: IsoDateTime; requestedBy: string; completedAt?: IsoDateTime };
  /** Odeme sonrasi pazaryeri onayi ve komisyon mutabakati (SUCCEEDED niyetlerde). */
  settlement?: IntentSettlement;
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
  /** Apartmandan kesilen platform payi, baz puan (varsayilan 75 = %0,75). */
  platformFeeBasisPoints: number;
  /** Saglayici sozlesme orani (baz puan); yoksa ortam varsayilani `PAYMENTS_POS_RATE_BPS`. */
  posRateBasisPoints?: number;
  /** Islem basina sabit saglayici ucreti (kurus); yoksa `PAYMENTS_POS_FIXED_FEE_KURUS`. */
  posFixedFeeKurus?: number;
  /**
   * P4: aktarim alicisi (IBAN + hesap sahibi adi) KMS ile sifreli (`payee.ts`). Yanitlarda
   * yalnizca `ibanMasked` gorunur; cozme yalnizca transfer talimatini gonderen worker'da.
   */
  payeeCiphertext?: string;
  payeeUpdatedAt?: IsoDateTime;
  /** P4: platform komisyon faturasinin muhatabi (apartman/site yonetimi, VKN). */
  invoiceRecipient?: InvoiceRecipient;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

/**
 * Apartmanin online odeme tercihi (Online Odeme v2 · P2). Yalnizca `platform_admin` yazar.
 *   PK = `APT#<apartmentId>`, SK = `PAYSETTINGS`
 * `paymentProvider` yoksa ortam varsayilani (`DEFAULT_PAYMENT_PROVIDER`) kullanilir. Tercih yeni
 * niyetleri etkiler; devam eden niyetler kendi saglayicisiyla tamamlanir.
 */
export type PaymentSettings = TableKeys & {
  entityType: 'PAYMENT_SETTINGS';
  apartmentId: string;
  paymentProvider?: PaymentProviderName;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

/**
 * Saglayici siparis kimligi -> niyet eslemesi (PayTR bildirimi yalnizca `merchant_oid` tasir).
 * Niyetle ayni atomik yazimda olusturulur; tenant disi anahtar yalnizca bu eslemeyi tasir.
 *   PK = `PAYREF#<provider>#<reference>`, SK = `PAYREF`
 */
export type IntentRefRecord = TableKeys & {
  entityType: 'PAYMENT_INTENT_REF';
  provider: PaymentProviderName;
  reference: string;
  apartmentId: string;
  intentId: string;
  createdAt: IsoDateTime;
};

// ---------------------------------------------------------------------------
// P4: platform transferi (PayTR) ve platform komisyon faturasi
// ---------------------------------------------------------------------------

/**
 * SENT           talimat saglayicida kabul edildi
 * SETTLED        saglayici transferin sonuclandigini bildirdi
 * RETURNED       banka aktarimi iade etti (hatali IBAN/ad); para saglayicida bekliyor -> alarm
 * RESEND_PENDING platform ekibi (duzeltilmis alici ile) yeniden gonderim istedi; worker gonderir
 * RESEND_SENT    yeniden gonderim saglayicida kabul edildi, sonuc bekleniyor
 * RESENT         yeniden gonderim basarili
 * RESEND_FAILED  yeniden gonderim reddedildi -> alarm, tekrar istenebilir
 */
export const PAYOUT_STATUSES = ['SENT', 'SETTLED', 'RETURNED', 'RESEND_PENDING', 'RESEND_SENT', 'RESENT', 'RESEND_FAILED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
/** Platform ekibinin ilgilenmesi gereken durumlar. */
export const PAYOUT_ATTENTION_STATUSES: readonly PayoutStatus[] = ['RETURNED', 'RESEND_PENDING', 'RESEND_SENT', 'RESEND_FAILED'];

/**
 * Pazaryeri payinin apartmana aktarim kaydi (kalem basina bir talimat).
 *   PK = `APT#<apartmentId>`, SK = `PAYOUT#<transferId>`
 *   GSI1PK = `PAYOUT`, GSI1SK = `<sentAt>#<transferId>#APT#<apartmentId>` (tum apartmanlar, zamana gore)
 * IBAN'in kendisi tutulmaz: maskeli hali ve son 4 hane (geri donen aktarim eslemesi).
 */
export type PayoutTransfer = TableKeys & {
  entityType: 'PAYOUT_TRANSFER';
  apartmentId: string;
  provider: PaymentProviderName;
  intentId: string;
  itemId: string;
  transferId: string;
  /** Odemenin saglayici kimligi (PayTR `merchant_oid`). */
  providerPaymentId: string;
  /** Alt uye isyerine aktarilan (`submerchant_amount`). */
  amount: Kurus;
  /** Kalemin brut tutari (`total_amount`). */
  grossAmount: Kurus;
  ibanMasked: string;
  ibanLast4: string;
  status: PayoutStatus;
  sentAt: IsoDateTime;
  providerReference?: string;
  settledAt?: IsoDateTime;
  returned?: { refNo: string; detectedAt: IsoDateTime; returnedOn?: string; amount: Kurus };
  /** Kac kez yeniden gonderim istendi (yeniden gonderim kimligi `<transferId>R<n>`). */
  resendCount?: number;
  resend?: {
    resendId: string;
    requestedAt: IsoDateTime;
    requestedBy: string;
    note: string;
    /** Yeniden gonderimde kullanilacak alici (KMS ile sifreli, apartman hesabindan). */
    payeeCiphertext: string;
    ibanMasked: string;
    attempts: number;
    sentAt?: IsoDateTime;
    completedAt?: IsoDateTime;
    error?: { code: string; message: string; at: IsoDateTime };
  };
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
};

/** Saglayici transfer kimligi -> apartman (transfer sonuc bildirimi yalnizca kimlik tasir). */
export type PayoutRefRecord = TableKeys & {
  entityType: 'PAYOUT_REF';
  provider: PaymentProviderName;
  reference: string;
  apartmentId: string;
  transferId: string;
  createdAt: IsoDateTime;
};

/** Platform komisyon faturasinin muhatabi: apartman/site yonetimi (VKN). */
export type InvoiceRecipient = { title: string; taxNumber: string; taxOffice: string };

export const INVOICE_STATUSES = ['DRAFT', 'NEEDS_RECIPIENT', 'ISSUED', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Platform komisyon faturasi taslagi / mutabakat kaydi (saglayici bagimsiz; `invoices.ts`).
 *   PK = `APT#<apartmentId>`, SK = `PINV#<invoiceId>`
 *   invoiceId: aylik `M-<YYYY-MM>`, odeme bazli `P-<intentId>`
 * Satirlar yalnizca deftere yazilmis (SUCCEEDED) online odemelerin platform payidir.
 */
export type PlatformInvoice = TableKeys & {
  entityType: 'PLATFORM_INVOICE';
  invoiceId: string;
  apartmentId: string;
  mode: 'monthly' | 'per_payment';
  period: string;
  status: InvoiceStatus;
  recipient?: InvoiceRecipient;
  lines: { intentId: string; paidAt?: IsoDate; amount: Kurus; platformFee: Kurus }[];
  /** KDV haric tutar. */
  netAmount: Kurus;
  vatRateBasisPoints: number;
  /** `exclusive`: platform payi KDV haric (KDV ustune eklenir); `inclusive`: pay KDV dahil. */
  vatMode: 'exclusive' | 'inclusive';
  vatAmount: Kurus;
  totalAmount: Kurus;
  reconciliation: { intentCount: number; platformFeeTotal: Kurus; sourceHash: string; generatedAt: IsoDateTime };
  /** Fatura saglayicisi (`manual` = entegrator yok, numara elle girilir). */
  invoiceProvider: string;
  externalId?: string;
  invoiceNumber?: string;
  issuedAt?: IsoDateTime;
  issuedBy?: string;
  cancelledAt?: IsoDateTime;
  cancelReason?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
};
