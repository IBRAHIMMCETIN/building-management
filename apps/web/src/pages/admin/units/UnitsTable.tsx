import { ShieldMinus, UserPlus } from 'lucide-react';
import { Badge, Button, Skeleton } from '@/components/ui';
import { expenseCategoryLabel } from '@/lib/api/finance';
import { UNIT_TYPE_LABELS } from '@/lib/api/units';
import { type RowParty, type UnitRow, formatFloor, formatLandShare, landSharePercent } from './unitRows';

type Props = {
  rows: UnitRow[];
  showResidents: boolean;
  canManage: boolean;
  onInvite: (row: UnitRow) => void;
  onExemptions: (row: UnitRow) => void;
};

function Parties({ parties, empty = '—' }: { parties: RowParty[]; empty?: string }) {
  if (parties.length === 0) return <span className="text-muted">{empty}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {parties.map((p) => (
        <li key={p.userId} className="truncate" title={p.share ? `${p.name} (${p.share})` : p.name}>
          {p.name}
          {p.share && <span className="text-muted"> ({p.share})</span>}
        </li>
      ))}
    </ul>
  );
}

function Occupancy({ value }: { value: UnitRow['occupancy'] }) {
  if (value === 'unknown') return <span className="text-muted">—</span>;
  return value === 'occupied' ? <Badge tone="success">Dolu</Badge> : <Badge>Boş</Badge>;
}

function LandShare({ row }: { row: UnitRow }) {
  const percent = landSharePercent(row.unit.landShare);
  return (
    <span title={percent} className="tabular-nums">
      {formatLandShare(row.unit.landShare)}
      {percent && <span className="block text-small text-muted">{percent}</span>}
    </span>
  );
}

const unitLabel = (row: UnitRow) => `${row.blockName} ${row.unit.number}`;

/** "Muaf: Asansör, Havuz" ya da muafiyet yoksa null. */
function exemptionText(row: UnitRow): string | null {
  const list = row.unit.exemptions.map((e) => expenseCategoryLabel(e.expenseCategory));
  return list.length ? `Muaf: ${list.join(', ')}` : null;
}

/** md ve ustu: tablo. Alti: kart listesi (yatay kaydirma yerine okunabilir satirlar). */
export function UnitsTable({ rows, showResidents, canManage, onInvite, onExemptions }: Props) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm backdrop-blur-sm md:block">
        <table className="w-full text-left text-small">
          <caption className="sr-only">Daireler</caption>
          <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Daire No</th>
              <th scope="col" className="px-4 py-3 font-medium">Blok / Kat</th>
              <th scope="col" className="px-4 py-3 font-medium">Arsa Payı</th>
              {showResidents && (
                <>
                  <th scope="col" className="px-4 py-3 font-medium">Durum</th>
                  <th scope="col" className="px-4 py-3 font-medium">Aktif Malik</th>
                  <th scope="col" className="px-4 py-3 font-medium">Aktif Kiracı</th>
                </>
              )}
              {canManage && (
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">İşlemler</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-text-secondary [&>tr]:transition-colors [&>tr:hover]:bg-surface-muted/40">
            {rows.map((row) => (
              <tr key={row.unit.unitId} className="align-top hover:bg-surface-muted/50">
                <th scope="row" className="px-4 py-3 font-semibold">
                  {row.unit.number}
                  <span className="block text-small font-normal text-muted">{UNIT_TYPE_LABELS[row.unit.type]}</span>
                  {exemptionText(row) && <span className="block text-small font-normal text-muted">{exemptionText(row)}</span>}
                </th>
                <td className="px-4 py-3">
                  {row.blockName}
                  <span className="block text-muted">{formatFloor(row.unit.floor)}</span>
                </td>
                <td className="px-4 py-3">
                  <LandShare row={row} />
                </td>
                {showResidents && (
                  <>
                    <td className="px-4 py-3">
                      <Occupancy value={row.occupancy} />
                    </td>
                    <td className="max-w-48 px-4 py-3">
                      <Parties parties={row.owners} />
                    </td>
                    <td className="max-w-48 px-4 py-3">
                      <Parties parties={row.tenants} />
                    </td>
                  </>
                )}
                {canManage && (
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onExemptions(row)} aria-label={`${unitLabel(row)} muafiyetleri`}>
                        <ShieldMinus className="size-4" aria-hidden="true" />
                        <span className="hidden lg:inline">Muafiyetler</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onInvite(row)} aria-label={`${unitLabel(row)} için sakin davet et`}>
                        <UserPlus className="size-4" aria-hidden="true" />
                        <span className="hidden lg:inline">Davet et</span>
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden" aria-label="Daireler">
        {rows.map((row) => (
          <li key={row.unit.unitId} className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">
                  {row.blockName} · Daire {row.unit.number}
                </p>
                <p className="text-small text-muted">
                  {UNIT_TYPE_LABELS[row.unit.type]} · {formatFloor(row.unit.floor)} · Arsa payı {formatLandShare(row.unit.landShare)}
                </p>
                {exemptionText(row) && <p className="text-small text-muted">{exemptionText(row)}</p>}
              </div>
              {showResidents && <Occupancy value={row.occupancy} />}
            </div>
            {showResidents && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
                <dt className="text-muted">Malik</dt>
                <dd className="min-w-0">
                  <Parties parties={row.owners} />
                </dd>
                <dt className="text-muted">Kiracı</dt>
                <dd className="min-w-0">
                  <Parties parties={row.tenants} />
                </dd>
              </dl>
            )}
            {canManage && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button variant="secondary" size="sm" onClick={() => onExemptions(row)}>
                  <ShieldMinus className="size-4" aria-hidden="true" />
                  Muafiyetler
                </Button>
                <Button variant="secondary" size="sm" onClick={() => onInvite(row)}>
                  <UserPlus className="size-4" aria-hidden="true" />
                  Sakin davet et
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function UnitsTableSkeleton({ showResidents }: { showResidents: boolean }) {
  const cols = showResidents ? 6 : 3;
  return (
    <div role="status" aria-label="Daireler yükleniyor">
      <div className="hidden rounded-xl border border-border bg-surface/60 shadow-sm backdrop-blur-sm md:block">
        <div className="flex gap-6 border-b border-border bg-surface-muted px-4 py-3">
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {Array.from({ length: 6 }, (_, r) => (
          <div key={r} className="flex gap-6 border-b border-border px-4 py-4 last:border-0">
            {Array.from({ length: cols }, (_, i) => (
              <Skeleton key={i} className="h-4 flex-1" style={{ opacity: 1 - r * 0.12 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
      <span className="sr-only">Daireler yükleniyor…</span>
    </div>
  );
}
