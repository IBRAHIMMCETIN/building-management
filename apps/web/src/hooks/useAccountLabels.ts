import { useMemo } from 'react';
import type { FinanceAccount } from '@/lib/api/finance';
import { type AccountLabelContext, formatLedgerAccountLabel, sanitizeLedgerText } from '@/lib/finance/accountLabel';
import { useFinanceAccounts } from './useFinance';
import { useBlocks, usePeople, useUnits } from './useUnits';

/**
 * Finans ekranlarinin ortak cari etiket cozucusu (UX-01). Daire (pasif olanlar dahil: ayrilan /
 * eski cariler), blok ve kisi listelerinden `formatLedgerAccountLabel` baglamini kurar.
 * Kisi listesi yetkisi olmayan rolde (bina gorevlisi) paydas adi yerine "Kat Maliki" yazilir.
 */
export function useAccountLabels() {
  const units = useUnits();
  const blocks = useBlocks();
  const people = usePeople();
  const accounts = useFinanceAccounts('receivable');

  return useMemo(() => {
    const blockName = new Map((blocks.data ?? []).map((b) => [b.blockId, b.name]));
    const unitLabels = new Map(
      (units.data?.items ?? []).map((u) => {
        const block = blockName.get(u.blockId);
        return [u.unitId, block ? `${block} · ${u.number}` : u.number] as const;
      }),
    );
    const names = new Map((people.data ?? []).map((p) => [p.userId, p.fullName]));
    const byId = new Map((accounts.data ?? []).map((a) => [a.accountId, a]));
    const ctx: AccountLabelContext = { unitLabel: (id) => unitLabels.get(id), personName: (id) => names.get(id) };
    return {
      ctx,
      /** Hesap nesnesinden etiket. */
      label: (account: FinanceAccount | undefined) => formatLedgerAccountLabel(account, ctx),
      /** Kimlikten etiket (aktif alacak hesaplari arasinda aranir). */
      labelOf: (accountId: string) => formatLedgerAccountLabel(byId.get(accountId), ctx),
      unitLabel: (unitId: string | undefined, fallback?: string) => (unitId ? (unitLabels.get(unitId) ?? fallback ?? 'Daire') : (fallback ?? '')),
      text: (value: string) => sanitizeLedgerText(value, ctx),
      accountById: byId,
    };
  }, [units.data, blocks.data, people.data, accounts.data]);
}
