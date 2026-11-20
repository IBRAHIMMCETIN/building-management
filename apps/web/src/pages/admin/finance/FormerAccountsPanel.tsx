import { CircleCheck, HandCoins, Search, UserMinus } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { useFormerAccounts } from '@/hooks/useClosures';
import { useBlocks, usePeople, useUnitPermissions } from '@/hooks/useUnits';
import type { FormerAccount } from '@/lib/api/closures';
import { errorMessage } from '@/lib/api/errors';
import { formatTRY } from '@/lib/money';
import { formatDate } from './format';
import type { PaymentPreset } from './PaymentDialog';
import { formerTotals, formerPreset, sortFormer } from './formerAccounts';

type Props = { canWrite: boolean; onCollect: (preset: PaymentPreset) => void };

function BalanceCell({ a }: { a: FormerAccount }) {
  if (a.balance < 0) return <span className="text-success tabular-nums">{formatTRY(-a.balance)} avans</span>;
  if (a.balance === 0) return <span className="text-muted tabular-nums">Kapandı</span>;
  return <span className="font-semibold tabular-nums">{formatTRY(a.balance)}</span>;
}

function OverdueCell({ a }: { a: FormerAccount }) {
  if (a.overdue <= 0 && a.lateFee <= 0) return <span className="text-muted">—</span>;
  return (
    <span className="text-danger tabular-nums">
      {a.overdue > 0 && formatTRY(a.overdue)}
      {a.overdue > 0 && <span className="block text-small text-muted">{a.daysOverdue} gün</span>}
      {a.lateFee > 0 && (
        <span className="block text-small text-warning" title="İşleyen kıstelyevm gecikme tazminatı; ayın 1'inde cariye yazılır">
          +{formatTRY(a.lateFee)} tazminat
        </span>
      )}
    </span>
  );
}

/**
 * Ayrilan sakin/malik carileri (tasinma kapamasiyla acilan). Eski sakin portala erisemez (v1);
 * tahsilat buradan yonetici tarafindan alinir.
 */
