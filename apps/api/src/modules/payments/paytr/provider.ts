/**
 * PayTR iFrame API + Pazaryeri (Platform Transfer) saglayicisi (Online Odeme v2 · P3).
 *
 *   Token    : POST /odeme/api/get-token   (iFrame; hash_str = merchant_id + user_ip + merchant_oid +
 *              email + payment_amount + user_basket + no_installment + max_installment + currency + test_mode)
 *   Sayfa    : https://www.paytr.com/odeme/guvenli/<token> (sakin uygulamasinda iframe icinde)
 *   Bildirim : PayTR panelindeki "Bildirim URL" -> POST /api/payments/paytr/webhook (form);
 *              hash = base64(HMAC-SHA256(merchant_key, merchant_oid + merchant_salt + status + total_amount));
 *              yanit YALNIZCA duz metin `OK` (aksi halde PayTR dakikada bir tekrar dener)
 *   Sorgu    : POST /odeme/durum-sorgu (hash_str = merchant_id + merchant_oid); YALNIZCA basarili odemeyi
 *              raporlar (`err_no 004`: basarili odeme yok -> sonuc henuz belli degil)
 *   Iade     : POST /odeme/iade (siparis bazli; hash_str = merchant_id + merchant_oid + return_amount)
 *   Aktarim  : Platform Transfer (P4) -> `releaseItem` henuz yok; kalemler `pending` kalir.
 *
 * Kararlar:
 *  - Tek cekim (`no_installment=1`): sakinin odedigi tutar = borc (vade farki yok).
 *  - `merchant_oid` = niyet kimliginin alfanumerik hali (14 hane zaman + 32 hex = 46 karakter).
 *    Bildirim yalnizca bunu tasir; niyet `PAYREF#paytr#<oid>` esleme kaydindan bulunur.
 *  - `merchant_ok_url` / `merchant_fail_url` API'nin callback'ine gider (GET veya POST olabilir);
 *    API sonucu sorgulayip web sonuc sayfasina yonlendirir. Bu adreslere veri gelmez; sonuc yalnizca
 *    bildirim ve durum sorgusuyla kesinlesir.
 *  - Bildirimdeki basarisizlik niyeti hemen FAILED yapmaz (servis `providerNotice` olarak not eder);
 *    durum sorgusu basarisizligi raporlamadigi icin gec gelen bir basari kaybolmasin diye.
 */
import { type IsoDate, type Kurus, toKurus } from '../../core/types.js';
import {
  type CallbackInput,
  type CheckoutOutcome,
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  PaymentProviderError,
  type RefundRequest,
  type RefundResult,
  type SubMerchantRequest,
  type WebhookEvent,
  type WebhookInput,
} from '../provider.js';
import {
  PAYTR_PATHS,
  type PaytrClient,
  type PaytrEnvelope,
  clip,
  kurusToTl,
  notificationHash,
  paytrIframeUrl,
  paytrToken,
  safeEqualBase64,
  tlToKurus,
} from './client.js';

/** Durum sorgusunda "basarili odeme bulunamadi" (henuz odenmedi / basarisiz / suresi doldu). */
const NO_SUCCESSFUL_PAYMENT = '004';

type StatusResponse = PaytrEnvelope & {
  payment_amount?: string | number;
  payment_total?: string | number;
  payment_date?: string;
  currency?: string;
  kesinti_tutari?: string | number;
  net_tutar?: string | number;
  test_mode?: string | number;
  returns?: unknown;
};

type RefundResponse = PaytrEnvelope & { merchant_oid?: string; return_amount?: string | number; reference_no?: string; is_test?: string | number };

/** PayTR `merchant_oid` / `reference_no`: yalnizca harf ve rakam, en fazla 64. */
export const alnum = (value: string, max = 64) => value.replace(/[^A-Za-z0-9]/g, '').slice(0, max);

/** Niyetin PayTR siparis kimligi. */
export const paytrMerchantOid = (intentId: string) => alnum(intentId);

/** Sorgu yanitindaki iade listesi -> toplam iade (kurus). Bilinmeyen kayit 0 sayilmaz: hata. */
function refundedTotal(returns: unknown): Kurus {
  if (returns === undefined || returns === null || returns === '' || (Array.isArray(returns) && returns.length === 0)) return toKurus(0);
  if (!Array.isArray(returns)) throw new PaymentProviderError('invalid_response', 'PayTR iade listesi okunamadi', true);
  let sum = 0;
  for (const r of returns) {
    const o = (r ?? {}) as Record<string, unknown>;
    const k = tlToKurus(o.return_amount ?? o.amount ?? o.Amount);
    if (k === undefined) throw new PaymentProviderError('invalid_response', 'PayTR iade tutari okunamadi', true);
    sum += k;
  }
  return toKurus(sum);
}

const paidDate = (v: unknown): IsoDate | undefined => {
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null;
  return m ? (m[1] as IsoDate) : undefined;
};

