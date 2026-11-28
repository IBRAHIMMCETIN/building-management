import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { isNoMembership, mergeStatement, type MyStatement, unitChoicesFrom } from './portal';

const row = (date: string, id: string, over: Partial<MyStatement['accounts'][number]['entries'][number]> = {}) => ({
  date,
  transactionId: id,
  entryType: 'ACCRUAL' as const,
  description: 'Aidat',
  debit: 100,
  credit: 0,
  balance: 100,
  ...over,
});

describe('mergeStatement', () => {
  it('malik + sakin carilerini birlestirir, en yeni once siralar', () => {
    const merged = mergeStatement({
      unitId: 'u1',
      period: { from: '2026-01-01', to: '2026-11-08' },
      closingBalance: 0,
      accounts: [
        { liableParty: 'owner', label: 'Malik', openingBalance: 0, totalDebit: 0, totalCredit: 0, closingBalance: 0, entries: [row('2026-10-01', '20261001-a')] },
        {
          liableParty: 'occupant',
          label: 'Sakin',
          openingBalance: 0,
          totalDebit: 0,
          totalCredit: 0,
          closingBalance: 0,
          entries: [row('2026-11-01', '20261101-b'), row('2026-11-05', '20261105-c', { entryType: 'COLLECTION', receiptNumber: 'MKB-000001' })],
        },
      ],
    });
    expect(merged.map((r) => [r.transactionId, r.liableParty])).toEqual([
      ['20261105-c', 'occupant'],
      ['20261101-b', 'occupant'],
      ['20261001-a', 'owner'],
    ]);
  });
});

describe('hata yorumlama', () => {
  it('daire secimi: etiketli liste, yoksa kimliklerden yedek', () => {
    const labeled = new ApiError(400, { error: 'unit_selection_required', units: [{ unitId: 'u2', label: 'A Blok · 2' }], unitIds: ['u2'] });
    expect(unitChoicesFrom(labeled)).toEqual([{ unitId: 'u2', label: 'A Blok · 2' }]);
    const legacy = new ApiError(400, { error: 'unit_selection_required', unitIds: ['u3'] });
    expect(unitChoicesFrom(legacy)).toEqual([{ unitId: 'u3', label: 'u3' }]);
    expect(unitChoicesFrom(new ApiError(400, { error: 'validation_error' }))).toBeNull();
  });

  it('403 = aktif uyelik yok', () => {
    expect(isNoMembership(new ApiError(403, { error: 'forbidden' }))).toBe(true);
    expect(isNoMembership(new ApiError(500))).toBe(false);
  });
});
