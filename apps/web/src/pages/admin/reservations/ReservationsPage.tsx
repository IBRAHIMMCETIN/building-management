import { CalendarDays, Pencil, Plus, Power } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { useFacilities, useFacilityStatus, usePendingBookings, useReservationPermissions } from '@/hooks/useReservations';
import { useBlocks, useUnits } from '@/hooks/useUnits';
import { errorMessage } from '@/lib/api/errors';
import type { Booking, Facility } from '@/lib/api/reservations';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { formatMinutes, hoursSummary } from '@/lib/reservations/model';
import { BookingCalendar } from './BookingCalendar';
import { BookingDialog } from './BookingDialog';
import { FacilityDialog } from './FacilityDialog';

const TABS = [
  { id: 'calendar', label: 'Takvim' },
  { id: 'pending', label: 'Onay bekleyenler' },
  { id: 'facilities', label: 'Ortak alanlar' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * "Rezervasyonlar": ortak alan takvimi (gun / hafta), onay kuyrugu ve alan tanimlari.
 * Denetci salt okur. Sekme `?tab=` ile paylasilabilir.
 */
export function ReservationsPage() {
  const { canRead, canWrite } = useReservationPermissions();
  const [params, setParams] = useSearchParams();
  const facilities = useFacilities();
  const pending = usePendingBookings();
  const units = useUnits();
  const blocks = useBlocks();
  const [editor, setEditor] = useState<{ facility?: Facility } | null>(null);
  const [selected, setSelected] = useState<Booking | null>(null);
  const tab: TabId = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'calendar';

  const unitLabel = useMemo(() => {
    const blockNames = new Map((blocks.data ?? []).map((b) => [b.blockId, b.name]));
    const map = new Map((units.data?.items ?? []).map((u) => [u.unitId, blockNames.size > 1 && blockNames.has(u.blockId) ? `${blockNames.get(u.blockId)} · Daire ${u.number}` : `Daire ${u.number}`]));
    return (id: string) => map.get(id) ?? `Daire ${id}`;
  }, [units.data, blocks.data]);
  const activeBlocks = (blocks.data ?? []).filter((b) => b.status === 'active');

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Rezervasyonlar</h1>
        <Alert>Bu rol rezervasyonları görüntüleyemez.</Alert>
      </div>
    );
  }

  const pendingCount = pending.data?.total ?? 0;
  const setTab = (id: TabId) => {
    const next = new URLSearchParams(params);
    if (id === 'calendar') next.delete('tab');
    else next.set('tab', id);
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Rezervasyonlar</h1>
          <p className="text-small text-muted">Ortak alanlar, rezervasyon takvimi ve onay bekleyen talepler.</p>
        </div>
        {canWrite && (
          <Button onClick={() => setEditor({})}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni ortak alan
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <div role="tablist" aria-label="Rezervasyon görünümü" className="flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-4 py-2 text-small font-medium text-muted hover:text-text',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                tab === t.id && 'border-accent text-accent',
              )}
            >
              {t.label}
              {t.id === 'pending' && pendingCount > 0 && <Badge tone="warning">{pendingCount}</Badge>}
            </button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {facilities.isPending ? (
            <Skeleton className="h-40" />
          ) : facilities.isError ? (
            <Alert tone="danger">{errorMessage(facilities.error)}</Alert>
          ) : (facilities.data ?? []).length === 0 ? (
            <Card className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
                <CalendarDays className="size-6" aria-hidden="true" />
              </div>
              <p className="font-semibold">Henüz ortak alan tanımlanmadı</p>
              <p className="max-w-content text-small text-muted">Toplantı salonu, spor salonu, tenis kortu gibi alanları tanımlayın; sakinler portaldan boş saatleri görüp rezervasyon yapsın.</p>
              {canWrite && (
                <Button variant="secondary" onClick={() => setEditor({})}>
                  İlk ortak alanı tanımlayın
                </Button>
              )}
            </Card>
          ) : (
            <>
              {tab === 'calendar' && <BookingCalendar facilities={facilities.data ?? []} unitLabel={unitLabel} onOpen={setSelected} />}
              {tab === 'pending' && <PendingPanel query={pending} unitLabel={unitLabel} onOpen={setSelected} />}
              {tab === 'facilities' && <FacilitiesPanel items={facilities.data ?? []} canWrite={canWrite} blockName={(id) => activeBlocks.find((b) => b.blockId === id)?.name ?? 'Blok'} onEdit={(f) => setEditor({ facility: f })} />}
            </>
          )}
        </div>
      </div>

      <BookingDialog booking={selected} unitLabel={unitLabel} canWrite={canWrite} onClose={() => setSelected(null)} />
      {canWrite && <FacilityDialog open={editor !== null} onClose={() => setEditor(null)} facility={editor?.facility} blocks={activeBlocks} />}
    </div>
  );
}

