import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, FilterChips, Input, Select, Skeleton } from '@/components/ui';
import { useFacilityBookings } from '@/hooks/useReservations';
import { errorMessage } from '@/lib/api/errors';
import type { Booking, Facility } from '@/lib/api/reservations';
import { cn } from '@/lib/cn';
import { formatTRY } from '@/lib/money';
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONES, addDays, dayLabel, groupByDate, istanbulToday, weekOf } from '@/lib/reservations/model';

type View = 'day' | 'week';
type Props = { facilities: Facility[]; unitLabel: (id: string) => string; onOpen: (b: Booking) => void };

/** Gun / hafta takvimi: secilen alanin (veya tum alanlarin) rezervasyonlari, iptaller soluk. */
export function BookingCalendar({ facilities, unitLabel, onOpen }: Props) {
  const [facilityId, setFacilityId] = useState('');
  const [view, setView] = useState<View>('week');
  const [date, setDate] = useState(istanbulToday());
  const dates = view === 'day' ? [date] : weekOf(date);
  const from = dates[0] ?? date;
  const to = dates.at(-1) ?? date;
  const list = useFacilityBookings(facilityId, from, to);
  const step = view === 'day' ? 1 : 7;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Select aria-label="Ortak alan" value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
            <option value="">Tüm ortak alanlar</option>
            {facilities.map((f) => (
              <option key={f.facilityId} value={f.facilityId}>
                {f.name}
                {f.status === 'inactive' ? ' (pasif)' : ''}
              </option>
            ))}
          </Select>
        </div>
        <FilterChips<View> label="Takvim görünümü" value={view} onChange={setView} options={[{ value: 'day', label: 'Gün' }, { value: 'week', label: 'Hafta' }]} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Önceki" onClick={() => setDate(addDays(date, -step))}>
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Input type="date" aria-label="Tarih" className="w-40" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <Button variant="ghost" size="sm" aria-label="Sonraki" onClick={() => setDate(addDays(date, step))}>
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setDate(istanbulToday())}>
            Bugün
          </Button>
        </div>
      </div>

      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : (
        <ul className="flex flex-col gap-3">
          {groupByDate(list.data ?? [], dates).map((g) => (
            <li key={g.date}>
              <Card className="flex flex-col gap-2 p-4 md:p-4">
                <h3 className={cn('text-small font-semibold', g.date === istanbulToday() && 'text-accent')}>{dayLabel(g.date)}</h3>
                {g.items.length === 0 ? (
                  <p className="text-small text-muted">Rezervasyon yok</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {g.items.map((b) => (
                      <li key={b.bookingId}>
                        <button
                          type="button"
                          onClick={() => onOpen(b)}
                          className={cn(
                            'flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-left text-small hover:border-border-strong',
                            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                            (b.status === 'cancelled' || b.status === 'rejected') && 'opacity-60',
                          )}
                        >
                          <span className="font-mono tabular-nums">
                            {b.startTime}–{b.endTime}
                          </span>
                          {!facilityId && <span className="font-medium">{b.facilityName}</span>}
                          <span className="text-muted">{unitLabel(b.unitId)}</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            {b.fee.amount > 0 && <span className="text-xs text-muted">{formatTRY(b.fee.amount)}</span>}
                            <Badge tone={BOOKING_STATUS_TONES[b.status]}>{BOOKING_STATUS_LABELS[b.status]}</Badge>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
