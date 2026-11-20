import type { FormerAccount } from '@/lib/api/closures';
import type { PaymentPreset } from './PaymentDialog';

/** Siralama: gecikmisler (en eski once), sonra borclular (buyukten), avanslar, kapananlar. */
export function sortFormer(items: readonly FormerAccount[]): FormerAccount[] {
  const rank = (a: FormerAccount) => (a.overdue > 0 ? 0 : a.balance > 0 ? 1 : a.balance < 0 ? 2 : 3);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.daysOverdue - a.daysOverdue ||
      b.balance - a.balance ||
      (a.unitNumber ?? '').localeCompare(b.unitNumber ?? '', 'tr', { numeric: true }) ||
      a.accountId.localeCompare(b.accountId),
  );
}

export function formerTotals(items: readonly FormerAccount[]) {
  return items.reduce(
    (t, a) => ({
      debt: t.debt + Math.max(a.balance, 0),
      debtorCount: t.debtorCount + (a.balance > 0 ? 1 : 0),
      overdue: t.overdue + a.overdue,
      lateFee: t.lateFee + a.lateFee,
    }),
    { debt: 0, debtorCount: 0, overdue: 0, lateFee: 0 },
  );
}

/** "Tahsilat al" kisayolu: tahsilat formu bu cari secili ve borcun tamami yazili acilir. */
export function formerPreset(a: FormerAccount): PaymentPreset {
  return { unitId: a.unitId, liableParty: a.liableParty, accountId: a.accountId, amount: Math.max(a.balance, 0) };
}
