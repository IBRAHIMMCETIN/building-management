/**
 * iyzico Checkout Form (hosted odeme sayfasi) + Pazaryeri saglayicisi.
 *
 *   Baslatma : POST /payment/iyzipos/checkoutform/initialize/auth/ecom
 *   Sorgu    : POST /payment/iyzipos/checkoutform/auth/ecom/detail
 *   Alt uye  : POST /onboarding/submerchant
 *   Webhook  : X-IYZ-SIGNATURE-V3 = hex(HMAC-SHA256(secretKey,
 *                secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status))
 *              (HPP/Checkout Form bicimi; imza ozelligi iyzico'dan hesap bazinda acilir)
 *
 * Tek cekim (enabledInstallments [1]): sakinin odedigi tutar = borc. Sepet kalemleri sanal
 * (VIRTUAL) oldugu icin teslimat adresi gonderilmez.
 */
import type { IsoDate } from '../../core/types.js';
import {
  type CheckoutOutcome,
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  PaymentProviderError,
  type SubMerchantRequest,
  type WebhookInput,
} from '../provider.js';
import {
  type IyzicoClient,
  type IyzicoEnvelope,
  hmacHex,
  kurusToPrice,
  priceToKurus,
  responseSignature,
  safeEqualHex,
  signaturePrice,
} from './client.js';

export const IYZICO_PATHS = {
  initialize: '/payment/iyzipos/checkoutform/initialize/auth/ecom',
  retrieve: '/payment/iyzipos/checkoutform/auth/ecom/detail',
  subMerchant: '/onboarding/submerchant',
} as const;

/** Odeme sonucu henuz kesinlesmemis (3DS adimlari). Bilinmeyen durumlar da beklemede sayilir. */
const PENDING_PAYMENT_STATUSES = new Set(['INIT_THREEDS', 'CALLBACK_THREEDS', 'INIT_BANK_TRANSFER', 'INIT_CREDIT', 'PENDING_CREDIT']);

type InitializeResponse = IyzicoEnvelope & { token?: string; paymentPageUrl?: string; signature?: string };

type RetrieveResponse = IyzicoEnvelope & {
  token?: string;
  paymentStatus?: string;
  paymentId?: string;
  fraudStatus?: number;
  basketId?: string;
  price?: number | string;
  paidPrice?: number | string;
  currency?: string;
  signature?: string;
};

function failureOf(res: IyzicoEnvelope, fallback: string): PaymentProviderError {
  return new PaymentProviderError(res.errorCode ? `iyzico_${res.errorCode}` : fallback, res.errorMessage ?? 'iyzico istegi reddetti');
}

const istanbulDay = (d: Date): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

