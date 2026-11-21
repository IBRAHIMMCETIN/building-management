/**
 * Odeme saglayicisi soyutlamasi (Online Odeme v2 · P2). Servis yalnizca bu arayuzu bilir;
 * iyzico, yerel/test icin sahte saglayici ve (P3) PayTR bunu uygular. Kart verisi bu sisteme hic
 * gelmez: saglayicinin barindirdigi odeme sayfasi (yonlendirme veya iframe) kullanilir.
 *
 * Saglayiciya ozgu her sey burada kalir: istek bicimi/imza, tarayici donusunun ayristirilmasi,
 * webhook imzasi ve yaniti, pazaryeri payinin serbest birakilma bicimi (onay / transfer). Servis
 * saglayiciyi `registry.ts` uzerinden ADIYLA bulur: yeni niyet apartmanin cozumlenen
 * saglayicisini, mevcut niyetin tum adimlari (sorgu, onay, iade, webhook) niyete yazilan
 * saglayiciyi kullanir.
 */
import type { IsoDate, Kurus } from '../core/types.js';
import type { ItemTransaction, PaymentProviderName, SubMerchantType } from './types.js';

export type CheckoutItem = {
  /** Sepet kalemi kimligi: `<intentId>-<owner|occupant>`. */
  id: string;
  name: string;
  amount: Kurus;
  subMerchantKey: string;
  subMerchantPrice: Kurus;
};

export type CheckoutBuyer = {
  id: string;
  /** TCKN: veritabanina yazilmaz, yalnizca saglayici istegine gider. */
  identityNumber: string;
  ip: string;
  name: string;
  surname: string;
  email: string;
  /** E.164 (+90...). Saklanmaz; istekte gelir. */
  gsmNumber?: string;
  /** Kayit/fatura adresi: apartmanin adresi. */
  address: string;
  city: string;
};

export type CheckoutRequest = {
  intentId: string;
  /** `<apartmentId>:<intentId>`; saglayici sonucunda aynen geri doner (dogrulama). */
  conversationId: string;
  amount: Kurus;
  currency: 'TRY';
  callbackUrl: string;
  buyer: CheckoutBuyer;
  items: CheckoutItem[];
};

export type CheckoutSession = {
  /** Saglayici oturum kimligi; sonuc bununla sorgulanir. */
  token: string;
  /** Sakinin acacagi odeme sayfasi (yonlendirme) veya iframe adresi. */
  paymentPageUrl: string;
};

/**
 * Pazaryeri payinin alt uye isyerine gecis bicimi:
 *  - `item_approval`  : kalem bazli onay (iyzico `item/approve`); onaylanmayan tutar havuzda bekler.
 *  - `payout_transfer`: platform transferi (PayTR Platform Transfer, P4); bekleme suresi sonrasi.
 *  - `automatic`      : saglayici kendisi aktarir; servis islem yapmaz.
 */
export type SettlementMode = 'item_approval' | 'payout_transfer' | 'automatic';

export type ProviderCapabilities = {
  /** Odeme sayfasi: tam sayfa yonlendirme veya sayfaya gomulu iframe. */
  checkout: 'redirect' | 'iframe';
  settlement: SettlementMode;
  /** Canli ortamda alicinin cep telefonu zorunlu mu (sandbox'ta test degeri kullanilir). */
  requiresBuyerGsm: boolean;
};

/** Tarayicinin saglayicidan donusu (callback): sorgu parametreleri + form/JSON govde alanlari. */
export type CallbackInput = { query: Record<string, string | undefined>; body: Record<string, unknown> };

/**
 * Pazaryeri payini serbest birakma istegi (onay veya transfer). `providerItemId` saglayicinin
 * kalem islem kimligidir (iyzico `paymentTransactionId`).
 */
export type ReleaseRequest = {
  itemId: string;
  providerItemId: string;
  providerPaymentId?: string;
  subMerchantKey: string;
  /** Alt uye isyerine gececek tutar (kalemin `subMerchantPrice`'i). */
  amount: Kurus;
  /** Izleme / idempotency kimligi. */
  conversationId: string;
};

/**
 * Saglayicidan SORGULANAN sonuc (callback govdesine guvenilmez).
 * pending: kullanici henuz odemeyi tamamlamadi / sonuc kesin degil.
 */
export type CheckoutOutcome = {
  status: 'success' | 'failure' | 'pending';
  token: string;
  providerPaymentId?: string;
  basketId?: string;
  conversationId?: string;
  paidAmount?: Kurus;
  currency?: string;
  /** false: saglayici fraud incelemesinde / reddetti. */
  fraudApproved?: boolean;
  /** Saglayicinin bildirdigi odeme gunu (Istanbul); yoksa sonuclandirma gunu kullanilir. */
  paidAt?: IsoDate;
  /** Yanit imzasi dogrulandi mi (saglayici imza donduruyorsa). false -> incelemeye alinir. */
  signatureValid?: boolean;
  /** Basarili sonucta sepet kalemi bazinda saglayici islem kimlikleri (iade bunlarla yapilir). */
  itemTransactions?: ItemTransaction[];
  /** Saglayicinin bu odemeden aldigi gercek komisyon toplami (mutabakat; bilinmiyorsa yok). */
  providerFee?: Kurus;
  errorCode?: string;
  errorMessage?: string;
};

