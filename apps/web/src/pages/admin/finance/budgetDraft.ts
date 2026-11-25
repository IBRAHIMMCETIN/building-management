import type { Budget, BudgetInput } from '@/lib/api/financePeriods';

/** Duzenlenen butce satiri: aylik kurus tutarlari + yillik tutar kutusunun ham metni. */
export type DraftLine = { accountId: string; months: number[]; annualText: string; note?: string };
export type BudgetDraft = { title: string; lines: DraftLine[]; dues: Budget['dues'] | null };

/** API ile ayni: yillik tutar 12 aya esit, kalan kuruslar ilk aylara. */
export function splitAnnual(annual: number): number[] {
  const base = Math.floor(annual / 12);
  const rest = annual - base * 12;
  return Array.from({ length: 12 }, (_, i) => base + (i < rest ? 1 : 0));
}

export const lineTotal = (l: { months: number[] }) => l.months.reduce((s, v) => s + v, 0);

export function draftFromBudget(b: Budget): BudgetDraft {
  return {
    title: b.title ?? '',
    lines: b.lines.map((l) => ({ accountId: l.accountId, months: [...l.months], annualText: '', ...(l.note ? { note: l.note } : {}) })),
    dues: b.dues ?? null,
  };
}

export function draftToInput(d: BudgetDraft): BudgetInput {
  return {
    title: d.title.trim() || null,
    lines: d.lines.map((l) => ({ accountId: l.accountId, months: l.months, ...(l.note ? { note: l.note } : {}) })),
    dues: d.dues,
  };
}

/**
 * Aidat satirini dengeler: gider toplami - aidat disindaki gelirler (negatifse 0), 12 aya esit.
 * Aidat satiri yoksa eklenir.
 */
export function balanceDues(d: BudgetDraft, duesAccountId: string, typeOf: (accountId: string) => string | undefined): BudgetDraft {
  const expense = d.lines.filter((l) => typeOf(l.accountId) === 'expense').reduce((s, l) => s + lineTotal(l), 0);
  const otherIncome = d.lines.filter((l) => typeOf(l.accountId) === 'income' && l.accountId !== duesAccountId).reduce((s, l) => s + lineTotal(l), 0);
  const months = splitAnnual(Math.max(expense - otherIncome, 0));
  const exists = d.lines.some((l) => l.accountId === duesAccountId);
  return {
    ...d,
    lines: exists
      ? d.lines.map((l) => (l.accountId === duesAccountId ? { ...l, months, annualText: '' } : l))
      : [{ accountId: duesAccountId, months, annualText: '' }, ...d.lines],
  };
}
