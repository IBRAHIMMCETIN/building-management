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
import type { IsoDate } from '../core/types.js';
import {
  type CheckoutOutcome,
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  PaymentProviderError,
} from './provider.js';

type FakeSession = {
  request: CheckoutRequest;
  outcome: 'pending' | 'success' | 'failure';
  providerPaymentId?: string;
  paidAt?: IsoDate;
  /** Testlerde dogrulama hatasi uretmek icin. */
  override?: Partial<Pick<CheckoutOutcome, 'paidAmount' | 'basketId' | 'conversationId' | 'fraudApproved' | 'currency'>>;
};

export type FakePaymentProvider = PaymentProvider & {
  sessions: Map<string, FakeSession>;
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
};

export function createFakePaymentProvider(options: { apiBaseUrl: string }): FakePaymentProvider {
  const sessions = new Map<string, FakeSession>();
  let payments = 0;
  let checkoutError: Error | undefined;
  let retrieveError: Error | undefined;
  const base = options.apiBaseUrl.replace(/\/+$/, '');

  return {
    name: 'fake',
    sandbox: true,
    sessions,

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
        ...s.override,
      };
    },

    complete(token, outcome, opts = {}) {
      const s = sessions.get(token);
      if (!s) throw new PaymentProviderError('not_found', 'Odeme oturumu bulunamadi');
      if (s.outcome === 'pending') {
        s.outcome = outcome;
        if (outcome === 'success') s.providerPaymentId = `fakepay-${++payments}`;
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
  };
}
