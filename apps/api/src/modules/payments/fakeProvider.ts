/**
 * Yerel gelistirme ve testler icin sahte odeme saglayicisi (bellek ici).
 *
 * Akis iyzico Checkout Form'u taklit eder:
 *   createCheckout -> `paymentPageUrl` (= API'deki `/api/payments/fake/checkout?token=`)
 *   kullanici sayfada "basarili / basarisiz" secer -> `complete()` -> tarayici `callbackUrl`'e
 *   `token` ile POST eder -> servis sonucu `retrieveCheckout` ile SORGULAR.
 *
 * Production'da kullanilamaz (bkz. config.ts).
 */
import { type IsoDate, type Kurus, toKurus } from '../core/types.js';
import {
  type CheckoutOutcome,
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  PaymentProviderError,
  type RefundRequest,
  tokenFromBody,
  type SubMerchantRequest,
} from './provider.js';
import type { ItemTransaction } from './types.js';

type FakeSession = {
  request: CheckoutRequest;
  outcome: 'pending' | 'success' | 'failure';
  providerPaymentId?: string;
  paidAt?: IsoDate;
  itemTransactions?: ItemTransaction[];
  /** Testlerde dogrulama hatasi uretmek icin. */
  override?: Partial<Pick<CheckoutOutcome, 'paidAmount' | 'basketId' | 'conversationId' | 'fraudApproved' | 'currency'>>;
};

export type FakePaymentProvider = PaymentProvider & {
  sessions: Map<string, FakeSession>;
  subMerchants: Map<string, SubMerchantRequest>;
  /** Kullanicinin odeme sayfasindaki secimi. */
  complete(
    token: string,
    outcome: 'success' | 'failure',
    options?: { paidAt?: IsoDate; override?: FakeSession['override'] },
  ): FakeSession;
  /** Sonraki `createCheckout` cagrisini hatayla sonuclandirir (saglayici kesintisi). */
  failNextCheckout(error?: Error): void;
  /** Sonraki `retrieveCheckout` cagrisini hatayla sonuclandirir. */
  failNextRetrieve(error?: Error): void;
  /** Iade kayitlari (`paymentTransactionId` -> istekler). */
  refunds: Map<string, RefundRequest[]>;
  /** Onaylanan kalemler (`paymentTransactionId` -> onay sayisi). */
  approvals: Map<string, number>;
  /** Sonraki `releaseItem` (pazaryeri onayi) cagrisi hata verir. */
  failNextApprove(error?: Error): void;
  /** Kalem basina sahte saglayici komisyonu (kurus; varsayilan yok). */
  setProviderFeePerItem(fee: Kurus | undefined): void;
  /**
   * Sonraki `refundItem` cagrisi hata verir. `applied: true` -> iade saglayicida GERCEKLESIR
   * ama yanit kaybolur (zaman asimi senaryosu).
   */
  failNextRefund(error?: Error, options?: { applied?: boolean }): void;
};

