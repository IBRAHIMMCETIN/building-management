import { describe, expect, it } from 'vitest';
import { type FormerAccount, formerAccountSchema } from '@/lib/api/closures';
import { summarySchema } from '@/lib/api/finance';
import { formerPreset, formerTotals, sortFormer } from './formerAccounts';
import { paymentSchema } from './schemas';

const acc = (over: Partial<FormerAccount>): FormerAccount =>
  formerAccountSchema.parse({
    accountId: 'recv-u1-occupant-cabc',
    name: 'Daire 1 ayrılan sakin',
    unitId: 'u1',
    unitNumber: '1',
    liableParty: 'occupant',
    balance: 0,
    debt: 0,
    advance: 0,
    overdue: 0,
    daysOverdue: 0,
    lateFee: 0,
    ...over,
  });

describe('ayrilan cariler', () => {
  const overdueOld = acc({ accountId: 'a', balance: 1000, debt: 1000, overdue: 1000, daysOverdue: 40, lateFee: 30 });
  const overdueNew = acc({ accountId: 'b', balance: 5000, debt: 5000, overdue: 5000, daysOverdue: 5 });
  const pending = acc({ accountId: 'c', balance: 9000, debt: 9000 });
  const advance = acc({ accountId: 'd', balance: -2000, advance: 2000 });
  const settled = acc({ accountId: 'e' });

  it('siralama: gecikmis (en eski) > borclu > avans > kapanmis', () => {
    expect(sortFormer([settled, advance, pending, overdueNew, overdueOld]).map((a) => a.accountId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('toplamlar avanslari borca saymaz', () => {
    expect(formerTotals([overdueOld, overdueNew, pending, advance, settled])).toEqual({ debt: 15000, debtorCount: 3, overdue: 6000, lateFee: 30 });
  });

  it('Tahsilat al kisayolu cariyi ve borcun tamamini on secer', () => {
    expect(formerPreset(overdueOld)).toEqual({ unitId: 'u1', liableParty: 'occupant', accountId: 'a', amount: 1000 });
    expect(formerPreset(advance).amount).toBe(0);
  });
});

describe('tahsilat formu: cari secimi', () => {
  const base = { unitId: 'u1', liableParty: 'occupant', amount: '100', method: 'cash', paidAt: '2026-11-20', payerName: '', note: '' };
  it('bos = ana cari (gonderilmez), dolu = ayrilan cari', () => {
    expect(paymentSchema.parse({ ...base, accountId: '' }).accountId).toBeUndefined();
    expect(paymentSchema.parse({ ...base, accountId: 'recv-u1-occupant-cabc' }).accountId).toBe('recv-u1-occupant-cabc');
  });
});

describe('ozet semasi', () => {
  it('eski API (ayrilan cari alanlari yok) sifira duser', () => {
    const s = summarySchema.parse({
      asOf: '2026-11-20',
      cash: 0,
      bank: 0,
      totalFunds: 0,
      receivables: 0,
      advances: 0,
      payables: 0,
      overdue: 0,
      overdueUnitCount: 0,
      pendingUnitCount: 0,
      fundsAccounts: [],
    });
    expect(s.formerReceivables).toBe(0);
    expect(s.formerDebtorCount).toBe(0);
  });
});
