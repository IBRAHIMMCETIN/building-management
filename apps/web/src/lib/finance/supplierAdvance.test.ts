import { describe, expect, it } from 'vitest';
import { advanceFormState, advanceOffsetFormState, fifoTargets } from './supplierAdvance';

const items = [
  { transactionId: 'a', date: '2026-10-01', description: 'A-1', amount: 300000, open: 300000 },
  { transactionId: 'b', date: '2026-10-15', description: 'B-1', amount: 400000, open: 400000 },
];
const base = { amount: 200000, selected: [], items, maxAmount: 500000, advanceDate: '2026-09-05', date: '2026-11-01', today: '2026-11-01', reason: 'Avans faturaya' };

describe('tedarikci avansi formu', () => {
  it('avans: hesap, tarih, tutar ve bakiye kontrolu', () => {
    expect(advanceFormState({ amount: 1000, fundsAccountId: 'cash', fundsBalance: 5000, date: '2026-11-01', today: '2026-11-01' })).toEqual({ valid: true });
    expect(advanceFormState({ amount: 6000, fundsAccountId: 'cash', fundsBalance: 5000, date: '2026-11-01', today: '2026-11-01' }).error).toContain('yetersiz');
    expect(advanceFormState({ amount: 1000, fundsAccountId: 'cash', fundsBalance: 5000, date: '2026-11-02', today: '2026-11-01' }).valid).toBe(false);
    expect(advanceFormState({ amount: null, fundsAccountId: 'cash', fundsBalance: 5000, date: '2026-11-01', today: '2026-11-01' }).valid).toBe(false);
    expect(advanceFormState({ amount: 1000, fundsAccountId: '', fundsBalance: undefined, date: '2026-11-01', today: '2026-11-01' }).valid).toBe(false);
  });

  it('mahsup: fatura secilmezse tutar (FIFO), secilirse acik kalanlar avansla sinirli', () => {
    expect(advanceOffsetFormState(base)).toMatchObject({ valid: true, amount: 200000 });
    expect(advanceOffsetFormState(base).settles).toBeUndefined();
    const chosen = advanceOffsetFormState({ ...base, selected: ['b', 'a'] });
    // Liste sirasi (eskiden yeniye); son fatura kalan avansla kismi.
    expect(chosen).toMatchObject({ valid: true, amount: 500000, settles: [{ transactionId: 'a', amount: 300000 }, { transactionId: 'b', amount: 200000 }] });
    expect(fifoTargets(items, 350000).map((i) => i.transactionId)).toEqual(['a', 'b']);
  });

  it('mahsup: tutar ust siniri, tarih kurallari ve gerekce', () => {
    expect(advanceOffsetFormState({ ...base, amount: 600000 }).errors.amount).toContain('en fazla');
    expect(advanceOffsetFormState({ ...base, maxAmount: 0 }).errors.amount).toContain('yok');
    expect(advanceOffsetFormState({ ...base, date: '2026-09-01' }).errors.date).toContain('avans tarihinden');
    expect(advanceOffsetFormState({ ...base, date: '2026-11-02' }).errors.date).toContain('bugünden');
    // B faturasi 15.10'da: 10.10 tarihli mahsup B'yi kapatamaz.
    expect(advanceOffsetFormState({ ...base, selected: ['b'], date: '2026-10-10' }).errors.date).toContain('faturanın tarihinden');
    expect(advanceOffsetFormState({ ...base, amount: 100000, date: '2026-10-10' }).errors.date).toBeUndefined();
    expect(advanceOffsetFormState({ ...base, reason: 'x' }).errors.reason).toBeDefined();
  });
});