export function createFakePaymentProvider(options: { apiBaseUrl: string }): FakePaymentProvider {
  const sessions = new Map<string, FakeSession>();
  const subMerchants = new Map<string, SubMerchantRequest>();
  let payments = 0;
  let checkoutError: Error | undefined;
  let retrieveError: Error | undefined;
  let refundError: { error: Error; applied: boolean } | undefined;
  const refunds = new Map<string, RefundRequest[]>();
  const approvals = new Map<string, number>();
  let approveError: Error | undefined;
  let feePerItem: Kurus | undefined;
  const base = options.apiBaseUrl.replace(/\/+$/, '');

  return {
    name: 'fake',
    sandbox: true,
    // iyzico gibi davranir: yonlendirme + kalem onayi.
    capabilities: { checkout: 'redirect', settlement: 'item_approval', requiresBuyerGsm: true },
    parseCallback: tokenFromBody,
    sessions,
    subMerchants,
    refunds,
    approvals,

    async releaseItem({ providerItemId: paymentTransactionId }) {
      if (approveError) {
        const e = approveError;
        approveError = undefined;
        throw e;
      }
      const known = [...sessions.values()].some((x) => x.itemTransactions?.some((t) => t.paymentTransactionId === paymentTransactionId));
      if (!known) throw new PaymentProviderError('not_found', 'Islem bulunamadi');
      approvals.set(paymentTransactionId, (approvals.get(paymentTransactionId) ?? 0) + 1);
    },
    failNextApprove(error = new PaymentProviderError('unavailable', 'Saglayiciya ulasilamadi', true)) {
      approveError = error;
    },
    setProviderFeePerItem(fee) {
      feePerItem = fee;
    },

    async registerSubMerchant(request) {
      const subMerchantKey = `fake-sm-${request.externalId}`;
      subMerchants.set(subMerchantKey, request);
      return { subMerchantKey };
    },

    async createCheckout(request): Promise<CheckoutSession> {
      if (checkoutError) {
        const e = checkoutError;
        checkoutError = undefined;
        throw e;
      }
      const token = `fake_${request.intentId}`;
      sessions.set(token, { request, outcome: 'pending' });
      return { token, paymentPageUrl: `${base}/api/payments/fake/checkout?token=${encodeURIComponent(token)}` };
    },

    async retrieveCheckout({ token, conversationId }): Promise<CheckoutOutcome> {
      if (retrieveError) {
        const e = retrieveError;
        retrieveError = undefined;
        throw e;
      }
      const s = sessions.get(token);
      if (!s || s.request.conversationId !== conversationId) {
        return { status: 'failure', token, errorCode: 'not_found', errorMessage: 'Odeme oturumu bulunamadi' };
      }
      if (s.outcome === 'pending') return { status: 'pending', token };
      if (s.outcome === 'failure') {
        return { status: 'failure', token, errorCode: 'card_declined', errorMessage: 'Kart reddedildi (sahte)' };
      }
      return {
        status: 'success',
        token,
        providerPaymentId: s.providerPaymentId,
        basketId: s.request.intentId,
        conversationId: s.request.conversationId,
        paidAmount: s.request.amount,
        currency: 'TRY',
        fraudApproved: true,
        paidAt: s.paidAt,
        itemTransactions: s.itemTransactions,
        ...(s.itemTransactions && s.itemTransactions.every((t) => t.providerFee !== undefined)
          ? { providerFee: toKurus(s.itemTransactions.reduce((sum, t) => sum + (t.providerFee ?? 0), 0)) }
          : {}),
        ...s.override,
      };
    },

    complete(token, outcome, opts = {}) {
      const s = sessions.get(token);
      if (!s) throw new PaymentProviderError('not_found', 'Odeme oturumu bulunamadi');
      if (s.outcome === 'pending') {
        s.outcome = outcome;
        if (outcome === 'success') {
          s.providerPaymentId = `fakepay-${++payments}`;
          s.itemTransactions = s.request.items.map((it, i) => ({
            itemId: it.id,
            paymentTransactionId: `${s.providerPaymentId}-t${i + 1}`,
            paidAmount: it.amount,
            ...(feePerItem !== undefined ? { providerFee: feePerItem } : {}),
          }));
        }
        s.paidAt = opts.paidAt;
        s.override = opts.override;
      }
      return s;
    },

    failNextCheckout(error = new PaymentProviderError('unavailable', 'Saglayiciya ulasilamadi', true)) {
      checkoutError = error;
    },
    failNextRetrieve(error = new PaymentProviderError('unavailable', 'Saglayiciya ulasilamadi', true)) {
      retrieveError = error;
    },

    async refundItem(request) {
      const known = [...sessions.values()].some((x) => x.itemTransactions?.some((t) => t.paymentTransactionId === request.paymentTransactionId));
      const apply = () => refunds.set(request.paymentTransactionId, [...(refunds.get(request.paymentTransactionId) ?? []), request]);
      if (refundError) {
        const { error, applied } = refundError;
        refundError = undefined;
        if (applied) apply();
        throw error;
      }
      if (!known) throw new PaymentProviderError('not_found', 'Islem bulunamadi');
      apply();
      return { providerRefundId: `fakerefund-${request.conversationId}` };
    },

    async refundedAmounts({ providerPaymentId }) {
      const out = new Map<string, Kurus>();
      const s = [...sessions.values()].find((x) => x.providerPaymentId === providerPaymentId);
      for (const t of s?.itemTransactions ?? []) {
        const total = (refunds.get(t.paymentTransactionId) ?? []).reduce((sum, r) => sum + r.amount, 0);
        out.set(t.paymentTransactionId, toKurus(total));
      }
      return out;
    },

    failNextRefund(error = new PaymentProviderError('unavailable', 'Saglayiciya ulasilamadi', true), opts = {}) {
      refundError = { error, applied: Boolean(opts.applied) };
    },
  };
}