function PendingPanel({ query, unitLabel, onOpen }: { query: ReturnType<typeof usePendingBookings>; unitLabel: (id: string) => string; onOpen: (b: Booking) => void }) {
  if (query.isPending) return <Skeleton className="h-40" />;
  if (query.isError) return <Alert tone="danger">{errorMessage(query.error)}</Alert>;
  const items = query.data.items;
  if (!items.length) return <p className="py-10 text-center text-small text-muted">Onay bekleyen rezervasyon yok.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((b) => (
        <li key={b.bookingId}>
          <button
            type="button"
            onClick={() => onOpen(b)}
            className={cn(
              'flex w-full flex-col gap-1 rounded-xl border bg-surface p-3 text-left text-small shadow-xs hover:border-border-strong',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              b.fee.error ? 'border-danger/40' : 'border-border',
            )}
          >
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{b.facilityName}</span>
              <span className="text-muted">
                {formatDate(b.date)} · {b.startTime}–{b.endTime}
              </span>
              {b.fee.amount > 0 && <Badge tone="accent">{formatTRY(b.fee.amount)}</Badge>}
            </span>
            <span className="text-xs text-muted">{unitLabel(b.unitId)}{b.partySize ? ` · ${b.partySize} kişi` : ''}</span>
            {b.fee.error && <span className="text-xs text-danger">{b.fee.error}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FacilitiesPanel({ items, canWrite, blockName, onEdit }: { items: Facility[]; canWrite: boolean; blockName: (id: string) => string; onEdit: (f: Facility) => void }) {
  const status = useFacilityStatus();
  return (
    <div className="flex flex-col gap-3">
      {status.isError && <Alert tone="danger">{errorMessage(status.error)}</Alert>}
      <ul className="grid gap-3 md:grid-cols-2">
        {items.map((f) => (
          <li key={f.facilityId}>
            <Card className={cn('flex h-full flex-col gap-2', f.status === 'inactive' && 'opacity-70')}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 font-semibold break-words">{f.name}</h2>
                <span className="flex flex-wrap gap-1.5">
                  {f.status === 'inactive' && <Badge>Pasif</Badge>}
                  {f.requiresApproval && <Badge tone="warning">Onaylı</Badge>}
                  <Badge tone={f.feeKurus ? 'accent' : 'neutral'}>{f.feeKurus ? formatTRY(f.feeKurus) : 'Ücretsiz'}</Badge>
                </span>
              </div>
              {f.description && <p className="line-clamp-3 text-small text-text-secondary">{f.description}</p>}
              <p className="text-xs text-muted">{hoursSummary(f.openingHours)}</p>
              <p className="text-xs text-muted">
                {f.capacity} kişi · {formatMinutes(f.slotMinutes)} dilim · en fazla {formatMinutes(f.maxBookingMinutes)} · {f.advanceDays} gün önceden · daire başına {f.maxActivePerUnit} aktif · iptal {f.cancelNoticeHours} sa önce
              </p>
              {f.blockIds?.length ? <p className="text-xs text-muted">Yalnızca: {f.blockIds.map(blockName).join(', ')}</p> : null}
              {canWrite && (
                <div className="-mx-2.5 -mb-1.5 mt-auto flex flex-wrap items-center justify-end gap-1 pt-1">
                  <Button size="xs" variant="subtle" onClick={() => onEdit(f)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    Düzenle
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    loading={status.isPending && status.variables?.id === f.facilityId}
                    onClick={() => status.mutate({ id: f.facilityId, version: f.version, status: f.status === 'active' ? 'inactive' : 'active' })}
                  >
                    <Power className="size-3.5" aria-hidden="true" />
                    {f.status === 'active' ? 'Pasife al' : 'Yeniden aç'}
                  </Button>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
