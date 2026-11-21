import { DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';
import { toKurus } from '../src/modules/core/types.js';
import { loadInvoiceSettings, loadPaymentsConfig, loadVault } from '../src/modules/payments/config.js';
import { invoiceTotals, manualInvoiceProvider, previousPeriod } from '../src/modules/payments/invoices.js';
import {
  PAYEE_PURPOSE,
  createKmsPayeeVault,
  createLocalPayeeVault,
  ibanLast4,
  isValidTrIban,
  maskIban,
  normalizePayeeName,
} from '../src/modules/payments/payee.js';
import { createPaytrClient, paytrHash, paytrToken } from '../src/modules/payments/paytr/client.js';
import { createPaytrProvider, paytrDateTime } from '../src/modules/payments/paytr/provider.js';
import { PaymentProviderError } from '../src/modules/payments/provider.js';
import { nextDayStart, payoutReleaseAfter, transferIdOf } from '../src/modules/payments/service.js';

const IBAN = 'TR330006100519786457841326';
const CTX = { apartmentId: 'apt-1', provider: 'paytr' };

describe('alici (IBAN + ad)', () => {
  it('TR IBAN: TR + 24 hane ve mod-97; maskeleme ve son 4 hane', () => {
    expect(isValidTrIban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    expect(isValidTrIban('tr330006100519786457841326')).toBe(true);
    expect(isValidTrIban('TR330006100519786457841327')).toBe(false); // kontrol hanesi
    expect(isValidTrIban('TR33000610051978645784132')).toBe(false); // 23 hane
    expect(isValidTrIban('DE89370400440532013000')).toBe(false);
    expect(maskIban(IBAN)).toBe('TR** **** **** **** **** **13 26');
    expect(ibanLast4('TR** **** **** **** **** **13 26')).toBe('1326');
    expect(normalizePayeeName('  Lale   Apartmanı Yönetimi ')).toBe('Lale Apartmanı Yönetimi');
    expect(normalizePayeeName('X')).toBeUndefined();
  });

  it('yerel kasa: baglam (apartman/saglayici) disinda cozulemez; bozuk metin reddedilir', async () => {
    const vault = createLocalPayeeVault();
    const sealed = await vault.seal(CTX, { iban: IBAN, name: 'Lale' });
    expect(sealed).not.toContain(IBAN);
    expect(await vault.open(CTX, sealed)).toEqual({ iban: IBAN, name: 'Lale' });
    await expect(vault.open({ ...CTX, provider: 'iyzico' }, sealed)).rejects.toMatchObject({ code: 'payee_corrupt' });
    await expect(createLocalPayeeVault().open(CTX, sealed)).rejects.toMatchObject({ code: 'payee_corrupt' });
    await expect(vault.open(CTX, 'AQID')).rejects.toMatchObject({ code: 'payee_corrupt' });
  });

  it('KMS kasasi: anahtar + sifreleme baglami ile Encrypt/Decrypt; erisim hatasi kalici, kisitlama gecici', async () => {
    const calls: unknown[] = [];
    let fail: Error | undefined;
    const client = {
      send: async (cmd: EncryptCommand | DecryptCommand) => {
        calls.push(cmd);
        if (fail) throw fail;
        if (cmd instanceof EncryptCommand) return { CiphertextBlob: Buffer.from(`enc:${Buffer.from(cmd.input.Plaintext as Uint8Array).toString('utf8')}`) };
        return { Plaintext: Buffer.from(Buffer.from(cmd.input.CiphertextBlob as Uint8Array).toString('utf8').slice(4)) };
      },
    };
    const vault = createKmsPayeeVault({ keyId: 'arn:aws:kms:eu-north-1:123456789012:key/abc', client: client as never });
    const sealed = await vault.seal(CTX, { iban: IBAN, name: 'Lale' });
    expect(await vault.open(CTX, sealed)).toEqual({ iban: IBAN, name: 'Lale' });
    const [enc, dec] = calls as [EncryptCommand, DecryptCommand];
    expect(enc.input).toMatchObject({ KeyId: 'arn:aws:kms:eu-north-1:123456789012:key/abc', EncryptionContext: { purpose: PAYEE_PURPOSE, apartmentId: 'apt-1', provider: 'paytr' } });
    expect(dec.input).toMatchObject({ KeyId: 'arn:aws:kms:eu-north-1:123456789012:key/abc', EncryptionContext: { purpose: PAYEE_PURPOSE, apartmentId: 'apt-1', provider: 'paytr' } });
    fail = Object.assign(new Error('x'), { name: 'AccessDeniedException' });
    await expect(vault.open(CTX, sealed)).rejects.toMatchObject({ code: 'kms_decrypt_failed', retryable: false });
    fail = Object.assign(new Error('x'), { name: 'ThrottlingException' });
    await expect(vault.seal(CTX, { iban: IBAN, name: 'L' })).rejects.toMatchObject({ code: 'kms_encrypt_failed', retryable: true });
  });

  it('yapilandirma: KMS ARN dogrulamasi; production\'da anahtarsiz kasa yok; gelistirmede yerel kasa', () => {
    expect(() => loadVault({ PAYEE_KMS_KEY_ID: 'abc' })).toThrow(/PAYEE_KMS_KEY_ID/);
    expect(loadVault({ PAYEE_KMS_KEY_ID: 'arn:aws:kms:eu-north-1:123456789012:key/0f8fad5b-d9cb-469f-a165-70867728950e' })).toBeDefined();
    expect(loadVault({ PAYEE_KMS_KEY_ID: 'arn:aws:kms:eu-north-1:123456789012:alias/bm-payee' })).toBeDefined();
    expect(loadVault({ NODE_ENV: 'production' })).toBeUndefined();
    expect(loadVault({})).toBe(loadVault({}));
    const urls = { PAYMENTS_API_BASE_URL: 'https://a.b', WEB_APP_URL: 'https://c.d', PAYTR_SECRET_ARN: 'arn:p' };
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_TRANSFER_DELAY_HOURS: '-1', ...urls })).toThrow(/PAYTR_TRANSFER_DELAY_HOURS/);
    expect(loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', PAYTR_TRANSFER_DELAY_HOURS: '48', ...urls }).providers.get('paytr')?.capabilities.releaseDelayHours).toBe(48);
  });
});