export function createIyzicoProvider(options: { client: IyzicoClient; sandbox: boolean; now?: () => Date }): PaymentProvider {
  const { client, sandbox } = options;
  const now = options.now ?? (() => new Date());

  return {
    name: 'iyzico',
    sandbox,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
      const itemsTotal = req.items.reduce((s, i) => s + i.amount, 0);
      if (itemsTotal !== req.amount) throw new Error('Sepet toplami odeme tutarina esit olmali');
      const b = req.buyer;
      const body = {
        locale: 'tr',
        conversationId: req.conversationId,
        price: kurusToPrice(req.amount),
        paidPrice: kurusToPrice(req.amount),
        currency: req.currency,
        basketId: req.intentId,
        paymentGroup: 'PRODUCT',
        callbackUrl: req.callbackUrl,
        enabledInstallments: [1],
        buyer: {
          id: b.id,
          name: b.name,
          surname: b.surname,
          identityNumber: b.identityNumber,
          email: b.email,
          ...(b.gsmNumber ? { gsmNumber: b.gsmNumber } : {}),
          registrationAddress: b.address,
          city: b.city,
          country: 'Turkey',
          ip: b.ip,
        },
        billingAddress: { contactName: `${b.name} ${b.surname}`, city: b.city, country: 'Turkey', address: b.address },
        basketItems: req.items.map((i) => ({
          id: i.id,
          name: i.name,
          category1: 'Aidat',
          itemType: 'VIRTUAL',
          price: kurusToPrice(i.amount),
          subMerchantKey: i.subMerchantKey,
          subMerchantPrice: kurusToPrice(i.subMerchantPrice),
        })),
      };
      const res = await client.post<InitializeResponse>(IYZICO_PATHS.initialize, body);
      if (res.status !== 'success' || !res.token || !res.paymentPageUrl) throw failureOf(res, 'initialize_failed');
      if (res.signature) {
        const { secretKey } = await client.credentials();
        const expected = responseSignature(secretKey, [res.conversationId, res.token]);
        if (!safeEqualHex(expected, res.signature)) {
          throw new PaymentProviderError('invalid_signature', 'iyzico yanit imzasi dogrulanamadi');
        }
      }
      if (res.conversationId !== undefined && res.conversationId !== req.conversationId) {
        throw new PaymentProviderError('invalid_response', 'conversationId uyusmuyor');
      }
      return { token: res.token, paymentPageUrl: res.paymentPageUrl };
    },

    async retrieveCheckout({ token, conversationId }): Promise<CheckoutOutcome> {
      const res = await client.post<RetrieveResponse>(IYZICO_PATHS.retrieve, { locale: 'tr', conversationId, token });
      if (res.status !== 'success') {
        return {
          status: 'failure',
          token,
          errorCode: res.errorCode ? `iyzico_${res.errorCode}` : 'failed',
          errorMessage: res.errorMessage ?? 'Ödeme tamamlanamadı',
        };
      }
      const paymentStatus = res.paymentStatus ?? '';
      if (paymentStatus === 'FAILURE') {
        return {
          status: 'failure',
          token,
          errorCode: res.errorCode ? `iyzico_${res.errorCode}` : 'payment_failed',
          errorMessage: res.errorMessage ?? 'Ödeme tamamlanamadı',
        };
      }
      if (paymentStatus !== 'SUCCESS' || PENDING_PAYMENT_STATUSES.has(paymentStatus)) return { status: 'pending', token };

      // fraudStatus: 1 onayli, 0 incelemede (bildirim beklenir), -1 reddedildi.
      if (res.fraudStatus === -1) {
        return { status: 'failure', token, errorCode: 'fraud_rejected', errorMessage: 'Ödeme banka/iyzico tarafından reddedildi' };
      }
      if (res.fraudStatus === 0) return { status: 'pending', token };

      let signatureValid: boolean | undefined;
      if (res.signature) {
        const { secretKey } = await client.credentials();
        const expected = responseSignature(secretKey, [
          res.paymentStatus,
          res.paymentId,
          res.currency,
          res.basketId,
          res.conversationId,
          signaturePrice(res.paidPrice),
          signaturePrice(res.price),
          res.token ?? token,
        ]);
        signatureValid = safeEqualHex(expected, res.signature);
      }

      let paidAmount;
      try {
        paidAmount = priceToKurus(res.paidPrice);
      } catch {
        paidAmount = undefined; // dogrulamada "tutar uyusmuyor" olarak incelemeye alinir
      }
      return {
        status: 'success',
        token,
        providerPaymentId: res.paymentId,
        basketId: res.basketId,
        conversationId: res.conversationId,
        paidAmount,
        currency: res.currency,
        fraudApproved: res.fraudStatus === 1,
        paidAt: istanbulDay(now()),
        signatureValid,
      };
    },

    async registerSubMerchant(req: SubMerchantRequest) {
      const body: Record<string, unknown> = {
        locale: 'tr',
        conversationId: `submerchant:${req.externalId}`,
        subMerchantExternalId: req.externalId,
        subMerchantType: req.subMerchantType,
        email: req.email,
        gsmNumber: req.gsmNumber,
        address: req.address,
        iban: req.iban,
        currency: 'TRY',
        ...(req.name ? { name: req.name } : {}),
        ...(req.taxOffice ? { taxOffice: req.taxOffice } : {}),
        ...(req.taxNumber ? { taxNumber: req.taxNumber } : {}),
        ...(req.legalCompanyTitle ? { legalCompanyTitle: req.legalCompanyTitle } : {}),
        ...(req.contactName ? { contactName: req.contactName } : {}),
        ...(req.contactSurname ? { contactSurname: req.contactSurname } : {}),
        ...(req.identityNumber ? { identityNumber: req.identityNumber } : {}),
      };
      const res = await client.post<IyzicoEnvelope & { subMerchantKey?: string }>(IYZICO_PATHS.subMerchant, body);
      if (res.status !== 'success' || !res.subMerchantKey) throw failureOf(res, 'submerchant_failed');
      return { subMerchantKey: res.subMerchantKey };
    },

    async verifyWebhook({ headers, body }: WebhookInput) {
      const signature = headers['x-iyz-signature-v3'];
      if (!signature || typeof body !== 'object' || body === null) return null;
      const b = body as Record<string, unknown>;
      const field = (k: string) => (b[k] === undefined || b[k] === null ? '' : String(b[k]));
      const conversationId = field('paymentConversationId');
      if (!conversationId) return null;
      const { secretKey } = await client.credentials();
      const message =
        secretKey + field('iyziEventType') + field('iyziPaymentId') + field('token') + conversationId + field('status');
      return safeEqualHex(hmacHex(secretKey, message), signature) ? { conversationId } : null;
    },
  };
}
