import { describe, expect, it } from 'vitest';
import { toKurus } from '../src/modules/core/types.js';
import { loadPaymentsConfig } from '../src/modules/payments/config.js';
import {
  type PaytrCredentials,
  createPaytrClient,
  kurusToTl,
  notificationHash,
  paytrHash,
  paytrIframeUrl,
  paytrToken,
  tlToKurus,
} from '../src/modules/payments/paytr/client.js';
import { alnum, createPaytrProvider, paytrMerchantOid } from '../src/modules/payments/paytr/provider.js';
import { type CheckoutRequest, PaymentProviderError } from '../src/modules/payments/provider.js';
import { envPaytrCredentials, parsePaytrCredentials, secretsManagerPaytrCredentials } from '../src/modules/payments/secrets.js';

const CREDS: PaytrCredentials = { merchantId: '100001', merchantKey: 'KEY123', merchantSalt: 'SALT456' };

type Call = { path: string; form: Record<string, string> };

function fakeFetch(respond: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(input)).pathname, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) };
    calls.push(call);
    const out = await respond(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

function provider(respond: (call: Call) => unknown, testMode = true) {
  const f = fakeFetch(respond);
  return { p: createPaytrProvider({ client: createPaytrClient({ credentials: async () => CREDS, fetch: f.fn }), testMode }), calls: f.calls };
}

const checkout: CheckoutRequest = {
  intentId: '20261106100000-0f8fad5b-d9cb-469f-a165-70867728950e',
  conversationId: 'apt-1:20261106100000-0f8fad5b-d9cb-469f-a165-70867728950e',
  reference: '202611061000000f8fad5bd9cb469fa16570867728950e',
  expiresInMinutes: 30,
  amount: toKurus(150_050),
  currency: 'TRY',
  callbackUrl: 'https://api.x/api/payments/paytr/callback?ref=apt-1%3A20261106100000-0f8fad5b',
  buyer: {
    id: 'u1',
    identityNumber: '11111111111',
    ip: '203.0.113.7',
    name: 'Ayşe',
    surname: 'Yılmaz',
    email: 'ayse@example.com',
    gsmNumber: '+905321234567',
    address: 'Lale Sk. 1, Kadıköy',
    city: 'Istanbul',
  },
  items: [
    { id: 'i-occupant', name: 'Aidat · Sakin', amount: toKurus(100_050), subMerchantKey: 'paytr-apt1', subMerchantPrice: toKurus(97_000) },
    { id: 'i-owner', name: 'Aidat · Malik', amount: toKurus(50_000), subMerchantKey: 'paytr-apt1', subMerchantPrice: toKurus(48_000) },
  ],
};

describe('PayTR imza ve tutar yardimcilari', () => {
  it('HMAC-SHA256 base64 imzalari (bagimsiz hesaplanmis vektorler)', () => {
    // python: base64(hmac.new(b'KEY123', msg, sha256).digest())
    expect(notificationHash(CREDS, { merchantOid: 'ABC123', status: 'success', totalAmount: '100000' })).toBe('qFu5miXqu/N6cHNDaYyZh4sS1D5f+XChF/W0gdymZNs=');
    expect(paytrToken(CREDS, '100001ABC123')).toBe('z5dfinqeBerGurqnFRwVdrjxMC0QTIM8ydMDik8o6b4=');
    expect(paytrToken(CREDS, '100001ABC12310.25')).toBe('shFCKUEoo6FQ+7CT9cT3mhgRDio89W51Ev+gv+ZcVkQ=');
    expect(paytrHash('KEY123', 'x')).toHaveLength(44);
  });

  it('tutar: kurus <-> TL; virgullu ve noktali yanitlar, belirsiz deger tahmin edilmez', () => {
    expect(kurusToTl(102_550)).toBe('1025.50');
    expect(kurusToTl(5)).toBe('0.05');
    expect(() => kurusToTl(-1)).toThrow();
    expect([tlToKurus('10.25'), tlToKurus('10,8'), tlToKurus('1.234,56'), tlToKurus('1000'), tlToKurus(18), tlToKurus(' 7.50 ')]).toEqual([1025, 1080, 123_456, 100_000, 1800, 750]);
    expect([tlToKurus('10.255'), tlToKurus('abc'), tlToKurus(''), tlToKurus(undefined), tlToKurus(-1), tlToKurus('1,2,3')]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('siparis kimligi alfanumerik ve en fazla 64; iframe adresi', () => {
    expect(paytrMerchantOid(checkout.intentId)).toBe('202611061000000f8fad5bd9cb469fa16570867728950e');
    expect(paytrMerchantOid(checkout.intentId)).toHaveLength(46);
    expect(alnum('a-b_c:d'.repeat(30))).toHaveLength(64);
    expect(paytrIframeUrl('t/1')).toBe('https://www.paytr.com/odeme/guvenli/t%2F1');
  });
});

describe('PayTR saglayicisi', () => {
  it('iFrame token: alanlar, hash_str sirasi, sepet, donus adresleri; anahtarlar istekte gonderilmez', async () => {
    const { p, calls } = provider(() => ({ status: 'success', token: 'tok-1' }));
    expect(p.capabilities).toEqual({ checkout: 'iframe', settlement: 'payout_transfer', requiresBuyerGsm: true, releaseDelayHours: 24 });
    expect(p.checkoutReference!({ intentId: checkout.intentId, conversationId: checkout.conversationId })).toBe(checkout.reference);
    expect(await p.createCheckout(checkout)).toEqual({ token: 'tok-1', paymentPageUrl: 'https://www.paytr.com/odeme/guvenli/tok-1' });
    const f = calls[0]!.form;
    expect(calls[0]!.path).toBe('/odeme/api/get-token');
    const basket = Buffer.from('[["Aidat · Sakin","1000.50",1],["Aidat · Malik","500.00",1]]', 'utf8').toString('base64');
    expect(f).toEqual({
      merchant_id: '100001',
      user_ip: '203.0.113.7',
      merchant_oid: checkout.reference,
      email: 'ayse@example.com',
      payment_amount: '150050',
      paytr_token: paytrToken(CREDS, `100001203.0.113.7${checkout.reference}ayse@example.com150050${basket}10TL1`),
      user_basket: basket,
      debug_on: '0',
      no_installment: '1',
      max_installment: '0',
      user_name: 'Ayşe Yılmaz',
      user_address: 'Lale Sk. 1, Kadıköy, Istanbul',
      user_phone: '+905321234567',
      merchant_ok_url: `${checkout.callbackUrl}&result=ok`,
      merchant_fail_url: `${checkout.callbackUrl}&result=fail`,
      timeout_limit: '30',
      currency: 'TL',
      test_mode: '1',
      lang: 'tr',
    });
    expect(f).not.toHaveProperty('merchant_key');
    expect(f).not.toHaveProperty('merchant_salt');

    const live = provider(() => ({ status: 'success', token: 't' }), false);
    await live.p.createCheckout(checkout);
    expect(live.calls[0]!.form.test_mode).toBe('0');
    expect(live.p.sandbox).toBe(false);
  });

  it('token reddi kesin hata; ag hatasi tekrar denenebilir; reference ve sepet toplami zorunlu', async () => {
    await expect(provider(() => ({ status: 'failed', reason: 'paytr_token gecersiz' })).p.createCheckout(checkout)).rejects.toMatchObject({
      code: 'paytr_token_failed',
      message: 'paytr_token gecersiz',
      retryable: false,
    });
    await expect(provider(() => new Response('x', { status: 503 })).p.createCheckout(checkout)).rejects.toMatchObject({ code: 'http_503', retryable: true });
    await expect(provider(() => new Response('<html>', { status: 200 })).p.createCheckout(checkout)).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    const down = createPaytrProvider({
      client: createPaytrClient({ credentials: async () => CREDS, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }),
      testMode: true,
    });
    await expect(down.createCheckout(checkout)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    await expect(provider(() => ({})).p.createCheckout({ ...checkout, reference: undefined })).rejects.toThrow(/merchant_oid/);
    await expect(provider(() => ({})).p.createCheckout({ ...checkout, amount: toKurus(1) })).rejects.toThrow(/Sepet/);
  });

  it('durum sorgusu: basari (kimlikler niyetten, tutar/komisyon PayTR), 004 beklemede, diger hata tekrar denenir', async () => {
    const q = { token: 'tok-1', conversationId: checkout.conversationId, intentId: checkout.intentId, reference: checkout.reference };
    const { p, calls } = provider(() => ({
      status: 'success',
      payment_amount: '1500,5',
      payment_total: '1500,5',
      payment_date: '2026-11-06 13:05:12',
      currency: 'TL',
      kesinti_tutari: '39.87',
      returns: [],
    }));
    expect(await p.retrieveCheckout(q)).toEqual({
      status: 'success',
      token: 'tok-1',
      providerPaymentId: checkout.reference,
      basketId: checkout.intentId,
      conversationId: checkout.conversationId,
      paidAmount: 150_050,
      currency: 'TRY',
      fraudApproved: true,
      paidAt: '2026-11-06',
      providerFee: 3_987,
    });
    expect(calls[0]).toEqual({
      path: '/odeme/durum-sorgu',
      form: { merchant_id: '100001', merchant_oid: checkout.reference, paytr_token: paytrToken(CREDS, `100001${checkout.reference}`) },
    });
    expect(await provider(() => ({ status: 'error', err_no: '004', err_msg: 'yok' })).p.retrieveCheckout(q)).toEqual({ status: 'pending', token: 'tok-1' });
    await expect(provider(() => ({ status: 'error', err_no: '001', err_msg: 'token hatali' })).p.retrieveCheckout(q)).rejects.toMatchObject({ code: 'paytr_001', retryable: true });
    expect(await provider(() => ({ status: 'success', payment_amount: 'x', currency: 'USD' })).p.retrieveCheckout(q)).toMatchObject({ paidAmount: undefined, currency: 'USD' });
    expect(await provider(() => ({})).p.retrieveCheckout({ ...q, reference: undefined })).toMatchObject({ status: 'failure', errorCode: 'no_reference' });
  });

  it('iade: siparis bazli, nokta ayiricili tutar; red kesin, eslesmeyen yanit belirsiz', async () => {
    const req = { providerPaymentId: 'OID1', paymentTransactionId: 'OID1-occupant', amount: toKurus(100_050), conversationId: 'refund-PI-1', ip: '1.2.3.4' };
    const { p, calls } = provider(({ form }) => ({ status: 'success', is_test: 1, merchant_oid: form.merchant_oid, return_amount: form.return_amount, reference_no: form.reference_no }));
    expect(await p.refundItem(req)).toEqual({ providerRefundId: 'refundPI1' });
    expect(calls[0]).toEqual({
      path: '/odeme/iade',
      form: { merchant_id: '100001', merchant_oid: 'OID1', return_amount: '1000.50', paytr_token: paytrToken(CREDS, '100001OID11000.50'), reference_no: 'refundPI1' },
    });
    await expect(provider(() => ({ status: 'failed' })).p.refundItem(req)).rejects.toMatchObject({ code: 'paytr_refund_failed', retryable: false });
    await expect(provider(() => ({ status: 'error', err_no: '006', err_msg: 'iade tutari asiliyor' })).p.refundItem(req)).rejects.toMatchObject({ code: 'paytr_006', retryable: false });
    await expect(provider(() => ({ status: 'success', merchant_oid: 'BASKA' })).p.refundItem(req)).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(provider(() => ({ status: 'success', return_amount: '1.00' })).p.refundItem(req)).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(provider(() => new Response('', { status: 502 })).p.refundItem(req)).rejects.toMatchObject({ retryable: true });
  });

  it('iade edilen tutar: siparis toplami kalemlere iade sirasiyla dagitilir', async () => {
    const items = [
      { paymentTransactionId: 'a', amount: toKurus(1_000) },
      { paymentTransactionId: 'b', amount: toKurus(500) },
    ];
    const q = { providerPaymentId: 'OID1', conversationId: 'c', items };
    const report = (returns: unknown) => provider(() => ({ status: 'success', payment_amount: '15', returns })).p;
    expect(await report([]).refundedAmounts(q)).toEqual(new Map([['a', 0], ['b', 0]]));
    expect(await report([{ return_amount: '10.00' }]).refundedAmounts(q)).toEqual(new Map([['a', 1_000], ['b', 0]]));
    expect(await report([{ return_amount: '10' }, { Amount: '2,5' }]).refundedAmounts(q)).toEqual(new Map([['a', 1_000], ['b', 250]]));
    await expect(report([{ return_amount: '?' }]).refundedAmounts(q)).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(report('bozuk').refundedAmounts(q)).rejects.toBeInstanceOf(PaymentProviderError);
    expect(await provider(() => ({ status: 'error', err_no: '004' })).p.refundedAmounts(q)).toEqual(new Map([['a', 0], ['b', 0]]));
  });

  it('bildirim imzasi: gecerli -> siparis kimligi + durum; gecersiz/eksik -> null; yanit duz metin OK', async () => {
    const { p } = provider(() => ({}));
    const fields = { merchant_oid: 'ABC123', status: 'success', total_amount: '100000' };
    const hash = 'qFu5miXqu/N6cHNDaYyZh4sS1D5f+XChF/W0gdymZNs=';
    expect(await p.verifyWebhook!({ headers: {}, body: { ...fields, hash } })).toEqual({ reference: 'ABC123', notice: { status: 'success' } });
    expect(await p.verifyWebhook!({ headers: {}, body: { ...fields, total_amount: '1', hash } })).toBeNull();
    expect(await p.verifyWebhook!({ headers: {}, body: { ...fields, hash: hash.toLowerCase() } })).toBeNull();
    expect(await p.verifyWebhook!({ headers: {}, body: { ...fields } })).toBeNull();
    expect(await p.verifyWebhook!({ headers: {}, body: { ...fields, merchant_oid: 'ABC-123', hash } })).toBeNull();
    expect(await p.verifyWebhook!({ headers: {}, body: 'x' })).toBeNull();
    const failed = { merchant_oid: 'ABC123', status: 'failed', total_amount: '100000', failed_reason_code: '2', failed_reason_msg: 'Limit\nyetersiz' };
    expect(await p.verifyWebhook!({ headers: {}, body: { ...failed, hash: notificationHash(CREDS, { merchantOid: 'ABC123', status: 'failed', totalAmount: '100000' }) } })).toEqual({
      reference: 'ABC123',
      notice: { status: 'failure', code: '2', message: 'Limit yetersiz' },
    });
    expect(p.webhookReply!()).toEqual({ contentType: 'text/plain', body: 'OK' });
    expect(p.parseCallback({ query: { result: 'ok' }, body: {} })).toEqual({});
    expect(await p.registerSubMerchant({ subMerchantType: 'PRIVATE_COMPANY', externalId: 'apt-1', email: 'a@b.c', gsmNumber: '+90', address: 'x', iban: 'TR' })).toEqual({ subMerchantKey: 'paytr-apt1' });
    // P4: Platform Transfer.
    expect(typeof p.releaseItem).toBe('function');
  });
});

describe('PayTR yapilandirma ve anahtarlar', () => {
  const urls = { PAYMENTS_API_BASE_URL: 'https://api.x', WEB_APP_URL: 'https://web.x' };

  it('fabrika: test modu (varsayilan 1), anahtar kaynagi zorunlu; iyzico ile birlikte varsayilan secilir', () => {
    const local = loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_MERCHANT_ID: '100001', PAYTR_MERCHANT_KEY: 'k', PAYTR_MERCHANT_SALT: 's', ...urls });
    expect(local.providers.get('paytr')).toMatchObject({ name: 'paytr', sandbox: true, capabilities: { checkout: 'iframe' } });
    const live = loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_SECRET_ARN: 'arn:p', PAYTR_TEST_MODE: '0', ...urls });
    expect(live.providers.get('paytr')?.sandbox).toBe(false);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_SECRET_ARN: 'arn:p', PAYTR_TEST_MODE: 'evet', ...urls })).toThrow(/PAYTR_TEST_MODE/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_MERCHANT_ID: '1', ...urls })).toThrow(/PAYTR_MERCHANT_KEY/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_MERCHANT_ID: 'abc', PAYTR_MERCHANT_KEY: 'k', PAYTR_MERCHANT_SALT: 's', ...urls })).toThrow(/merchantId/);
    const both = loadPaymentsConfig({
      PAYMENTS_PROVIDERS: 'iyzico,paytr',
      DEFAULT_PAYMENT_PROVIDER: 'paytr',
      IYZICO_BASE_URL: 'https://sandbox-api.iyzipay.com',
      IYZICO_SECRET_ARN: 'arn:i',
      PAYTR_SECRET_ARN: 'arn:p',
      ...urls,
    });
    expect(both.providers.list().map((p) => p.name)).toEqual(['paytr', 'iyzico']);
  });

  it('Secrets Manager degeri: {merchantId, merchantKey, merchantSalt}; sayi kimlik kabul edilir', async () => {
    expect(parsePaytrCredentials('{"merchantId":100001,"merchantKey":"k","merchantSalt":"s"}')).toEqual({ merchantId: '100001', merchantKey: 'k', merchantSalt: 's' });
    expect(() => parsePaytrCredentials('x')).toThrow(PaymentProviderError);
    expect(() => parsePaytrCredentials('{"merchantId":"1"}')).toThrow(/eksik/);
    const send = async () => ({ SecretString: JSON.stringify(CREDS) });
    const read = secretsManagerPaytrCredentials('arn:p', { client: { send } as never });
    expect(await read()).toEqual(CREDS);
    expect(await envPaytrCredentials({ PAYTR_MERCHANT_ID: '1', PAYTR_MERCHANT_KEY: 'k', PAYTR_MERCHANT_SALT: 's' })()).toEqual({ merchantId: '1', merchantKey: 'k', merchantSalt: 's' });
  });
});
