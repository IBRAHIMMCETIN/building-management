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
import type { Payee } from './payee.js';
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
  /**
   * Saglayicinin siparis kimligi (`checkoutReference`; PayTR `merchant_oid`). Saglayici
   * `checkoutReference` tanimlamiyorsa yoktur.
   */
  reference?: string;
  /** Odeme sayfasinin gecerlilik suresi (dakika; PayTR `timeout_limit`). */
  expiresInMinutes: number;
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
  /**
   * `payout_transfer`: odeme onayindan sonra transfer talimati icin bekleme (saat). Talimat
   * ayrica en erken odemenin ERTESI gunu verilir (PayTR: ayni gun talimat olusturulmaz).
   */
  releaseDelayHours?: number;
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
  /** Kalemin sakinden tahsil edilen brut tutari (PayTR transferinde `total_amount`). */
  grossAmount: Kurus;
  /** Bizim urettigimiz transfer kimligi (PayTR `trans_id`, alfanumerik); talimat bununla izlenir. */
  transferId: string;
  /** `payout_transfer`: cozulmus alici (IBAN + hesap sahibi). Yalnizca talimat aninda bellekte. */
  payee?: Payee;
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
  /** Odemenin saglayici kimligi (iyzico `paymentId`, PayTR `merchant_oid`): siparis bazli iade icin. */
  providerPaymentId: string;
  paymentTransactionId: string;
  amount: Kurus;
  /** Izleme kimligi; saglayici yanitinda aynen donmeli. */
  conversationId: string;
  ip: string;
};

export type RefundResult = { providerRefundId?: string };

export type WebhookInput = { headers: Record<string, string | undefined>; body: unknown };

/**
 * Imzasi dogrulanmis webhook. Niyet `conversationId` (`<apartmentId>:<intentId>`) veya saglayici
 * siparis kimligi (`reference`, PayTR `merchant_oid`; servis esleme kaydindan bulur) ile bulunur.
 * `notice`: imzali bildirimdeki durum. Basari yine saglayicidan SORGULANARAK uygulanir; basarisizlik
 * sorgulanamayan saglayicida (PayTR yalnizca basarili odemeyi raporlar) niyete not dusulur.
 */
export type WebhookEvent = {
  conversationId?: string;
  reference?: string;
  notice?: { status: 'success' | 'failure'; code?: string; message?: string };
};

export type ReleaseResult = { providerReference?: string };

/** Imzasi dogrulanmis transfer sonuc bildirimi (PayTR "Platform Transfer Sonucu Bildirim URL"). */
export type TransferEvent =
  | { kind: 'settled'; transferIds: string[] }
  | {
      kind: 'resend_result';
      resendId: string;
      results: { amount?: Kurus; ibanLast4: string; result: 'success' | 'failed' }[];
    };

/** Banka tarafindan iade edilen (geri donen) aktarim; saglayici transfer kimligi vermeyebilir. */
export type ReturnedTransfer = {
  refNo: string;
  ibanLast4: string;
  amount: Kurus;
  /** Orijinal talimatin tarihi (Istanbul, YYYY-MM-DD). */
  transferDate?: IsoDate;
  detectedAt?: string;
  returnedOn?: string;
};

/** Webhook'a saglayicinin bekledigi yanit (iyzico JSON, PayTR duz metin `OK`). */
export type WebhookReply = { contentType: 'application/json' | 'text/plain'; body: string };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Sandbox/test ortami: TCKN yerine saglayicinin test numarasi kullanilir. */
  readonly sandbox: boolean;
  readonly capabilities: ProviderCapabilities;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Saglayicinin bildirimlerde tasidigi siparis kimligi (PayTR `merchant_oid`, alfanumerik).
   * Tanimliysa servis niyetle birlikte bir esleme kaydi yazar (`PAYREF#`); webhook `reference`
   * ile niyeti bulur. Tanimli degilse niyet `conversationId` ile bulunur (iyzico).
   */
  checkoutReference?(intent: { intentId: string; conversationId: string }): string;
  /**
   * Tarayici donusunden oturum kimligini (token) cikarir. Govdeye guvenilmez: servis token'i
   * niyetle eslestirir ve sonucu yine saglayicidan sorgular. Token tasimayan saglayicida
   * (PayTR) yalnizca `ref` ile niyet bulunur; o zaman `{}` doner. Gecersiz donus: `null`.
   */
  parseCallback(input: CallbackInput): { token?: string } | null;
  /**
   * Sonucu saglayicidan sorgular. `reference`: niyetin saglayici siparis kimligi (varsa).
   * Kalem islem kimligi donmeyen saglayicida (PayTR) servis kalemleri niyetten turetir.
   */
  retrieveCheckout(query: { token: string; conversationId: string; intentId: string; reference?: string }): Promise<CheckoutOutcome>;
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
  refundedAmounts(query: {
    providerPaymentId: string;
    conversationId: string;
    /** Iade sirasina gore kalemler: siparis bazli iade raporlayan saglayicida (PayTR) dagitim icin. */
    items: { paymentTransactionId: string; amount: Kurus }[];
  }): Promise<Map<string, Kurus>>;
  /**
   * Pazaryeri payini alt uye isyerine serbest birakir (`capabilities.settlement`): iyzico'da
   * kalem onayi (`POST /payment/iyzipos/item/approve`), PayTR'de platform transferi (P4).
   * `automatic` saglayicida tanimlanmaz. Idempotent olmali (ayni kalem tekrar gonderilebilir).
   * Hata: `PaymentProviderError` (`retryable` ile).
   */
  releaseItem?(request: ReleaseRequest): Promise<ReleaseResult | void>;
  /** P4: transfer sonuc bildirimi (imza dogrulama). Gecersizse null. */
  verifyTransferWebhook?(input: WebhookInput): Promise<TransferEvent | null>;
  /** P4: tarih araliginda geri donen aktarimlar (gunluk kontrol). */
  listReturnedTransfers?(range: { from: Date; to: Date }): Promise<ReturnedTransfer[]>;
  /** P4: geri donen tutari (duzeltilmis) aliciya yeniden gonderir; sonuc bildirimle gelir. */
  resendReturned?(request: { resendId: string; amount: Kurus; payee: Payee }): Promise<void>;
  /**
   * Webhook imzasini dogrular; gecerliyse niyeti bulmak icin `conversationId` veya `reference`
   * doner, degilse null. Govdedeki basari durumuna guvenilmez: servis sonucu saglayicidan sorgular.
   */
  verifyWebhook?(input: WebhookInput): Promise<WebhookEvent | null>;
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
