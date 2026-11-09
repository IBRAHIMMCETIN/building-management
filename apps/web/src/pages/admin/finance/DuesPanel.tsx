import { CircleCheck, HandCoins, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, FilterChips, Input, Skeleton } from '@/components/ui';
import { useDuesStatus } from '@/hooks/useFinance';
import { useBlocks } from '@/hooks/useUnits';
import { errorMessage } from '@/lib/api/errors';
import { DUES_STATUS_LABELS, type DuesStatus, type UnitDues } from '@/lib/api/finance';
import { formatTRY } from '@/lib/money';
import { formatDate } from './format';
import type { PaymentPreset } from './PaymentDialog';

type Filter = 'all' | 'overdue' | 'pending' | 'paid';

const STATUS_TONE: Record<DuesStatus, 'warning' | 'accent' | 'success' | 'neutral'> = {
  overdue: 'warning',
  pending: 'accent',
  paid: 'success',
  advance: 'success',
  none: 'neutral',
};

const STATUS_ORDER: Record<DuesStatus, number> = { overdue: 0, pending: 1, advance: 2, paid: 3, none: 4 };

function StatusBadge({ row }: { row: UnitDues }) {
  return <Badge tone={STATUS_TONE[row.status]}>{DUES_STATUS_LABELS[row.status]}</Badge>;
}

function Balance({ row }: { row: UnitDues }) {
  if (row.balance < 0) return <span className="text-success tabular-nums">{formatTRY(-row.balance)} avans</span>;
  if (row.balance === 0) return <span className="text-muted tabular-nums">{formatTRY(0)}</span>;
  return <span className="font-semibold tabular-nums">{formatTRY(row.balance)}</span>;
}

function Overdue({ row }: { row: UnitDues }) {
  if (row.overdue <= 0 && row.lateFee <= 0) return <span className="text-muted">—</span>;
  return (
    <span className="text-danger tabular-nums">
      {row.overdue > 0 && formatTRY(row.overdue)}
      {row.overdue > 0 && <span className="block text-small text-muted">{row.daysOverdue} gün</span>}
      {row.lateFee > 0 && (
        <span className="block text-small text-warning" title="İşleyen kıstelyevm gecikme tazminatı; ayın 1'inde cariye yazılır">
          +{formatTRY(row.lateFee)} tazminat
        </span>
      )}
    </span>
  );
}

/** Tahsil edilecek varsayilan taraf: borcu olan taraf (once sakin). */
function presetFor(row: UnitDues): PaymentPreset {
  const party = row.occupant.balance > 0 || row.owner.balance <= 0 ? 'occupant' : 'owner';
  return { unitId: row.unitId, liableParty: party, amount: Math.max(row[party].balance, 0) };
}

type Props = { canWrite: boolean; onCollect: (preset: PaymentPreset) => void };

export function DuesPanel({ canWrite, onCollect }: Props) {
  const dues = useDuesStatus();
  const blocks = useBlocks();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLocaleLowerCase('tr'));

  const blockNames = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const rows = useMemo(
    () =>
      [...(dues.data?.items ?? [])].sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.overdue - a.overdue || a.unitNumber.localeCompare(b.unitNumber, 'tr', { numeric: true }),
      ),
    [dues.data],
  );
  const counts = useMemo(() => {
    const c = { overdue: 0, pending: 0, paid: 0 };
    for (const r of rows) {
      if (r.status === 'overdue') c.overdue++;
      else if (r.status === 'pending') c.pending++;
      else if (r.status === 'paid' || r.status === 'advance') c.paid++;
    }
    return c;
  }, [rows]);

  const label = (r: UnitDues) => `${blockNames.get(r.blockId) ?? ''} ${r.unitNumber}`.trim();
  const visible = rows.filter((r) => {
    if (filter === 'overdue' && r.status !== 'overdue') return false;
    if (filter === 'pending' && r.status !== 'pending') return false;
    if (filter === 'paid' && r.status !== 'paid' && r.status !== 'advance') return false;
    return !deferred || label(r).toLocaleLowerCase('tr').includes(deferred);
  });

  if (dues.isPending) {
    return (
      <div role="status" aria-label="Aidat durumu yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (dues.isError) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(dues.error)}</Alert>
        <Button variant="secondary" onClick={() => void dues.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <HandCoins className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">Aktif daire yok</p>
        <p className="text-small text-muted">Önce Daireler ekranından bağımsız bölümleri ekleyin.</p>
      </Card>
    );
  }

  const collectButton = (r: UnitDues, full = false) =>
    canWrite && r.balance > 0 ? (
      <Button
        variant={full ? 'secondary' : 'ghost'}
        size="sm"
        className={full ? 'mt-3 w-full' : undefined}
        onClick={() => onCollect(presetFor(r))}
        aria-label={`${label(r)} için tahsilat ekle`}
      >
        <HandCoins className="size-4" aria-hidden="true" />
        <span className={full ? undefined : 'hidden lg:inline'}>Tahsil et</span>
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChips<Filter>
          label="Aidat durumu"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Tümü', count: rows.length },
            { value: 'overdue', label: 'Gecikmede', count: counts.overdue },
            { value: 'pending', label: 'Bekliyor', count: counts.pending },
            { value: 'paid', label: 'Ödendi', count: counts.paid },
          ]}
        />
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input type="search" aria-label="Daire ara" placeholder="Daire ara…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="flex items-center justify-center gap-2 py-6 text-small text-muted">
          <CircleCheck className="size-4" aria-hidden="true" />
          Bu filtrede daire yok.
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface md:block">
            <table className="w-full text-left text-small">
              <caption className="sr-only">Daire bazlı aidat durumu ({dues.data.asOf} itibarıyla)</caption>
              <thead className="border-b border-border bg-surface-muted text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Daire</th>
                  <th scope="col" className="px-4 py-3 font-medium">Durum</th>
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
              <tbody className="divide-y divide-border">
                {visible.map((r) => (
                  <tr key={r.unitId} className="align-top">
                    <th scope="row" className="px-4 py-3 font-semibold">
                      {label(r)}
                    </th>
                    <td className="px-4 py-3">
                      <StatusBadge row={r} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Balance row={r} />
                      {r.owner.balance > 0 && r.occupant.balance > 0 && (
                        <span className="block text-small text-muted">
                          Sakin {formatTRY(r.occupant.balance)} · Malik {formatTRY(r.owner.balance)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Overdue row={r} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted">{r.lastPaymentDate ? formatDate(r.lastPaymentDate) : '—'}</td>
                    {canWrite && <td className="px-4 py-2.5 text-right">{collectButton(r)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col gap-3 md:hidden" aria-label="Aidat durumu">
            {visible.map((r) => (
              <li key={r.unitId} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold">{label(r)}</p>
                  <StatusBadge row={r} />
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
                  <dt className="text-muted">Bakiye</dt>
                  <dd className="text-right">
                    <Balance row={r} />
                  </dd>
                  {r.overdue > 0 && (
                    <>
                      <dt className="text-muted">Gecikmiş</dt>
                      <dd className="text-right">
                        <Overdue row={r} />
                      </dd>
                    </>
                  )}
                  <dt className="text-muted">Son ödeme</dt>
                  <dd className="text-right">{r.lastPaymentDate ? formatDate(r.lastPaymentDate) : '—'}</dd>
                </dl>
                {collectButton(r, true)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
