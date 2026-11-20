import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import type { OpenDue, PartyQuote, PaymentQuote } from '@/lib/api/payments';
import {
  isSelected,
  isValidTckn,
  normalizeGsm,
  receiptCount,
  selectedItems,
  selectedTotal,
  toggleItem,
} from './selection';

const due = (id: string, party: 'owner' | 'occupant', remaining: number): OpenDue => ({
  transactionId: id,
  liableParty: party,
  description: id,
  date: '2026-09-01',
  dueDate: '2026-09-10',
  amount: remaining,
  paid: 0,
  remaining,
  overdue: false,
  daysOverdue: 0,
});

const partyQuote = (party: 'owner' | 'occupant', items: OpenDue[], totalDue: number): PartyQuote => ({
  liableParty: party,
  balance: totalDue,
  debt: totalDue,
  advance: 0,
  accruedLateFee: 0,
  totalDue,
  items,
  postedLateFees: [],
});

const quote: PaymentQuote = {
  unitId: 'u1',
  currency: 'TRY',
  onlinePaymentEnabled: true,
  requiresGsmNumber: false,
  asOf: '2026-11-20',
  lateFeeMonthlyBasisPoints: 500,
  parties: [
    partyQuote('occupant', [due('a1', 'occupant', 100_00), due('a2', 'occupant', 150_00), due('a3', 'occupant', 200_00)], 450_00),
    partyQuote('owner', [due('d1', 'owner', 1_000_00)], 1_000_00),
  ],
  totalDue: 1_450_00,
};

describe('kalem secimi (en eski vadeden kesintisiz)', () => {
  it('bir kalemi secmek oncekileri de secer', () => {
    const sel = toggleItem({}, 'occupant', 1, true);
    expect(isSelected(sel, 'occupant', 0)).toBe(true);
    expect(isSelected(sel, 'occupant', 1)).toBe(true);
    expect(isSelected(sel, 'occupant', 2)).toBe(false);
  });

  it('bir kalemi kaldirmak sonrakileri de kaldirir', () => {
    const sel = toggleItem({ occupant: 3 }, 'occupant', 1, false);
    expect(sel.occupant).toBe(1);
  });

  it('daha eski secimin altina inmez / cari bagimsizdir', () => {
    expect(toggleItem({ occupant: 3 }, 'occupant', 0, true).occupant).toBe(3);
    expect(toggleItem({ occupant: 2 }, 'owner', 0, true)).toEqual({ occupant: 2, owner: 1 });
  });

  it('secilen kalemler, toplam ve makbuz sayisi', () => {
    const sel = { occupant: 2, owner: 1 };
    expect(selectedItems(quote, sel)).toEqual([
      { liableParty: 'occupant', transactionId: 'a1' },
      { liableParty: 'occupant', transactionId: 'a2' },
      { liableParty: 'owner', transactionId: 'd1' },
    ]);
    expect(selectedTotal(quote, sel)).toBe(1_250_00);
    expect(receiptCount(quote, 'items', sel)).toBe(2);
    expect(receiptCount(quote, 'items', { occupant: 1 })).toBe(1);
    expect(receiptCount(quote, 'total', {})).toBe(2);
    expect(selectedTotal(quote, {})).toBe(0);
  });
});

describe('alici bilgisi', () => {
  it('telefon normalize', () => {
    expect(normalizeGsm('0532 123 45 67')).toBe('+905321234567');
    expect(normalizeGsm('5321234567')).toBe('+905321234567');
    expect(normalizeGsm('+90 (532) 123-45-67')).toBe('+905321234567');
    expect(normalizeGsm('0212 123 45 67')).toBeNull();
    expect(normalizeGsm('053212345')).toBeNull();
  });

  it('TC kimlik kontrol haneleri', () => {
    expect(isValidTckn('10000000146')).toBe(true);
    expect(isValidTckn('10000000147')).toBe(false);
    expect(isValidTckn('01000000146')).toBe(false);
    expect(isValidTckn('1000000014')).toBe(false);
  });
});