describe('platform transferi zamanlamasi ve kimlik', () => {
  it('en erken odemenin ertesi gunu (Istanbul 00:00) ve bekleme suresi', () => {
    expect(nextDayStart('2026-11-06')).toBe('2026-11-06T21:00:00.000Z');
    expect(payoutReleaseAfter(new Date('2026-11-06T10:00:00Z'), 24)).toBe('2026-11-07T10:00:00.000Z');
    // Istanbul 23:30 (UTC 20:30): ertesi gun 00:00 Istanbul = 30 dk sonra.
    expect(payoutReleaseAfter(new Date('2026-11-06T20:30:00Z'), 0)).toBe('2026-11-06T21:00:00.000Z');
  });

  it('transfer kimligi: siparis kimligi + taraf harfi, alfanumerik <= 60', () => {
    expect(transferIdOf({ intentId: '20261106100000-abc', providerReference: '20261106100000abc' }, '20261106100000-abc-owner')).toBe('20261106100000abcW');
    expect(transferIdOf({ intentId: '20261106100000-abc' }, 'x-occupant')).toBe('20261106100000abcO');
    expect(transferIdOf({ intentId: 'x', providerReference: 'a'.repeat(80) }, 'i-owner')).toHaveLength(59);
  });
});

const PAYTR = { merchantId: '100001', merchantKey: 'KEY123', merchantSalt: 'SALT456' };
function paytr(respond: (form: Record<string, string>, path: string) => unknown) {
  const calls: { path: string; form: Record<string, string> }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    calls.push({ path, form });
    return new Response(JSON.stringify(respond(form, path)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { p: createPaytrProvider({ client: createPaytrClient({ credentials: async () => PAYTR, fetch: fetchFn }), testMode: false }), calls };
}

describe('PayTR Platform Transfer (P4)', () => {
  const req = {
    itemId: 'i-occupant',
    providerItemId: 'OID1-occupant',
    providerPaymentId: 'OID1',
    subMerchantKey: 'paytr-apt1',
    amount: toKurus(96_735),
    grossAmount: toKurus(100_000),
    transferId: 'OID1O',
    payee: { iban: IBAN, name: 'Lale Apartmanı Yönetimi' },
    conversationId: 'approve:x',
  };

  it('talimat: kurus tutarlar, hash sirasi, referans', async () => {
    const { p, calls } = paytr((f) => ({ status: 'success', merchant_amount: '0', submerchant_amount: f.submerchant_amount, trans_id: f.trans_id, reference: 556677 }));
    expect(await p.releaseItem!(req)).toEqual({ providerReference: '556677' });
    expect(calls[0]).toEqual({
      path: '/odeme/platform/transfer',
      form: {
        merchant_id: '100001',
        merchant_oid: 'OID1',
        trans_id: 'OID1O',
        submerchant_amount: '96735',
        total_amount: '100000',
        transfer_name: 'Lale Apartmanı Yönetimi',
        transfer_iban: IBAN,
        paytr_token: paytrToken(PAYTR, `100001OID1OID1O96735100000Lale Apartmanı Yönetimi${IBAN}`),
      },
    });
  });

  it('talimat hatalari: red kesin, eslesmeyen yanit belirsiz, alicisiz/gecersiz kimlik reddedilir', async () => {
    await expect(paytr(() => ({ status: 'error', err_no: '010', err_msg: 'kalan' })).p.releaseItem!(req)).rejects.toMatchObject({ code: 'paytr_010', retryable: false });
    await expect(paytr(() => ({ status: 'success', trans_id: 'BASKA' })).p.releaseItem!(req)).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(paytr(() => ({})).p.releaseItem!({ ...req, payee: undefined })).rejects.toMatchObject({ code: 'payee_missing' });
    await expect(paytr(() => ({})).p.releaseItem!({ ...req, payee: { iban: 'TR330006100519786457841327', name: 'x' } })).rejects.toMatchObject({ code: 'payee_missing' });
    await expect(paytr(() => ({})).p.releaseItem!({ ...req, transferId: 'OID1-O' })).rejects.toThrow(/trans_id/);
  });

  it('sonuc bildirimi: trans_ids (kacisli JSON) ve yeniden gonderim (cashout) imzalari', async () => {
    const { p } = paytr(() => ({}));
    const ids = '["OID1O","OID2W"]';
    const ok = await p.verifyTransferWebhook!({ headers: {}, body: { trans_ids: ids.replace(/"/g, '\\"'), hash: paytrHash('KEY123', `${ids}SALT456`) } });
    expect(ok).toEqual({ kind: 'settled', transferIds: ['OID1O', 'OID2W'] });
    expect(await p.verifyTransferWebhook!({ headers: {}, body: { trans_ids: ids, hash: paytrHash('KEY123', `${ids}YANLIS`) } })).toBeNull();
    expect(await p.verifyTransferWebhook!({ headers: {}, body: { trans_ids: ids } })).toBeNull();
    const cashout = {
      mode: 'cashout',
      merchant_id: '100001',
      trans_id: 'OID1OR1',
      processed_result: JSON.stringify([{ amount: 967.35, receiver: 'Lale', iban: IBAN, result: 'failed' }]),
      hash: paytrHash('KEY123', '100001OID1OR1SALT456'),
    };
    expect(await p.verifyTransferWebhook!({ headers: {}, body: cashout })).toEqual({
      kind: 'resend_result',
      resendId: 'OID1OR1',
      results: [{ amount: 96_735, ibanLast4: '1326', result: 'failed' }],
    });
    expect(await p.verifyTransferWebhook!({ headers: {}, body: { ...cashout, hash: 'x' } })).toBeNull();
  });

  it('geri donen liste: tarih bicimi (Istanbul), farkli yanit sekilleri, bos aralik, hata', async () => {
    expect(paytrDateTime(new Date('2026-11-06T21:30:05Z'))).toBe('2026-11-07 00:30:05');
    const rec = { ref_no: '1000001', transfer_iban: IBAN, transfer_name: 'L', transfer_amount: '35.18', transfer_currency: 'TL', transfer_date: '2026-11-07 10:00:00' };
    const { p, calls } = paytr(() => ({ status: 'success', ...rec }));
    const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-09T00:00:00Z') };
    expect(await p.listReturnedTransfers!(range)).toEqual([{ refNo: '1000001', ibanLast4: '1326', amount: 3518, transferDate: '2026-11-07' }]);
    expect(calls[0]!.form).toEqual({
      merchant_id: '100001',
      start_date: '2026-10-01 03:00:00',
      end_date: '2026-11-09 03:00:00',
      paytr_token: paytrToken(PAYTR, '1000012026-10-01 03:00:002026-11-09 03:00:00'),
    });
    expect(await paytr(() => ({ status: 'success', list: [rec, { ...rec, ref_no: '2' }] })).p.listReturnedTransfers!(range)).toHaveLength(2);
    expect(await paytr(() => ({ status: 'failed' })).p.listReturnedTransfers!(range)).toEqual([]);
    await expect(paytr(() => ({ status: 'error', err_no: '1' })).p.listReturnedTransfers!(range)).rejects.toMatchObject({ retryable: true });
    await expect(paytr(() => ({ status: 'success', data: [{ ...rec, transfer_amount: '?' }] })).p.listReturnedTransfers!(range)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('yeniden gonderim: trans_info JSON (kurus), hash merchant_id + trans_id', async () => {
    const { p, calls } = paytr((f) => ({ status: 'success', trans_id: f.trans_id }));
    await p.resendReturned!({ resendId: 'OID1OR1', amount: toKurus(3518), payee: { iban: IBAN, name: 'Lale' } });
    expect(calls[0]).toEqual({
      path: '/odeme/hesaptan-gonder',
      form: { merchant_id: '100001', trans_id: 'OID1OR1', trans_info: JSON.stringify([{ amount: '3518', receiver: 'Lale', iban: IBAN }]), paytr_token: paytrToken(PAYTR, '100001OID1OR1') },
    });
    await expect(paytr(() => ({ status: 'error', err_no: '011' })).p.resendReturned!({ resendId: 'R1', amount: toKurus(1), payee: { iban: IBAN, name: 'L' } })).rejects.toMatchObject({ code: 'paytr_011', retryable: false });
  });
});

describe('platform komisyon faturasi hesabi', () => {
  it('KDV haric/dahil, yarim yukari; donem', () => {
    expect(invoiceTotals(toKurus(999), 2000, 'exclusive')).toEqual({ netAmount: 999, vatAmount: 200, totalAmount: 1_199 });
    expect(invoiceTotals(toKurus(750), 2000, 'exclusive')).toEqual({ netAmount: 750, vatAmount: 150, totalAmount: 900 });
    expect(invoiceTotals(toKurus(750), 2000, 'inclusive')).toEqual({ netAmount: 625, vatAmount: 125, totalAmount: 750 });
    expect(invoiceTotals(toKurus(1), 2000, 'inclusive')).toEqual({ netAmount: 1, vatAmount: 0, totalAmount: 1 });
    expect(invoiceTotals(toKurus(0), 2000, 'exclusive')).toEqual({ netAmount: 0, vatAmount: 0, totalAmount: 0 });
    expect(previousPeriod('2027-01-01')).toBe('2026-12');
    expect(previousPeriod('2026-11-30')).toBe('2026-10');
  });

  it('manual saglayici numara ister; ayarlar dogrulanir', async () => {
    await expect(manualInvoiceProvider.issue({} as never, {})).rejects.toThrow(/invoiceNumber/);
    expect(await manualInvoiceProvider.issue({} as never, { invoiceNumber: ' ABC2026000000001 ' })).toEqual({ invoiceNumber: 'ABC2026000000001' });
    // Karar (21.11.2026): kesilen platform payi KDV dahil.
    expect(loadInvoiceSettings({})).toEqual({ mode: 'monthly', vatRateBasisPoints: 2000, vatMode: 'inclusive' });
    expect(loadInvoiceSettings({ PLATFORM_INVOICE_VAT_MODE: 'exclusive' }).vatMode).toBe('exclusive');
    expect(() => loadInvoiceSettings({ PLATFORM_INVOICE_MODE: 'yearly' })).toThrow(/PLATFORM_INVOICE_MODE/);
    expect(() => loadInvoiceSettings({ PLATFORM_INVOICE_VAT_BPS: '20.5' })).toThrow(/VAT_BPS/);
    expect(() => loadInvoiceSettings({ PLATFORM_INVOICE_VAT_MODE: 'x' })).toThrow(/VAT_MODE/);
  });
});
