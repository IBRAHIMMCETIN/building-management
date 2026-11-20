import { createHmac } from 'node:crypto';
import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { toKurus } from '../src/modules/core/types.js';
import { loadPaymentsConfig } from '../src/modules/payments/config.js';
import {
  createIyzicoClient,
  hmacHex,
  iyzicoAuthorization,
  kurusToPrice,
  priceToKurus,
  responseSignature,
  signaturePrice,
} from '../src/modules/payments/iyzico/client.js';
import { IYZICO_PATHS, createIyzicoProvider } from '../src/modules/payments/iyzico/provider.js';
import { type CheckoutRequest, PaymentProviderError } from '../src/modules/payments/provider.js';
import { SECRET_CACHE_MS, secretsManagerCredentials } from '../src/modules/payments/secrets.js';
import { isValidTrIban, maskIban, normalizeGsm } from '../src/modules/payments/service.js';

const CREDS = { apiKey: 'sandbox-api-key', secretKey: 'sandbox-secret-key' };
const BASE = 'https://sandbox-api.iyzipay.com';

type Call = { url: string; path: string; headers: Record<string, string>; raw: string; body: Record<string, any> };

/** Sahte fetch: istegi kaydeder, `respond` ile yanit uretir. */
function fakeFetch(respond: (call: Call) => { status?: number; json?: unknown; throws?: Error; text?: string }) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = String(init?.body ?? '');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url, path: new URL(url).pathname, headers, raw, body: raw ? JSON.parse(raw) : {} };
    calls.push(call);
    const r = respond(call);
    if (r.throws) throw r.throws;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fn, calls };
}

function provider(respond: Parameters<typeof fakeFetch>[0], sandbox = true) {
  const f = fakeFetch(respond);
  const client = createIyzicoClient({ baseUrl: BASE, credentials: async () => CREDS, fetch: f.fn, randomKey: () => 'rnd123' });
  return { p: createIyzicoProvider({ client, sandbox, now: () => new Date('2026-11-06T10:00:00Z') }), calls: f.calls };
}

const checkout: CheckoutRequest = {
  intentId: '20261106100000-id1',
  conversationId: 'apt-1:20261106100000-id1',
  amount: toKurus(313_550),
  currency: 'TRY',
  callbackUrl: 'https://api.test/api/payments/iyzico/callback?ref=apt-1%3A20261106100000-id1',
  buyer: {
    id: 'tenant-1',
    identityNumber: '11111111111',
    ip: '203.0.113.7',
    name: 'Ayşe Nur',
    surname: 'Yılmaz',
    email: 'ayse@example.com',
    gsmNumber: '+905350000000',
    address: 'Lale Sk. 1, Kadıköy',
    city: 'Istanbul',
  },
  items: [
    { id: '20261106100000-id1-occupant', name: 'Aidat', amount: toKurus(13_550), subMerchantKey: 'sm-1', subMerchantPrice: toKurus(13_550) },
    { id: '20261106100000-id1-owner', name: 'Aidat', amount: toKurus(300_000), subMerchantKey: 'sm-1', subMerchantPrice: toKurus(295_500) },
  ],
};

// ---------------------------------------------------------------------------

