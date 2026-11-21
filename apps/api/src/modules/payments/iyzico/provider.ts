/**
 * iyzico Checkout Form (hosted odeme sayfasi) + Pazaryeri saglayicisi.
 *
 *   Baslatma : POST /payment/iyzipos/checkoutform/initialize/auth/ecom
 *   Sorgu    : POST /payment/iyzipos/checkoutform/auth/ecom/detail
 *   Alt uye  : POST /onboarding/submerchant
 *   Iade     : POST /payment/refund (kalem bazli, `paymentTransactionId`; Refund V2 kullanilmaz:
 *              iyzico cok kalemli sepetlerde onermez, tek akis icin her sepette kalem bazli)
 *   Rapor    : GET  /v2/reporting/payment/details?paymentId= (kalem bazinda yapilmis iadeler)
 *   Onay     : POST /payment/iyzipos/item/approve (pazaryeri dagitim onayi, kalem bazli
 *              `paymentTransactionId`; onaylanmayan tutar iyzico havuzunda bekler)
 *   Webhook  : X-IYZ-SIGNATURE-V3 = hex(HMAC-SHA256(secretKey,
 *                secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status))
 *              (HPP/Checkout Form bicimi; imza ozelligi iyzico'dan hesap bazinda acilir)
 *
 * Tek cekim (enabledInstallments [1]): sakinin odedigi tutar = borc. Sepet kalemleri sanal
 * (VIRTUAL) oldugu icin teslimat adresi gonderilmez.
 */
import { type IsoDate, type Kurus, toKurus } from '../../core/types.js';
import type { ItemTransaction } from '../types.js';
import {
  type CheckoutOutcome,
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  PaymentProviderError,
  type RefundRequest,
  tokenFromBody,
  type RefundResult,
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
  refund: '/payment/refund',
  paymentDetails: '/v2/reporting/payment/details',
  approve: '/payment/iyzipos/item/approve',
} as const;

/** Raporlamada basarili iade/iptal kaydi (`refundStatus`). Digerleri belirsiz sayilir. */
const REFUND_STATUS_SUCCESS = 1;

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
  /** Odeme geneli komisyon (kalem alanlari yoksa kullanilir). */
  iyziCommissionRateAmount?: number | string;
  iyziCommissionFee?: number | string;
  itemTransactions?: {
    itemId?: string;
    paymentTransactionId?: string | number;
    paidPrice?: number | string;
    iyziCommissionRateAmount?: number | string;
    iyziCommissionFee?: number | string;
  }[];
};

/**
 * iyzico komisyon tutarlari kurusun altinda ondalik tasiyabilir (ornek 0.028875): kurusa
 * yukari yuvarlanir (mutabakatta platform maliyeti eksik gosterilmesin). Cozumlenemezse yok.
 */
export function commissionToKurus(value: unknown): Kurus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const s = typeof value === 'number' ? value.toFixed(8) : String(value).trim();
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const base = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  const rest = frac.slice(2).replace(/0+$/, '');
  return toKurus(base + (rest.length > 0 ? 1 : 0));
}

/** Kalem veya odeme geneli komisyon: oran tutari + sabit ucret. */
function feeOf(src: { iyziCommissionRateAmount?: number | string; iyziCommissionFee?: number | string }): Kurus | undefined {
  const rate = commissionToKurus(src.iyziCommissionRateAmount);
  const fixed = commissionToKurus(src.iyziCommissionFee);
  if (rate === undefined && fixed === undefined) return undefined;
  return toKurus((rate ?? 0) + (fixed ?? 0));
}

type RefundResponse = IyzicoEnvelope & {
  paymentId?: string;
  paymentTransactionId?: string | number;
  price?: number | string;
  currency?: string;
  refundHostReference?: string;
  hostReference?: string;
  retryable?: boolean;
};

type ReportingRefund = { refundPrice?: number | string; refundStatus?: number; refundConversationId?: string };
type DetailsResponse = IyzicoEnvelope & {
  payments?: {
    paymentId?: string | number;
    paymentConversationId?: string;
    paymentRefundStatus?: string;
    cancels?: ReportingRefund[];
    itemTransactions?: { paymentTransactionId?: string | number; paidPrice?: number | string; refunds?: ReportingRefund[] }[];
  }[];
};

