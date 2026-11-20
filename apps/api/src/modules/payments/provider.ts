/**
 * Odeme saglayicisi soyutlamasi. Servis yalnizca bu arayuzu bilir; iyzico (Adim 8b-2) ve
 * yerel/test icin sahte saglayici bunu uygular. Kart verisi bu sisteme hic gelmez: saglayicinin
 * barindirdigi odeme sayfasi kullanilir.
 */
import type { IsoDate, Kurus } from '../core/types.js';
import type { PaymentProviderName, SubMerchantType } from './types.js';

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
  token: string;
  paymentPageUrl: string;
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

export type WebhookInput = { headers: Record<string, string | undefined>; body: unknown };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Sandbox/test ortami: TCKN yerine saglayicinin test numarasi kullanilir. */
  readonly sandbox: boolean;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  retrieveCheckout(query: { token: string; conversationId: string }): Promise<CheckoutOutcome>;
  registerSubMerchant(request: SubMerchantRequest): Promise<{ subMerchantKey: string }>;
  /**
   * Webhook imzasini dogrular; gecerliyse niyeti bulmak icin `conversationId` doner, degilse
   * null. Govdedeki odeme durumuna guvenilmez: servis sonucu yine saglayicidan sorgular.
   */
  verifyWebhook?(input: WebhookInput): Promise<{ conversationId: string } | null>;
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