describe('iyzico - IYZWSv2 imzasi ve tutar bicimi', () => {
  it('Authorization: base64(apiKey:..&randomKey:..&signature:hex(HMAC(secret, rnd+path+body)))', () => {
    const body = '{"locale":"tr"}';
    const header = iyzicoAuthorization(CREDS, 'rnd123', '/payment/test', body);
    expect(header.startsWith('IYZWSv2 ')).toBe(true);
    const decoded = Buffer.from(header.slice('IYZWSv2 '.length), 'base64').toString('utf8');
    const expectedSig = createHmac('sha256', CREDS.secretKey).update(`rnd123/payment/test${body}`).digest('hex');
    expect(decoded).toBe(`apiKey:sandbox-api-key&randomKey:rnd123&signature:${expectedSig}`);
    // Bos govde: yalnizca randomKey + path
    const empty = Buffer.from(iyzicoAuthorization(CREDS, 'r', '/x', '').slice(8), 'base64').toString();
    expect(empty).toContain(`signature:${hmacHex(CREDS.secretKey, 'r/x')}`);
  });

  it('kurus <-> ondalik donusumu kayan nokta kullanmaz', () => {
    expect(kurusToPrice(313_550)).toBe('3135.50');
    expect(kurusToPrice(5)).toBe('0.05');
    expect(kurusToPrice(0)).toBe('0.00');
    expect(() => kurusToPrice(1.5)).toThrow();
    expect(priceToKurus('3135.5')).toBe(313_550);
    expect(priceToKurus(3135.5)).toBe(313_550);
    expect(priceToKurus('3135')).toBe(313_500);
    expect(priceToKurus('3135.500')).toBe(313_550);
    expect(priceToKurus(0.1 + 0.2)).toBe(30);
    expect(() => priceToKurus('31.355')).toThrow(PaymentProviderError);
    expect(() => priceToKurus('-1')).toThrow();
    expect(() => priceToKurus(undefined)).toThrow();
  });

  it('yanit imzasi icin sondaki sifirlar atilir', () => {
    expect(signaturePrice('50.00')).toBe('50');
    expect(signaturePrice('10.50')).toBe('10.5');
    expect(signaturePrice('10.510')).toBe('10.51');
    expect(signaturePrice(3135)).toBe('3135');
    expect(signaturePrice(3135.5)).toBe('3135.5');
    expect(signaturePrice('100')).toBe('100');
  });

  it('IBAN (mod-97), maskeleme ve telefon normalizasyonu', () => {
    expect(isValidTrIban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    expect(isValidTrIban('TR330006100519786457841327')).toBe(false);
    expect(isValidTrIban('DE89370400440532013000')).toBe(false);
    expect(maskIban('TR330006100519786457841326')).toBe('TR** **** **** **** **** **13 26');
    expect(normalizeGsm('0532 123 45 67')).toBe('+905321234567');
    expect(normalizeGsm('+90 (532) 123-45-67')).toBe('+905321234567');
    expect(normalizeGsm('5321234567')).toBe('+905321234567');
    expect(normalizeGsm('0212 123 45 67')).toBeUndefined();
  });
});

describe('iyzico - Checkout Form baslatma', () => {
  const ok = (call: Call) => ({
    json: {
      status: 'success',
      conversationId: call.body.conversationId,
      token: 'tok-1',
      paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok-1',
      signature: responseSignature(CREDS.secretKey, [call.body.conversationId, 'tok-1']),
    },
  });

  it('istek: imzali, tek cekim, pazaryeri kalemleri, sanal urun (teslimat adresi yok)', async () => {
    const { p, calls } = provider(ok);
    const session = await p.createCheckout(checkout);
    expect(session).toEqual({ token: 'tok-1', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok-1' });

    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}${IYZICO_PATHS.initialize}`);
    expect(call.headers['x-iyzi-rnd']).toBe('rnd123');
    expect(call.headers.authorization).toBe(iyzicoAuthorization(CREDS, 'rnd123', IYZICO_PATHS.initialize, call.raw));
    expect(call.body).toMatchObject({
      locale: 'tr',
      conversationId: checkout.conversationId,
      price: '3135.50',
      paidPrice: '3135.50',
      currency: 'TRY',
      basketId: checkout.intentId,
      callbackUrl: checkout.callbackUrl,
      enabledInstallments: [1],
      buyer: {
        id: 'tenant-1',
        name: 'Ayşe Nur',
        surname: 'Yılmaz',
        identityNumber: '11111111111',
        email: 'ayse@example.com',
        gsmNumber: '+905350000000',
        registrationAddress: 'Lale Sk. 1, Kadıköy',
        city: 'Istanbul',
        country: 'Turkey',
        ip: '203.0.113.7',
      },
      billingAddress: { contactName: 'Ayşe Nur Yılmaz', city: 'Istanbul', country: 'Turkey' },
    });
    expect(call.body.shippingAddress).toBeUndefined();
    expect(call.body.basketItems).toEqual([
      { id: '20261106100000-id1-occupant', name: 'Aidat', category1: 'Aidat', itemType: 'VIRTUAL', price: '135.50', subMerchantKey: 'sm-1', subMerchantPrice: '135.50' },
      { id: '20261106100000-id1-owner', name: 'Aidat', category1: 'Aidat', itemType: 'VIRTUAL', price: '3000.00', subMerchantKey: 'sm-1', subMerchantPrice: '2955.00' },
    ]);
  });

  it('sepet toplami tutara esit degilse istek gonderilmez', async () => {
    const { p, calls } = provider(ok);
    await expect(p.createCheckout({ ...checkout, amount: toKurus(1) })).rejects.toThrow(/Sepet/);
    expect(calls).toHaveLength(0);
  });

  it('yanit imzasi tutmazsa reddeder', async () => {
    const { p } = provider((c) => ({ json: { ...ok(c).json, signature: 'deadbeef' } }));
    await expect(p.createCheckout(checkout)).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('is hatasi (status=failure) kalici PaymentProviderError; 5xx/ag hatasi tekrar denenebilir', async () => {
    const fail = provider(() => ({ json: { status: 'failure', errorCode: '5001', errorMessage: 'Gecersiz istek' } })).p;
    await expect(fail.createCheckout(checkout)).rejects.toMatchObject({ code: 'iyzico_5001', retryable: false, message: 'Gecersiz istek' });
    const down = provider(() => ({ status: 503, json: {} })).p;
    await expect(down.createCheckout(checkout)).rejects.toMatchObject({ code: 'http_503', retryable: true });
    const net = provider(() => ({ throws: new TypeError('fetch failed') })).p;
    await expect(net.createCheckout(checkout)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    const html = provider(() => ({ status: 400, text: '<html>' })).p;
    await expect(html.createCheckout(checkout)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('iyzico - Checkout Form sonuc sorgusu', () => {
  const success = (over: Record<string, unknown> = {}) => (call: Call) => {
    const r = {
      status: 'success',
      paymentStatus: 'SUCCESS',
      paymentId: '22416035',
      currency: 'TRY',
      basketId: '20261106100000-id1',
      conversationId: call.body.conversationId,
      paidPrice: 3135.5,
      price: 3135.5,
      token: call.body.token,
      fraudStatus: 1,
      ...over,
    };
    const signature = responseSignature(CREDS.secretKey, [
      r.paymentStatus,
      r.paymentId,
      r.currency,
      r.basketId,
      r.conversationId,
      signaturePrice(r.paidPrice),
      signaturePrice(r.price),
      r.token,
    ]);
    return { json: { ...r, signature, ...('signature' in over ? { signature: over.signature } : {}) } };
  };
  const q = { token: 'tok-1', conversationId: 'apt-1:20261106100000-id1' };

  it('basarili: tutar kurusa cevrilir, imza dogrulanir', async () => {
    const { p, calls } = provider(success());
    expect(await p.retrieveCheckout(q)).toEqual({
      status: 'success',
      token: 'tok-1',
      providerPaymentId: '22416035',
      basketId: '20261106100000-id1',
      conversationId: q.conversationId,
      paidAmount: 313_550,
      currency: 'TRY',
      fraudApproved: true,
      paidAt: '2026-11-06',
      signatureValid: true,
    });
    expect(calls[0]!.path).toBe(IYZICO_PATHS.retrieve);
    expect(calls[0]!.body).toEqual({ locale: 'tr', conversationId: q.conversationId, token: 'tok-1' });
  });

  it('imza tutmazsa signatureValid=false (servis incelemeye alir)', async () => {
    const { p } = provider(success({ signature: '00' }));
    expect(await p.retrieveCheckout(q)).toMatchObject({ status: 'success', signatureValid: false });
  });

  it.each([
    ['FAILURE', { paymentStatus: 'FAILURE', errorCode: '10051', errorMessage: 'Kart limiti yetersiz' }, 'failure'],
    ['3DS bekliyor', { paymentStatus: 'INIT_THREEDS' }, 'pending'],
    ['bilinmeyen durum', { paymentStatus: 'X' }, 'pending'],
    ['fraud incelemede', { fraudStatus: 0 }, 'pending'],
    ['fraud red', { fraudStatus: -1 }, 'failure'],
    ['status failure', { status: 'failure', errorCode: '1', errorMessage: 'token bulunamadi' }, 'failure'],
  ])('%s -> %s', async (_label, over, expected) => {
    const { p } = provider(success(over));
    const out = await p.retrieveCheckout(q);
    expect(out.status).toBe(expected);
    if (expected === 'failure' && 'errorMessage' in over) expect(out.errorMessage).toBe(over.errorMessage);
  });

  it('cozumlenemeyen tutar: paidAmount bos (servis tutar uyusmazligi olarak incelemeye alir)', async () => {
    const { p } = provider(success({ paidPrice: '31.355', signature: undefined }));
    expect(await p.retrieveCheckout(q)).toMatchObject({ status: 'success', paidAmount: undefined });
  });
});

describe('iyzico - alt uye isyeri ve webhook', () => {
  it('alt uye kaydi: tipe gore alanlar, externalId = apartmentId', async () => {
    const { p, calls } = provider(() => ({ json: { status: 'success', subMerchantKey: 'smk-123' } }));
    const out = await p.registerSubMerchant({
      subMerchantType: 'PRIVATE_COMPANY',
      externalId: 'apt-1',
      email: 'yonetim@lale.test',
      gsmNumber: '+905321234567',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR330006100519786457841326',
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
    });
    expect(out).toEqual({ subMerchantKey: 'smk-123' });
    expect(calls[0]!.path).toBe('/onboarding/submerchant');
    expect(calls[0]!.body).toEqual({
      locale: 'tr',
      conversationId: 'submerchant:apt-1',
      subMerchantExternalId: 'apt-1',
      subMerchantType: 'PRIVATE_COMPANY',
      email: 'yonetim@lale.test',
      gsmNumber: '+905321234567',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR330006100519786457841326',
      currency: 'TRY',
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
    });
    const fail = provider(() => ({ json: { status: 'failure', errorCode: '2001', errorMessage: 'IBAN hatali' } })).p;
    await expect(fail.registerSubMerchant({ externalId: 'a' } as never)).rejects.toMatchObject({ code: 'iyzico_2001' });
  });

  it('webhook V3 imzasi: secretKey + eventType + paymentId + token + conversationId + status', async () => {
    const { p } = provider(() => ({ json: {} }));
    const body = {
      paymentConversationId: 'apt-1:20261106100000-id1',
      merchantId: 1,
      token: 'tok-1',
      status: 'SUCCESS',
      iyziReferenceCode: 'ref',
      iyziEventType: 'CHECKOUT_FORM_AUTH',
      iyziEventTime: 1_700_000_000_000,
      iyziPaymentId: 22416035,
    };
    const sig = hmacHex(CREDS.secretKey, `${CREDS.secretKey}CHECKOUT_FORM_AUTH22416035tok-1apt-1:20261106100000-id1SUCCESS`);
    expect(await p.verifyWebhook!({ headers: { 'x-iyz-signature-v3': sig }, body })).toEqual({ conversationId: body.paymentConversationId });
    expect(await p.verifyWebhook!({ headers: { 'x-iyz-signature-v3': sig.toUpperCase() }, body })).not.toBeNull();
    expect(await p.verifyWebhook!({ headers: { 'x-iyz-signature-v3': sig }, body: { ...body, status: 'FAILURE' } })).toBeNull();
    expect(await p.verifyWebhook!({ headers: {}, body })).toBeNull();
    expect(await p.verifyWebhook!({ headers: { 'x-iyz-signature-v3': sig }, body: 'x' })).toBeNull();
  });
});

describe('odeme anahtarlari (Secrets Manager)', () => {
  const sm = mockClient(SecretsManagerClient);
  beforeEach(() => sm.reset());

  it('JSON anahtari okur ve 5 dk onbellekte tutar', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify(CREDS) });
    let t = 0;
    const load = secretsManagerCredentials('arn:aws:secretsmanager:eu-north-1:1:secret:x', { client: new SecretsManagerClient({}), now: () => t });
    expect(await load()).toEqual(CREDS);
    await Promise.all([load(), load()]);
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    t = SECRET_CACHE_MS + 1;
    await load();
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    expect(sm.commandCalls(GetSecretValueCommand)[0]!.args[0].input).toEqual({ SecretId: 'arn:aws:secretsmanager:eu-north-1:1:secret:x' });
  });

  it('hatalar anlamli PaymentProviderError olur', async () => {
    const client = new SecretsManagerClient({});
    sm.on(GetSecretValueCommand).rejects(new ResourceNotFoundException({ message: 'yok', $metadata: {} }));
    await expect(secretsManagerCredentials('arn', { client })()).rejects.toMatchObject({ code: 'config', retryable: false });
    sm.on(GetSecretValueCommand).resolves({ SecretString: '{"apiKey":"a"}' });
    await expect(secretsManagerCredentials('arn', { client })()).rejects.toMatchObject({ code: 'config' });
    sm.on(GetSecretValueCommand).resolves({ SecretString: 'duz metin' });
    await expect(secretsManagerCredentials('arn', { client })()).rejects.toMatchObject({ code: 'config' });
    sm.on(GetSecretValueCommand).rejects(new Error('ag'));
    await expect(secretsManagerCredentials('arn', { client })()).rejects.toMatchObject({ code: 'secrets_unavailable', retryable: true });
  });

  it('iyzico yapilandirmasi: izinli base URL ve anahtar kaynagi zorunlu', () => {
    const base = { PAYMENTS_PROVIDER: 'iyzico', PAYMENTS_API_BASE_URL: 'https://api.x', WEB_APP_URL: 'https://web.x' };
    expect(() => loadPaymentsConfig(base)).toThrow(/IYZICO_BASE_URL/);
    expect(() => loadPaymentsConfig({ ...base, IYZICO_BASE_URL: 'https://evil.example' })).toThrow(/IYZICO_BASE_URL/);
    expect(() => loadPaymentsConfig({ ...base, IYZICO_BASE_URL: BASE })).toThrow(/IYZICO_API_KEY/);
    const sandbox = loadPaymentsConfig({ ...base, IYZICO_BASE_URL: `${BASE}/`, IYZICO_API_KEY: 'a', IYZICO_SECRET_KEY: 'b' });
    expect(sandbox.provider).toMatchObject({ name: 'iyzico', sandbox: true });
    const live = loadPaymentsConfig({ ...base, IYZICO_BASE_URL: 'https://api.iyzipay.com', PAYMENTS_SECRET_ARN: 'arn:x' });
    expect(live.provider).toMatchObject({ name: 'iyzico', sandbox: false });
  });
});