/** Basarili sonuctaki kalem islemleri; eksik/cozumlenemeyen kalem varsa hic biri donmez (iade panelden). */
function parseItemTransactions(raw: RetrieveResponse['itemTransactions']): ItemTransaction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ItemTransaction[] = [];
  for (const t of raw) {
    if (!t || typeof t.itemId !== 'string' || (t.paymentTransactionId === undefined || t.paymentTransactionId === null)) return undefined;
    let paidAmount: Kurus;
    try {
      paidAmount = priceToKurus(t.paidPrice);
    } catch {
      return undefined;
    }
    const providerFee = feeOf(t);
    out.push({
      itemId: t.itemId,
      paymentTransactionId: String(t.paymentTransactionId),
      paidAmount,
      ...(providerFee !== undefined ? { providerFee } : {}),
    });
  }
  return out;
}

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
    // Checkout Form: iyzico sayfasina yonlendirme; pazaryeri payi kalem onayiyla serbest kalir.
    capabilities: { checkout: 'redirect', settlement: 'item_approval', requiresBuyerGsm: true },

    // Tarayici callbackUrl'e `token` ile POST eder (form). Sonuc yine token ile sorgulanir.
    parseCallback: tokenFromBody,

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

      const itemTransactions = parseItemTransactions(res.itemTransactions);
      // Gercek komisyon: kalem bazli varsa toplami, yoksa odeme geneli (mutabakat).
      const itemFees = itemTransactions?.map((t) => t.providerFee);
      const providerFee =
        itemFees && itemFees.length > 0 && itemFees.every((f) => f !== undefined)
          ? toKurus(itemFees.reduce<number>((s, f) => s + (f as number), 0))
          : feeOf(res);
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
        ...(itemTransactions ? { itemTransactions } : {}),
        ...(providerFee !== undefined ? { providerFee } : {}),
      };
    },

    /** Pazaryeri kalem onayi (`item/approve`); `providerItemId` = `paymentTransactionId`. */
    async releaseItem({ providerItemId: paymentTransactionId, conversationId }) {
      const res = await client.post<IyzicoEnvelope & { paymentTransactionId?: string | number }>(IYZICO_PATHS.approve, {
        locale: 'tr',
        conversationId,
        paymentTransactionId,
      });
      if (res.status !== 'success') {
        throw new PaymentProviderError(
          res.errorCode ? `iyzico_${res.errorCode}` : 'approve_failed',
          res.errorMessage ?? 'iyzico kalem onayini reddetti',
          true,
        );
      }
      if (res.paymentTransactionId !== undefined && String(res.paymentTransactionId) !== paymentTransactionId) {
        throw new PaymentProviderError('invalid_response', 'iyzico onay yaniti kalemle eslesmiyor', true);
      }
    },

    /**
     * Kalem bazli iade. `status: failure` kesin redtir (`retryable=false`; iyzico `retryable`
     * dediyse tekrar denenebilir). Yanit kalem/tutar/conversation ile eslesmiyorsa sonuc belirsiz
     * sayilir (`retryable=true`): servis tekrar gondermeden once raporlamadan iade tutarini sorar.
     */
    async refundItem(req: RefundRequest): Promise<RefundResult> {
      const res = await client.post<RefundResponse>(IYZICO_PATHS.refund, {
        locale: 'tr',
        conversationId: req.conversationId,
        paymentTransactionId: req.paymentTransactionId,
        price: kurusToPrice(req.amount),
        currency: 'TRY',
        ip: req.ip,
      });
      if (res.status !== 'success') {
        throw new PaymentProviderError(
          res.errorCode ? `iyzico_${res.errorCode}` : 'refund_failed',
          res.errorMessage ?? 'iyzico iadeyi reddetti',
          res.retryable === true,
        );
      }
      let refunded: Kurus | undefined;
      try {
        refunded = priceToKurus(res.price);
      } catch {
        refunded = undefined;
      }
      if (
        String(res.paymentTransactionId ?? '') !== req.paymentTransactionId ||
        refunded !== req.amount ||
        (res.conversationId !== undefined && res.conversationId !== req.conversationId)
      ) {
        throw new PaymentProviderError('invalid_response', 'iyzico iade yaniti istekle eslesmiyor', true);
      }
      return { providerRefundId: res.refundHostReference ?? res.hostReference };
    },

    /**
     * Raporlama servisinden kalem bazinda basarili iade toplamlari. Tum odeme iptal edildiyse
     * (`cancels`) veya tamamen iade edildiyse her kalem tam tutarinda sayilir. Durumu bilinmeyen
     * bir iade kaydi varsa hata (belirsiz): servis ne tekrar gonderir ne de tamamlandi sayar.
     */
    async refundedAmounts({ providerPaymentId, conversationId }): Promise<Map<string, Kurus>> {
      const res = await client.get<DetailsResponse>(IYZICO_PATHS.paymentDetails, {
        paymentId: providerPaymentId,
        locale: 'tr',
        conversationId: `refund-check:${conversationId}`,
      });
      if (res.status !== 'success') {
        throw new PaymentProviderError(res.errorCode ? `iyzico_${res.errorCode}` : 'report_failed', res.errorMessage ?? 'iyzico raporu alinamadi', true);
      }
      const payment = (res.payments ?? []).find((p) => String(p.paymentId ?? '') === providerPaymentId);
      if (!payment) throw new PaymentProviderError('not_found', 'Odeme raporda bulunamadi', true);
      const unknown = (r: ReportingRefund) => r.refundStatus !== REFUND_STATUS_SUCCESS;
      const succeeded = (list: ReportingRefund[] | undefined) => (list ?? []).filter((r) => !unknown(r));
      const items = payment.itemTransactions ?? [];
      if ([...(payment.cancels ?? []), ...items.flatMap((t) => t.refunds ?? [])].some(unknown)) {
        throw new PaymentProviderError('refund_status_unknown', 'iyzico raporunda sonucu belirsiz iade kaydi var', true);
      }
      const fully = payment.paymentRefundStatus === 'TOTALLY_REFUNDED' || succeeded(payment.cancels).length > 0;
      const out = new Map<string, Kurus>();
      for (const t of items) {
        if (t.paymentTransactionId === undefined || t.paymentTransactionId === null) continue;
        const total = fully
          ? priceToKurus(t.paidPrice)
          : succeeded(t.refunds).reduce((sum, r) => sum + priceToKurus(r.refundPrice), 0);
        out.set(String(t.paymentTransactionId), toKurus(total));
      }
      return out;
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
