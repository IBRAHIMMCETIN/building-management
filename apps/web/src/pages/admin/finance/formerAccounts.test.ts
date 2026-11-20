import { describe, expect, it } from 'vitest';
import { type FormerAccount, formerAccountSchema } from '@/lib/api/closures';
import { duesPreviewSchema, summarySchema } from '@/lib/api/finance';
import { formerPreset, formerTotals, sortFormer } from './formerAccounts';
import { paymentSchema } from './schemas';
import { vacancyNotes } from './vacancy';

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

describe('bos daire notlari', () => {
  const label = (u: { blockId: string; number: string }) => `${u.blockId}-${u.number}`;
  it('bos ve kaydi olmayan daireler ayri not; 5ten fazlasi kisaltilir', () => {
    expect(vacancyNotes({ vacant: [], unknownOccupancy: [] }, label)).toEqual([]);
    const many = Array.from({ length: 7 }, (_, i) => ({ blockId: 'A', number: String(i + 1) }));
    expect(vacancyNotes({ vacant: many, unknownOccupancy: [{ blockId: 'B', number: '9' }] }, label)).toEqual([
      '7 boş daire kat malikine yazılacak: A-1, A-2, A-3, A-4, A-5 ve 2 daire daha',
      '1 dairede sakin/malik kaydı yok, sakin carisine yazılacak: B-9',
    ]);
  });
  it('eski API yanitinda alanlar bos gelir', () => {
    const p = duesPreviewSchema.parse({ count: 1, totalAmount: 100, distributedAmount: 100, items: [{ unitId: 'u', blockId: 'b', number: '1', amount: 100 }], exempt: [] });
    expect(p.vacant).toEqual([]);
    expect(p.unknownOccupancy).toEqual([]);
  });
});
