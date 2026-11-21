import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { payoutSchema, platformApartmentsSchema, platformInvoiceSchema, type PaymentAccount } from '@/lib/api/payments';
import {
  PAYOUT_GROUPS,
  accountForm,
  accountWarnings,
  buildAccountPatch,
  canResend,
  feeSummary,
  invoiceNumberError,
  isValidVkn,
  kurusToFeeInput,
  parseFixedFeeToKurus,
  payoutGroupOf,
  payoutQueryFor,
  periodLabel,
  providerLabel,
  recentPeriods,
  settlementView,
  toProviderSetting,
  vatLabel,
} from './platform';

const account = (over: Partial<PaymentAccount> = {}): PaymentAccount => ({
  apartmentId: 'apt-1',
  provider: 'paytr',
  subMerchantKey: 'k',
  subMerchantType: 'PRIVATE_COMPANY',
  ibanMasked: 'TR33 **** 1326',
  payeeOnFile: true,
  status: 'active',
  platformFeeBasisPoints: 75,
  effectiveFees: { platformBasisPoints: 75, posRateBasisPoints: 249, posFixedFeeKurus: 25 },
  invoiceRecipient: { title: 'Lale Yönetimi', taxNumber: '1234567890', taxOffice: 'Kadıköy' },
  createdAt: '2026-11-01T10:00:00Z',
  createdBy: 'u',
  updatedAt: '2026-11-01T10:00:00Z',
  updatedBy: 'u',
  version: 1,
  ...over,
});

describe('saglayici ve POS ayari', () => {
  it('saglayici etiketi ve ortam varsayilani', () => {
    expect(providerLabel('paytr')).toBe('PayTR');
    expect(providerLabel('iyzico')).toBe('iyzico');
    expect(providerLabel(null)).toBe('—');
    expect(toProviderSetting('')).toBeNull();
    expect(toProviderSetting('paytr')).toBe('paytr');
  });

  it('sabit POS ucreti: kurus, bos = degistirme, 50 TL ust sinir', () => {
    expect(parseFixedFeeToKurus('0')).toBe(0);
    expect(parseFixedFeeToKurus('0,25')).toBe(25);
    expect(parseFixedFeeToKurus('₺1.5')).toBe(150);
    expect(parseFixedFeeToKurus('50')).toBe(5_000);
    expect(parseFixedFeeToKurus('  ')).toBeUndefined();
    expect(parseFixedFeeToKurus('50,01')).toBeNull();
    expect(parseFixedFeeToKurus('-1')).toBeNull();
    expect(parseFixedFeeToKurus('0,255')).toBeNull();
    expect(kurusToFeeInput(25)).toBe('0,25');
    expect(kurusToFeeInput(5_000)).toBe('50,00');
  });

  it('etkin komisyon ozeti: hesaba ozel deger yoksa varsayilan yazar', () => {
    expect(feeSummary(account())).toBe('pay %0,75 · POS %2,49 + ₺0,25 (varsayılan)');
    expect(feeSummary(account({ posRateBasisPoints: 199 }))).not.toMatch(/varsayılan/);
    expect(feeSummary(account({ effectiveFees: undefined }))).toBe('pay %0,75');
  });

  it('satir uyarilari: PayTR icin IBAN, her saglayicida VKN', () => {
    expect(accountWarnings({ effectiveProvider: 'paytr', account: account() })).toEqual([]);
    expect(accountWarnings({ effectiveProvider: 'paytr', account: account({ payeeOnFile: false, invoiceRecipient: undefined }) })).toEqual([
      'IBAN kayıtlı değil',
      'Fatura VKN eksik',
    ]);
    // iyzico aktarimi kendisi yapar: kayitli alici gerekmez.
    expect(accountWarnings({ effectiveProvider: 'iyzico', account: account({ provider: 'iyzico', payeeOnFile: false }) })).toEqual([]);
    expect(accountWarnings({ effectiveProvider: 'paytr', account: null })).toEqual([]);
    expect(isValidVkn('1234567890')).toBe(true);
    expect(isValidVkn('123456789')).toBe(false);
  });
});

