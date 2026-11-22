import { DatabaseZap, HandCoins, PieChart } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useBackfillOwnership, useOwnershipIssues } from '@/hooks/useOwnership';
import { usePeople } from '@/hooks/useUnits';
import { errorMessage } from '@/lib/api/errors';
import type { FinanceAccount } from '@/lib/api/finance';
import type { OwnershipIssue } from '@/lib/api/ownership';
import { formatTRY } from '@/lib/money';
import type { PaymentPreset } from './PaymentDialog';
import { RegisterSharesDialog } from './RegisterSharesDialog';
import { useUnitOptions } from './useUnitOptions';

type Props = { canWrite: boolean; onCollect: (preset: PaymentPreset) => void };

export const ISSUE_LABELS: Record<OwnershipIssue['code'], { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  incomplete_shares: { label: 'Hisse eksik', tone: 'danger' },
  register_mismatch: { label: 'Sicil uyuşmuyor', tone: 'danger' },
  no_owner: { label: 'Malik yok', tone: 'warning' },
  not_registered: { label: 'Sicil yok', tone: 'neutral' },
  no_representative: { label: 'Temsilci yok', tone: 'neutral' },
};

/** Hisse tamamlama akisi gereken sorunlar once (eksik / uyusmazlik), bilgi amacli olanlar sonra. */
export function sortIssues(items: readonly OwnershipIssue[]): OwnershipIssue[] {
  const rank: Record<OwnershipIssue['code'], number> = { incomplete_shares: 0, register_mismatch: 1, no_owner: 2, not_registered: 3, no_representative: 4 };
  return [...items].sort((a, b) => rank[a.code] - rank[b.code] || a.number.localeCompare(b.number, 'tr', { numeric: true }));
}

/** Paydas alt carileri (split faturalama): yalnizca aktif `coOwner` hesaplari. */
export function coOwnerAccounts(accounts: readonly FinanceAccount[]): (FinanceAccount & { unitId: string; coOwner: { userId: string } })[] {
  return accounts
    .filter((a): a is FinanceAccount & { unitId: string; coOwner: { userId: string } } => a.type === 'receivable' && !!a.coOwner && !!a.unitId)
    .sort((a, b) => a.unitId.localeCompare(b.unitId) || b.balance - a.balance);
}

/**
 * Finans > "Paydaşlar / hisse": hisse tamligi eksik daireler (ve tamamlama), ilk sicil gecisi,
 * paydas alt carileri ve tahsilat.
 */
export function OwnershipPanel({ canWrite, onCollect }: Props) {
  const issues = useOwnershipIssues();
  const accounts = useFinanceAccounts('receivable');
  const people = usePeople();
  const backfill = useBackfillOwnership();
  const { options } = useUnitOptions();
  const [editing, setEditing] = useState<{ unitId: string; label: string } | null>(null);

  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.userId, p.fullName])), [people.data]);
  const unitLabel = useMemo(() => new Map(options.map((o) => [o.unitId, o.label])), [options]);
  const list = sortIssues(issues.data?.items ?? []);
  const actionable = list.filter((i) => i.code === 'incomplete_shares' || i.code === 'register_mismatch');
  const info = list.filter((i) => i.code !== 'incomplete_shares' && i.code !== 'register_mismatch');
  const coOwners = coOwnerAccounts(accounts.data ?? []);
  const label = (unitId: string, number?: string) => unitLabel.get(unitId) ?? number ?? unitId;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="issues-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="issues-title" className="flex items-center gap-2 font-semibold">
            <PieChart className="size-4 text-muted" aria-hidden="true" />
            Hisse tamlığı eksik daireler
          </h2>
          {canWrite && (
            <Button size="sm" variant="secondary" loading={backfill.isPending} onClick={() => void backfill.mutateAsync().catch(() => undefined)}>
              <DatabaseZap className="size-4" aria-hidden="true" />
              İlk sicil geçişini çalıştır
            </Button>
          )}
        </div>
        {backfill.data && (
          <Alert tone="success">
            {backfill.data.created.length} dairenin sicili oluşturuldu
            {backfill.data.skipped.length > 0 && `; ${backfill.data.skipped.length} daire hisse bilgisi eksik olduğu için atlandı`}.
          </Alert>
        )}
        {backfill.isError && <Alert tone="danger">{errorMessage(backfill.error)}</Alert>}
        {issues.isPending && <Skeleton className="h-16 w-full" />}
        {issues.isError && <Alert tone="danger">{errorMessage(issues.error)}</Alert>}
        {issues.isSuccess && actionable.length === 0 && <p className="text-small text-muted">Tüm dairelerde paylar tam.</p>}
        {actionable.length > 0 && (
          <ul className="flex flex-col gap-2">
            {actionable.map((i) => (
              <li key={`${i.unitId}-${i.code}`}>
                <Card className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      {label(i.unitId, i.number)}
                      <Badge tone={ISSUE_LABELS[i.code].tone}>{ISSUE_LABELS[i.code].label}</Badge>
                    </p>
                    <p className="text-small text-muted">{i.message}</p>
                  </div>
                  {canWrite && (
                    <Button size="sm" onClick={() => setEditing({ unitId: i.unitId, label: label(i.unitId, i.number) })}>
                      Hisseleri tamamla
                    </Button>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
        {info.length > 0 && (
          <details className="text-small">
            <summary className="cursor-pointer text-muted">Diğer bilgiler ({info.length})</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {info.map((i) => (
                <li key={`${i.unitId}-${i.code}`} className="flex flex-wrap items-center gap-2">
                  <span>{label(i.unitId, i.number)}</span>
                  <Badge tone={ISSUE_LABELS[i.code].tone}>{ISSUE_LABELS[i.code].label}</Badge>
                  <span className="text-muted">{i.message}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="coowners-title">
        <h2 id="coowners-title" className="font-semibold">
          Paydaş carileri
        </h2>
        {accounts.isPending && <Skeleton className="h-16 w-full" />}
        {accounts.isSuccess && coOwners.length === 0 && (
          <p className="text-small text-muted">“Paydaş carileri” faturalama modundaki dairelerde malik tahakkukları paydaşlara bölünür; şu an böyle bir cari yok.</p>
        )}
        {coOwners.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-small">
              <caption className="sr-only">Paydaş alt carileri</caption>
              <thead className="bg-surface-muted/50 text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Daire</th>
                  <th scope="col" className="px-3 py-2 font-medium">Paydaş</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Bakiye</th>
                  {canWrite && <th scope="col" className="px-3 py-2"><span className="sr-only">İşlem</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {coOwners.map((a) => (
                  <tr key={a.accountId}>
                    <td className="px-3 py-2">{label(a.unitId)}</td>
                    <td className="px-3 py-2">{names.get(a.coOwner.userId) ?? 'Paydaş'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {a.balance > 0 ? formatTRY(a.balance) : a.balance < 0 ? <span className="text-success">{formatTRY(-a.balance)} avans</span> : <span className="text-muted">—</span>}
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onCollect({ unitId: a.unitId, liableParty: 'owner', accountId: a.accountId, ...(a.balance > 0 ? { amount: a.balance } : {}) })}
                        >
                          <HandCoins className="size-4" aria-hidden="true" />
                          Tahsilat
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canWrite && editing && (
        <RegisterSharesDialog open unitId={editing.unitId} unitLabel={editing.label} names={names} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
