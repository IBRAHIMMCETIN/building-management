import { describe, expect, it } from 'vitest';
import { payablePaymentState, preselectPayable, settleState, sortPayables } from './payable';

const sug = (payableAccountId: string, confidence: number) => ({ kind: 'payable' as const, payableAccountId, name: payableAccountId, openBalance: 1000, confidence, reasons: [] });

describe('tedarikci odemesi yardimcilari', () => {
  it('yeterli guvenli ilk oneri onceden secilir; listede yoksa veya zayifsa secim yok', () => {
    const payables = [{ accountId: 'pay-enerjisa' }, { accountId: 'pay-asansor' }];
    expect(preselectPayable([sug('pay-enerjisa', 0.85), sug('pay-asansor', 0.5)], payables)).toBe('pay-enerjisa');
    expect(preselectPayable([sug('pay-enerjisa', 0.4)], payables)).toBe('');
    expect(preselectPayable([sug('pay-baska', 0.9)], payables)).toBe('');
    expect(preselectPayable([], payables)).toBe('');
  });

  it('acik borcu asan odeme reddedilir; kalan borc hesaplanir', () => {
    expect(settleState(2500, undefined)).toMatchObject({ valid: false, error: 'Tedarikçi seçin' });
    expect(settleState(2500, { openBalance: 0 })).toMatchObject({ valid: false });
    expect(settleState(2501, { openBalance: 2500 })).toMatchObject({ valid: false });
    expect(settleState(2501, { openBalance: 2500 }).error).toContain('avans olarak kaydedin');
    expect(settleState(1000, { openBalance: 2500 })).toEqual({ valid: true, remaining: 1500 });
    expect(settleState(2500, { openBalance: 2500 })).toEqual({ valid: true, remaining: 0 });
  });

  it('siralama: onerilen basta, sonra acik borc', () => {
    const list = [
      { accountId: 'a', name: 'Asansör', openBalance: 100 },
      { accountId: 'b', name: 'Bahçe', openBalance: 900 },
      { accountId: 'c', name: 'Cam', openBalance: 500 },
    ];
    expect(sortPayables(list).map((p) => p.accountId)).toEqual(['b', 'c', 'a']);
    expect(sortPayables(list, 'a').map((p) => p.accountId)).toEqual(['a', 'b', 'c']);
  });

  it('elle odeme formu', () => {
    const base = { amount: 1000, openBalance: 2500, fundsAccountId: 'bank', date: '2026-11-22' };
    expect(payablePaymentState(base)).toEqual({ valid: true });
    expect(payablePaymentState({ ...base, fundsAccountId: '' }).valid).toBe(false);
    expect(payablePaymentState({ ...base, amount: null }).valid).toBe(false);
    expect(payablePaymentState({ ...base, amount: 2501 })).toEqual({ valid: false, error: 'Tutar açık borcu aşamaz' });
    expect(payablePaymentState({ ...base, date: '' }).valid).toBe(false);
  });
});