export function FormerAccountsPanel({ canWrite, onCollect }: Props) {
  const [showSettled, setShowSettled] = useState(false);
  const accounts = useFormerAccounts(showSettled);
  const blocks = useBlocks();
  const { canReadResidents } = useUnitPermissions();
  const people = usePeople();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLocaleLowerCase('tr'));

  const blockNames = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.userId, p.fullName])), [people.data]);
  const rows = useMemo(() => sortFormer(accounts.data?.items ?? []), [accounts.data]);
  const totals = useMemo(() => formerTotals(rows), [rows]);

  const unitLabel = (a: FormerAccount) => `${a.blockId ? (blockNames.get(a.blockId) ?? '') : ''} ${a.unitNumber ?? ''}`.trim() || a.unitId;
  const holderNames = (a: FormerAccount) =>
    canReadResidents && a.holder?.userIds.length ? a.holder.userIds.map((u) => names.get(u) ?? 'Adı kayıtlı değil').join(', ') : undefined;
  const visible = rows.filter((a) => {
    if (!deferred) return true;
    const hay = `${unitLabel(a)} ${a.name} ${holderNames(a) ?? ''}`.toLocaleLowerCase('tr');
    return hay.includes(deferred);
  });

  if (accounts.isPending) {
    return (
      <div role="status" aria-label="Ayrılan cariler yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (accounts.isError) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(accounts.error)}</Alert>
        <Button variant="secondary" onClick={() => void accounts.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  }

  const collect = (a: FormerAccount, full = false) =>
    canWrite && a.balance > 0 ? (
      <Button
        variant={full ? 'secondary' : 'ghost'}
        size="sm"
        className={full ? 'mt-3 w-full' : undefined}
        onClick={() => onCollect(formerPreset(a))}
        aria-label={`${unitLabel(a)} ${a.name} için tahsilat al`}
      >
        <HandCoins className="size-4" aria-hidden="true" />
        <span className={full ? undefined : 'hidden lg:inline'}>Tahsilat al</span>
      </Button>
    ) : null;

  const period = (a: FormerAccount) =>
    a.holder ? `${a.holder.periodStart ? `${formatDate(a.holder.periodStart)} – ` : ''}${formatDate(a.holder.periodEnd)}` : undefined;

  return (
    <div className="flex flex-col gap-4">
      {rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-surface-muted px-3 py-2">
            <dt className="text-xs text-muted">Toplam alacak</dt>
            <dd className="font-semibold tabular-nums">{formatTRY(totals.debt)}</dd>
          </div>
          <div className="rounded-lg bg-surface-muted px-3 py-2">
            <dt className="text-xs text-muted">Borçlu cari</dt>
            <dd className="font-semibold tabular-nums">{totals.debtorCount}</dd>
          </div>
          <div className="col-span-2 rounded-lg bg-surface-muted px-3 py-2 sm:col-span-1">
            <dt className="text-xs text-muted">Gecikmede / işleyen tazminat</dt>
            <dd className="font-semibold tabular-nums">
              {formatTRY(totals.overdue)}
              {totals.lateFee > 0 && <span className="text-small font-normal text-warning"> +{formatTRY(totals.lateFee)}</span>}
            </dd>
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-small">
          <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} />
          Kapanmış carileri de göster
        </label>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Ayrılan cari ara"
            placeholder="Daire veya kişi ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <UserMinus className="size-8 text-muted" aria-hidden="true" />
          <p className="font-medium">{showSettled ? 'Henüz ayrılan cari yok' : 'Bakiyesi olan ayrılan cari yok'}</p>
          <p className="max-w-content text-small text-muted">
            Kiracı çıktığında veya daire satıldığında Daireler ekranındaki “Taşınma” ile kapama yapılırsa ayrılan kişinin borcu
            burada ayrı izlenir.
          </p>
        </Card>
      ) : visible.length === 0 ? (
        <p className="flex items-center justify-center gap-2 py-6 text-small text-muted">
          <CircleCheck className="size-4" aria-hidden="true" />
          Aramayla eşleşen cari yok.
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm backdrop-blur-sm md:block">
            <table className="w-full text-left text-small">
              <caption className="sr-only">Ayrılan sakin carileri ({accounts.data.asOf} itibarıyla)</caption>
              <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Daire</th>
                  <th scope="col" className="px-4 py-3 font-medium">Cari / kişi</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Bakiye</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Gecikmiş</th>
                  <th scope="col" className="px-4 py-3 font-medium">Son ödeme</th>
                  {canWrite && (
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">İşlemler</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-text-secondary [&>tr]:transition-colors [&>tr:hover]:bg-surface-muted/40">
                {visible.map((a) => (
                  <tr key={a.accountId} className="align-top">
                    <th scope="row" className="px-4 py-3 font-semibold">
                      {unitLabel(a)}
                    </th>
                    <td className="max-w-64 px-4 py-3">
                      <span className="flex flex-wrap items-center gap-1">
                        {holderNames(a) ?? a.name}
                        <Badge>{a.liableParty === 'owner' ? 'eski malik' : 'ayrılan sakin'}</Badge>
                      </span>
                      {period(a) && <span className="block text-small text-muted">{period(a)}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <BalanceCell a={a} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <OverdueCell a={a} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted">{a.lastPaymentDate ? formatDate(a.lastPaymentDate) : '—'}</td>
                    {canWrite && <td className="px-4 py-2.5 text-right">{collect(a)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col gap-3 md:hidden" aria-label="Ayrılan sakin carileri">
            {visible.map((a) => (
              <li key={a.accountId} className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{unitLabel(a)}</p>
                    <p className="text-small text-muted">{holderNames(a) ?? a.name}</p>
                    {period(a) && <p className="text-small text-muted">{period(a)}</p>}
                  </div>
                  <Badge>{a.liableParty === 'owner' ? 'eski malik' : 'ayrılan sakin'}</Badge>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
                  <dt className="text-muted">Bakiye</dt>
                  <dd className="text-right">
                    <BalanceCell a={a} />
                  </dd>
                  {(a.overdue > 0 || a.lateFee > 0) && (
                    <>
                      <dt className="text-muted">Gecikmiş</dt>
                      <dd className="text-right">
                        <OverdueCell a={a} />
                      </dd>
                    </>
                  )}
                  <dt className="text-muted">Son ödeme</dt>
                  <dd className="text-right">{a.lastPaymentDate ? formatDate(a.lastPaymentDate) : '—'}</dd>
                </dl>
                {collect(a, true)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