describe('aktarim gruplari', () => {
  it('her API durumu tam olarak bir gruba duser', () => {
    const all = Object.values(PAYOUT_GROUPS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(['RESEND_FAILED', 'RESEND_PENDING', 'RESEND_SENT', 'RESENT', 'RETURNED', 'SENT', 'SETTLED']);
    expect(payoutGroupOf('SENT')).toBe('waiting');
    expect(payoutGroupOf('RESENT')).toBe('done');
    expect(payoutGroupOf('RETURNED')).toBe('returned');
    expect(payoutGroupOf('RESEND_FAILED')).toBe('failed');
  });

  it('yeniden gonderim yalnizca geri donen ve basarisiz aktarimda', () => {
    expect(canResend('RETURNED')).toBe(true);
    expect(canResend('RESEND_FAILED')).toBe(true);
    expect(canResend('SENT')).toBe(false);
    expect(canResend('RESEND_PENDING')).toBe(false);
  });

  it('sorgu: varsayilan API filtresi, tek durum dogrudan, coklu durum istemcide', () => {
    expect(payoutQueryFor('attention')).toEqual({});
    expect(payoutQueryFor('returned')).toEqual({ status: 'RETURNED' });
    expect(payoutQueryFor('waiting')).toEqual({ status: 'all', filter: ['SENT', 'RESEND_PENDING', 'RESEND_SENT'] });
  });

  it('aktarim kaydi semasi sifreli alici tasimaz', () => {
    const p = payoutSchema.parse({
      apartmentId: 'apt-1',
      provider: 'paytr',
      intentId: 'i1',
      itemId: 'x',
      transferId: 'i1W',
      providerPaymentId: 'oid',
      amount: 99_000,
      grossAmount: 100_000,
      ibanMasked: 'TR33 **** 1326',
      status: 'RETURNED',
      sentAt: '2026-11-20T00:00:00Z',
      resend: { resendId: 'i1WR1', requestedAt: 'x', requestedBy: 'u', note: 'n', ibanMasked: 'm', attempts: 0, payeeCiphertext: 'gizli' },
      createdAt: 'x',
      updatedAt: 'x',
      version: 3,
    });
    expect(JSON.stringify(p)).not.toContain('gizli');
  });

  it('bekleyen / basarisiz onay ozeti', () => {
    expect(
      settlementView({ settlementStatus: 'failed', approvals: [{ itemId: 'a', status: 'failed', attempts: 3, error: { code: 'paytr_010', message: 'IBAN yok', at: 'x' } }] }),
    ).toMatchObject({ tone: 'danger', detail: 'IBAN yok (paytr_010)' });
    expect(
      settlementView({ settlementStatus: 'pending', approvals: [{ itemId: 'a', status: 'pending', attempts: 0, releaseAfter: '2026-11-22T21:00:00Z' }] }),
    ).toMatchObject({ tone: 'warning', detail: 'Planlanan gönderim: 2026-11-22T21:00:00Z' });
  });
});

describe('komisyon faturalari', () => {
  it('fatura numarasi kurali API ile ayni', () => {
    expect(invoiceNumberError('ABC2026000000001')).toBeUndefined();
    expect(invoiceNumberError('A/1')).toBeUndefined();
    expect(invoiceNumberError('AB')).toMatch(/3-40/);
    expect(invoiceNumberError('ABC 123')).toMatch(/harf/);
  });

  it('donemler Istanbul saatine gore, yil gecisi', () => {
    // 31.12.2026 22:30 UTC = 01.01.2027 01:30 Istanbul.
    expect(recentPeriods(new Date('2026-12-31T22:30:00Z'), 3)).toEqual(['2027-01', '2026-12', '2026-11']);
    expect(periodLabel('2026-11')).toMatch(/2026/);
    expect(vatLabel('inclusive', 2000)).toBe('KDV dahil %20');
  });

  it('semalar: eski API yaniti (saglayici listesi yok) kabul edilir; fatura KDV modu', () => {
    const r = platformApartmentsSchema.parse({ provider: 'iyzico', sandbox: true, items: [] });
    expect(r.providers).toEqual([]);
    expect(() =>
      platformInvoiceSchema.parse({
        invoiceId: 'M-2026-11',
        apartmentId: 'a',
        mode: 'monthly',
        period: '2026-11',
        status: 'DRAFT',
        lines: [],
        netAmount: 833,
        vatRateBasisPoints: 2000,
        vatMode: 'gross',
        vatAmount: 166,
        totalAmount: 999,
        invoiceProvider: 'manual',
        createdAt: 'x',
        updatedAt: 'x',
        version: 1,
      }),
    ).toThrow();
  });
});

describe('hesap ayarlari formu', () => {
  const MAX = 2_000;

  it('degisiklik yoksa yalnizca saglayici gider', () => {
    const acc = account();
    expect(buildAccountPatch(acc, accountForm(acc), MAX)).toEqual({ ok: true, patch: { provider: 'paytr' }, changed: false });
  });

  it('POS: deger girilir, bos birakilinca varsayilana doner (null)', () => {
    const acc = account();
    const r = buildAccountPatch(acc, { ...accountForm(acc), posRate: '1,99', posFixed: '0' }, MAX);
    expect(r).toMatchObject({ ok: true, patch: { posRateBasisPoints: 199, posFixedFeeKurus: 0 }, changed: true });
    const custom = account({ posRateBasisPoints: 199, posFixedFeeKurus: 0 });
    expect(accountForm(custom)).toMatchObject({ posRate: '1,99', posFixed: '0,00' });
    expect(buildAccountPatch(custom, { ...accountForm(custom), posRate: '', posFixed: '' }, MAX)).toMatchObject({
      ok: true,
      patch: { posRateBasisPoints: null, posFixedFeeKurus: null },
    });
    expect(buildAccountPatch(acc, { ...accountForm(acc), posRate: '11', posFixed: '51' }, MAX)).toMatchObject({
      ok: false,
      errors: { posRate: expect.any(String), posFixed: expect.any(String) },
    });
  });

  it('IBAN ve hesap sahibi birlikte; normalize edilir', () => {
    const acc = account();
    const form = { ...accountForm(acc), changePayee: true, iban: 'tr33 0006 1005 1978 6457 8413 26', accountHolderName: ' Lale Yönetimi ' };
    expect(buildAccountPatch(acc, form, MAX)).toMatchObject({
      ok: true,
      patch: { iban: 'TR330006100519786457841326', accountHolderName: 'Lale Yönetimi' },
    });
    expect(buildAccountPatch(acc, { ...form, accountHolderName: '' }, MAX)).toMatchObject({ ok: false, errors: { accountHolderName: expect.any(String) } });
    expect(buildAccountPatch(acc, { ...form, iban: 'TR00' }, MAX)).toMatchObject({ ok: false, errors: { iban: expect.any(String) } });
  });

  it('fatura muhatabi: tumu bos = kaldir, kismi = hata, degisirse gonderilir', () => {
    const acc = account();
    const empty = { ...accountForm(acc), recipientTitle: '', recipientTaxNumber: '', recipientTaxOffice: '' };
    expect(buildAccountPatch(acc, empty, MAX)).toMatchObject({ ok: true, patch: { invoiceRecipient: null } });
    expect(buildAccountPatch(acc, { ...empty, recipientTaxNumber: '123' }, MAX)).toMatchObject({ ok: false });
    expect(buildAccountPatch(acc, { ...accountForm(acc), recipientTaxOffice: 'Üsküdar' }, MAX)).toMatchObject({
      ok: true,
      patch: { invoiceRecipient: { title: 'Lale Yönetimi', taxNumber: '1234567890', taxOffice: 'Üsküdar' } },
    });
  });
});
