import { describe, expect, it } from 'vitest';
import type { Budget } from '@/lib/api/financePeriods';
import { balanceDues, draftFromBudget, draftToInput, lineTotal, splitAnnual } from './budgetDraft';

const budget = {
  budgetId: '2027-r1',
  year: 2027,
  revision: 1,
  status: 'draft',
  lines: [
    { accountId: 'exp-cleaning', kind: 'expense', months: Array(12).fill(10_000) },
    { accountId: 'income-fixtures', kind: 'income', months: Array(12).fill(1_000) },
  ],
  updatedAt: '2026-11-25T00:00:00.000Z',
  version: 1,
  totals: { income: 12_000, expense: 120_000, result: -108_000 },
} as Budget;

const typeOf = (id: string) => (id.startsWith('exp-') ? 'expense' : 'income');

describe('butce taslagi', () => {
  it('yillik tutar API ile ayni bolunur', () => {
    expect(splitAnnual(100_005).slice(0, 10)).toEqual([...Array(9).fill(8334), 8333]);
    expect(lineTotal({ months: splitAnnual(1_234_567) })).toBe(1_234_567);
  });

  it('kayitli butceden taslak ve geri: degisiklik yoksa ayni girdi', () => {
    const d = draftFromBudget(budget);
    expect(d.title).toBe('');
    expect(draftToInput(d)).toEqual({ title: null, lines: budget.lines.map(({ accountId, months }) => ({ accountId, months })), dues: null });
  });

  it('aidat dengeleme: satir yoksa eklenir, gider - diger gelir kadar', () => {
    const d = balanceDues(draftFromBudget(budget), 'income-dues', typeOf);
    expect(d.lines[0]?.accountId).toBe('income-dues');
    expect(lineTotal(d.lines[0] as { months: number[] })).toBe(108_000);
    const again = balanceDues({ ...d, lines: d.lines.map((l) => (l.accountId === 'exp-cleaning' ? { ...l, months: splitAnnual(240_000) } : l)) }, 'income-dues', typeOf);
    expect(again.lines.filter((l) => l.accountId === 'income-dues')).toHaveLength(1);
    expect(lineTotal(again.lines[0] as { months: number[] })).toBe(228_000);
  });

  it('diger gelirler giderleri karsiliyorsa aidat sifir', () => {
    const rich = { ...budget, lines: [...budget.lines, { accountId: 'income-heating', kind: 'income' as const, months: Array(12).fill(20_000) }] };
    expect(lineTotal(balanceDues(draftFromBudget(rich), 'income-dues', typeOf).lines[0] as { months: number[] })).toBe(0);
  });
});