/** Alt uye isyeri kaydi (pazaryeri). KYC verisi saglayicida kalir; bizde yalnizca anahtar. */
export type SubMerchantRequest = {
  subMerchantType: SubMerchantType;
  /** Bizdeki esleme kimligi: apartmentId. */
  externalId: string;
  name?: string;
  email: string;
  gsmNumber: string;
  address: string;
  iban: string;
  taxOffice?: string;
  taxNumber?: string;
  legalCompanyTitle?: string;
  contactName?: string;
  contactSurname?: string;
  identityNumber?: string;
};

/** Kalem bazli iade istegi (iyzico `/payment/refund`, `paymentTransactionId`). */
export type RefundRequest = {
  paymentTransactionId: string;
  amount: Kurus;
  /** Izleme kimligi; saglayici yanitinda aynen donmeli. */
  conversationId: string;
  ip: string;
};

export type RefundResult = { providerRefundId?: string };

export type WebhookInput = { headers: Record<string, string | undefined>; body: unknown };

/** Webhook'a saglayicinin bekledigi yanit (iyzico JSON, PayTR duz metin `OK`). */
export type WebhookReply = { contentType: 'application/json' | 'text/plain'; body: string };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Sandbox/test ortami: TCKN yerine saglayicinin test numarasi kullanilir. */
  readonly sandbox: boolean;
  readonly capabilities: ProviderCapabilities;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Tarayici donusunden oturum kimligini (token) cikarir. Govdeye guvenilmez: servis token'i
   * niyetle eslestirir ve sonucu yine saglayicidan sorgular. Token tasimayan saglayicida
   * (PayTR) yalnizca `ref` ile niyet bulunur; o zaman `{}` doner. Gecersiz donus: `null`.
   */
  parseCallback(input: CallbackInput): { token?: string } | null;
  retrieveCheckout(query: { token: string; conversationId: string }): Promise<CheckoutOutcome>;
  registerSubMerchant(request: SubMerchantRequest): Promise<{ subMerchantKey: string }>;
  /**
   * Bir sepet kalemini (kismi veya tam) iade eder. Reddedilirse `PaymentProviderError`
   * (`retryable=false`); ag/zaman asimi gibi sonucu belirsiz hatalarda `retryable=true`.
   */
  refundItem(request: RefundRequest): Promise<RefundResult>;
  /**
   * Odemenin kalem bazinda saglayicida simdiye kadar iade edilmis tutarlari
   * (`paymentTransactionId` -> kurus). Sonucu belirsiz bir iade tekrar denenmeden once
   * cagrilir: boylece ayni kalem iki kez iade edilmez.
   */
  refundedAmounts(query: { providerPaymentId: string; conversationId: string }): Promise<Map<string, Kurus>>;
  /**
   * Pazaryeri payini alt uye isyerine serbest birakir (`capabilities.settlement`): iyzico'da
   * kalem onayi (`POST /payment/iyzipos/item/approve`), PayTR'de platform transferi (P4).
   * `automatic` saglayicida tanimlanmaz. Idempotent olmali (ayni kalem tekrar gonderilebilir).
   * Hata: `PaymentProviderError` (`retryable` ile).
   */
  releaseItem?(request: ReleaseRequest): Promise<void>;
  /**
   * Webhook imzasini dogrular; gecerliyse niyeti bulmak icin `conversationId` doner, degilse
   * null. Govdedeki odeme durumuna guvenilmez: servis sonucu yine saglayicidan sorgular.
   */
  verifyWebhook?(input: WebhookInput): Promise<{ conversationId: string } | null>;
  /** Islenen (veya bilinmeyen niyetli) gecerli webhook'a verilecek yanit; yoksa `{"ok":true}`. */
  webhookReply?(): WebhookReply;
}

/** Govdedeki zorunlu `token` alani (iyzico ve sahte saglayicinin tarayici POST'u). */
export function tokenFromBody(input: CallbackInput): { token: string } | null {
  const t = input.body.token;
  return typeof t === 'string' && t.length > 0 && t.length <= 512 ? { token: t } : null;
}

/** Saglayiciya ulasilamadi veya istek reddedildi. */
export class PaymentProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** iyzico sandbox'in kabul ettigi test kimlik numarasi (Karar C). */
export const SANDBOX_IDENTITY_NUMBER = '11111111111';
/** Sandbox'ta telefon verilmezse kullanilan ornek numara (iyzico dokumanindaki ornek). */
export const SANDBOX_GSM_NUMBER = '+905350000000';