const currencyOf = (v: unknown) => {
  const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return c === 'TL' || c === 'TRY' ? 'TRY' : c || undefined;
};

/** Sakin donusu (ok/fail) callback adresine `result` olarak eklenir; API web sonuc sayfasina tasir. */
function returnUrl(callbackUrl: string, result: 'ok' | 'fail'): string {
  const u = new URL(callbackUrl);
  u.searchParams.set('result', result);
  const s = u.toString();
  if (s.length > 400) throw new Error('PayTR donus adresi 400 karakteri asamaz');
  return s;
}

export function createPaytrProvider(options: { client: PaytrClient; testMode: boolean }): PaymentProvider {
  const { client, testMode } = options;
  const testFlag = testMode ? '1' : '0';

  return {
    name: 'paytr',
    sandbox: testMode,
    // iFrame (sakin uygulamasinda gomulu); pazaryeri payi Platform Transfer ile (P4).
    capabilities: { checkout: 'iframe', settlement: 'payout_transfer', requiresBuyerGsm: true },

    checkoutReference: ({ intentId }) => paytrMerchantOid(intentId),

    // PayTR donus adreslerine veri gondermez: token yok, niyet `ref` ile bulunur ve sonuc sorgulanir.
    parseCallback: (_input: CallbackInput) => ({}),

    async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
      const merchantOid = req.reference;
      if (!merchantOid || merchantOid !== alnum(merchantOid) || merchantOid.length === 0) {
        throw new Error('PayTR icin alfanumerik merchant_oid (reference) zorunlu');
      }
      const itemsTotal = req.items.reduce((s, i) => s + i.amount, 0);
      if (itemsTotal !== req.amount) throw new Error('Sepet toplami odeme tutarina esit olmali');
      const c = await client.credentials();
      const b = req.buyer;
      const userBasket = Buffer.from(
        JSON.stringify(req.items.map((i) => [clip(i.name, 100), kurusToTl(i.amount), 1])),
        'utf8',
      ).toString('base64');
      const paymentAmount = String(req.amount);
      const noInstallment = '1';
      const maxInstallment = '0';
      const currency = 'TL';
      const hashStr = c.merchantId + b.ip + merchantOid + b.email + paymentAmount + userBasket + noInstallment + maxInstallment + currency + testFlag;
      const res = await client.post<PaytrEnvelope & { token?: string }>(PAYTR_PATHS.token, {
        merchant_id: c.merchantId,
        user_ip: clip(b.ip, 39),
        merchant_oid: merchantOid,
        email: clip(b.email, 100),
        payment_amount: paymentAmount,
        paytr_token: paytrToken(c, hashStr),
        user_basket: userBasket,
        debug_on: '0',
        no_installment: noInstallment,
        max_installment: maxInstallment,
        user_name: clip(`${b.name} ${b.surname}`, 60),
        user_address: clip(`${b.address}, ${b.city}`, 400),
        user_phone: clip(b.gsmNumber ?? '', 20),
        merchant_ok_url: returnUrl(req.callbackUrl, 'ok'),
        merchant_fail_url: returnUrl(req.callbackUrl, 'fail'),
        timeout_limit: String(req.expiresInMinutes),
        currency,
        test_mode: testFlag,
        lang: 'tr',
      });
      if (res.status !== 'success' || typeof res.token !== 'string' || !res.token) {
        // Istek reddi (eksik/gecersiz alan, yanlis anahtar): tekrar denemek ise yaramaz.
        throw new PaymentProviderError('paytr_token_failed', clip(String(res.reason ?? 'PayTR odeme oturumunu acmadi'), 300));
      }
      return { token: res.token, paymentPageUrl: paytrIframeUrl(res.token, client.baseUrl) };
    },

    async retrieveCheckout({ token, conversationId, intentId, reference }): Promise<CheckoutOutcome> {
      if (!reference) return { status: 'failure', token, errorCode: 'no_reference', errorMessage: 'PayTR siparis kimligi yok' };
      const c = await client.credentials();
      const res = await client.post<StatusResponse>(PAYTR_PATHS.status, {
        merchant_id: c.merchantId,
        merchant_oid: reference,
        paytr_token: paytrToken(c, c.merchantId + reference),
      });
      if (res.status !== 'success') {
        // Basarili odeme yok: kullanici henuz odemedi ya da basarisiz oldu (bildirim belirler).
        if (String(res.err_no ?? '') === NO_SUCCESSFUL_PAYMENT) return { status: 'pending', token };
        throw new PaymentProviderError(`paytr_${String(res.err_no ?? 'status')}`, clip(String(res.err_msg ?? 'PayTR durum sorgusu basarisiz'), 300), true);
      }
      const providerFee = tlToKurus(res.kesinti_tutari);
      return {
        status: 'success',
        token,
        // Sorgu siparis kimligine baglidir: kimlikler niyetten gelir, tutar ve para birimi PayTR'den.
        providerPaymentId: reference,
        basketId: intentId,
        conversationId,
        paidAmount: tlToKurus(res.payment_amount),
        currency: currencyOf(res.currency),
        fraudApproved: true,
        paidAt: paidDate(res.payment_date),
        ...(providerFee !== undefined ? { providerFee } : {}),
      };
    },

    /**
     * PayTR'de alt uye isyeri kaydi API'si yoktur: aktarim Platform Transfer talimatinda IBAN ve
     * alici adiyla yapilir (P4). Burada yalnizca yerel anahtar uretilir; IBAN'in KMS ile sifreli
     * saklanmasi P4'te eklenecek.
     */
    async registerSubMerchant(req: SubMerchantRequest) {
      return { subMerchantKey: `paytr-${alnum(req.externalId)}` };
    },

    /**
     * Siparis bazli kismi/tam iade. `reference_no` = iade kimliginin alfanumerik hali (durum
     * sorgusunda geri doner). `failed`/`error` kesin red; ag hatasi sonucu belirsiz (`retryable`).
     */
    async refundItem(req: RefundRequest): Promise<RefundResult> {
      const c = await client.credentials();
      const returnAmount = kurusToTl(req.amount);
      const referenceNo = alnum(req.conversationId);
      const res = await client.post<RefundResponse>(PAYTR_PATHS.refund, {
        merchant_id: c.merchantId,
        merchant_oid: req.providerPaymentId,
        return_amount: returnAmount,
        paytr_token: paytrToken(c, c.merchantId + req.providerPaymentId + returnAmount),
        reference_no: referenceNo,
      });
      if (res.status !== 'success') {
        const code = res.status === 'failed' ? 'paytr_refund_failed' : `paytr_${String(res.err_no ?? 'refund_error')}`;
        throw new PaymentProviderError(code, clip(String(res.err_msg ?? 'PayTR iadeyi reddetti'), 300));
      }
      if (res.merchant_oid !== undefined && res.merchant_oid !== req.providerPaymentId) {
        throw new PaymentProviderError('invalid_response', 'PayTR iade yaniti siparisle eslesmiyor', true);
      }
      if (res.return_amount !== undefined && tlToKurus(res.return_amount) !== req.amount) {
        throw new PaymentProviderError('invalid_response', 'PayTR iade tutari istekle eslesmiyor', true);
      }
      return { providerRefundId: res.reference_no ?? referenceNo };
    },

    /**
     * PayTR iadeleri siparis bazlidir: toplam iade, kalemlere iade sirasiyla (servis kalemleri
     * sirayla iade eder) dagitilir.
     */
    async refundedAmounts({ providerPaymentId, items }): Promise<Map<string, Kurus>> {
      const c = await client.credentials();
      const res = await client.post<StatusResponse>(PAYTR_PATHS.status, {
        merchant_id: c.merchantId,
        merchant_oid: providerPaymentId,
        paytr_token: paytrToken(c, c.merchantId + providerPaymentId),
      });
      let total: number;
      if (res.status === 'success') total = refundedTotal(res.returns);
      else if (String(res.err_no ?? '') === NO_SUCCESSFUL_PAYMENT) total = 0;
      else throw new PaymentProviderError(`paytr_${String(res.err_no ?? 'status')}`, clip(String(res.err_msg ?? 'PayTR durum sorgusu basarisiz'), 300), true);
      const out = new Map<string, Kurus>();
      for (const item of items) {
        const share = Math.min(item.amount, total);
        out.set(item.paymentTransactionId, toKurus(share));
        total -= share;
      }
      return out;
    },

    // P4: Platform Transfer talimati (`/odeme/platform/transfer`, KMS ile cozulen IBAN) burada
    // `releaseItem` olarak eklenecek. Tanimli olmadigi surece kalemler `pending` bekler.

    async verifyWebhook({ body }: WebhookInput): Promise<WebhookEvent | null> {
      if (typeof body !== 'object' || body === null) return null;
      const b = body as Record<string, unknown>;
      const field = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : typeof b[k] === 'number' ? String(b[k]) : '');
      const merchantOid = field('merchant_oid');
      const status = field('status');
      const totalAmount = field('total_amount');
      const hash = field('hash');
      if (!merchantOid || merchantOid !== alnum(merchantOid) || !status || !hash) return null;
      const c = await client.credentials();
      if (!safeEqualBase64(notificationHash(c, { merchantOid, status, totalAmount }), hash)) return null;
      return {
        reference: merchantOid,
        notice:
          status === 'success'
            ? { status: 'success' }
            : {
                status: 'failure',
                ...(field('failed_reason_code') ? { code: clip(field('failed_reason_code'), 20) } : {}),
                ...(field('failed_reason_msg') ? { message: clip(field('failed_reason_msg'), 300) } : {}),
              },
      };
    },

    webhookReply: () => ({ contentType: 'text/plain', body: 'OK' }),
  };
}
