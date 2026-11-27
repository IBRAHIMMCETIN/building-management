import { CalendarCheck, CalendarDays, CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useAvailability, useCancelMyBooking, useCreateBooking, useMyBookings, usePortalFacilities } from '@/hooks/useReservations';
import { errorMessage } from '@/lib/api/errors';
import type { MyBooking, PortalFacility, PortalUnit, SlotState } from '@/lib/api/reservations';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONES, FEE_STATUS_LABELS, addClock, addDays, dayLabel, durationOptions, formatMinutes, hoursSummary } from '@/lib/reservations/model';

type Tab = 'new' | 'mine';

const SLOT_TEXT: Record<SlotState, string> = { free: 'Boş', busy: 'Dolu', mine: 'Sizin', past: 'Geçti' };

/** Sakin "Rezervasyon": alan -> tarih -> bos dilim -> onay; rezervasyonlarim ve iptal. */
export function MyReservationsPage() {
  const [tab, setTab] = useState<Tab>('new');
  const [done, setDone] = useState<{ booking: MyBooking; warning?: string } | null>(null);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-title font-bold">Rezervasyon</h1>
      <FilterChips<Tab>
        label="Rezervasyon görünümü"
        value={tab}
        onChange={(t) => {
          setTab(t);
          setDone(null);
        }}
        options={[
          { value: 'new', label: 'Yeni rezervasyon' },
          { value: 'mine', label: 'Rezervasyonlarım' },
        ]}
      />
      {done && (
        <Card className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">{done.booking.status === 'pending' ? 'Talebiniz alındı, yönetici onayı bekleniyor' : 'Rezervasyonunuz onaylandı'}</p>
          <p className="text-small text-muted">
            {done.booking.facilityName} · {dayLabel(done.booking.date)} · {done.booking.startTime}–{done.booking.endTime}
          </p>
          {done.warning && <Alert>{done.warning}</Alert>}
        </Card>
      )}
      {tab === 'new' ? (
        <NewBooking
          onDone={(r) => {
            setDone(r);
            setTab('mine');
          }}
        />
      ) : (
        <MyBookingsList />
      )}
    </div>
  );
}

function NewBooking({ onDone }: { onDone: (r: { booking: MyBooking; warning?: string }) => void }) {
  const facilities = usePortalFacilities();
  const [facilityId, setFacilityId] = useState<string>();
  if (facilities.isPending) return <Skeleton className="h-40" />;
  if (facilities.isError) return <Alert tone="danger">{errorMessage(facilities.error)}</Alert>;
  const { items, units, today } = facilities.data;
  if (!units.length) return <p className="py-10 text-center text-small text-muted">Rezervasyon için bir daireye üye olmanız gerekir.</p>;
  if (!items.length) return <p className="py-10 text-center text-small text-muted">Rezervasyona açık ortak alan yok.</p>;
  const facility = items.find((f) => f.facilityId === facilityId);

  if (!facility) {
    return (
      <ul className="flex flex-col gap-2">
        {items.map((f) => (
          <li key={f.facilityId}>
            <button
              type="button"
              onClick={() => setFacilityId(f.facilityId)}
              className="flex w-full flex-col gap-1 rounded-xl border border-border bg-surface p-4 text-left shadow-xs hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="flex flex-wrap items-center gap-2">
                <CalendarDays className="size-4 text-accent" aria-hidden="true" />
                <span className="font-medium">{f.name}</span>
                <Badge tone={f.feeKurus ? 'accent' : 'neutral'}>{f.feeKurus ? formatTRY(f.feeKurus) : 'Ücretsiz'}</Badge>
                {f.requiresApproval && <Badge tone="warning">Yönetici onaylı</Badge>}
              </span>
              {f.description && <span className="line-clamp-2 text-small text-text-secondary">{f.description}</span>}
              <span className="text-xs text-muted">{hoursSummary(f.openingHours)}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return <SlotPicker key={facility.facilityId} facility={facility} units={units.filter((u) => facility.unitIds.includes(u.unitId))} today={today} onBack={() => setFacilityId(undefined)} onDone={onDone} />;
}

type PickerProps = { facility: PortalFacility; units: PortalUnit[]; today: string; onBack: () => void; onDone: (r: { booking: MyBooking; warning?: string }) => void };

function SlotPicker({ facility, units, today, onBack, onDone }: PickerProps) {
  const { unitId: preferred } = usePortalUnit();
  const [unitId, setUnitId] = useState(units.find((u) => u.unitId === preferred)?.unitId ?? units[0]?.unitId ?? '');
  const [date, setDate] = useState(today);
  const [startIndex, setStartIndex] = useState<number>();
  const [minutes, setMinutes] = useState<number>();
  const [partySize, setPartySize] = useState('');
  const [note, setNote] = useState('');
  const [key, renewKey] = useIdempotencyKey();
  const day = useAvailability(facility.facilityId, date);
  const create = useCreateBooking();
  const lastDate = addDays(today, facility.advanceDays);

  useEffect(() => {
    setStartIndex(undefined);
    setMinutes(undefined);
  }, [date]);

  const slots = day.data?.slots ?? [];
  const durations = useMemo(
    () => (startIndex === undefined || !day.data ? [] : durationOptions(day.data.slots, startIndex, day.data.slotMinutes, day.data.maxBookingMinutes)),
    [day.data, startIndex],
  );
  const start = startIndex === undefined ? undefined : slots[startIndex];
  const chosenMinutes = minutes ?? durations[0];
  const party = partySize.trim() ? Number(partySize) : undefined;

  // Her yeni secim (daire, tarih, dilim, sure, kisi sayisi, not) yeni bir istektir: anahtar yenilenir.
  // Ayni secimin tekrar gonderimi (ag hatasi, cift dokunma) ayni anahtari kullanir.
  useEffect(() => {
    renewKey();
  }, [unitId, date, startIndex, chosenMinutes, partySize, note, renewKey]);
  const partyInvalid = party !== undefined && (!Number.isInteger(party) || party < 1 || party > facility.capacity);

  const submit = async () => {
    if (!start || !chosenMinutes) return;
    try {
      const r = await create.mutateAsync({ idempotencyKey: key, facilityId: facility.facilityId, unitId, date, start: start.start, minutes: chosenMinutes, ...(party ? { partySize: party } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      renewKey();
      onDone({ booking: r.booking, ...(r.warning ? { warning: r.warning } : {}) });
    } catch {
      // Hata asagida gosterilir; dolu dilimde musaitlik yenilenir.
      void day.refetch();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-heading font-semibold break-words">{facility.name}</h2>
          <p className="text-xs text-muted">
            {hoursSummary(facility.openingHours)} · {facility.capacity} kişi
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Alan değiştir
        </Button>
      </div>
      {facility.description && <p className="text-small whitespace-pre-line text-text-secondary">{facility.description}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {units.length > 1 && (
          <FormField label="Daire">
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              {units.map((u) => (
                <option key={u.unitId} value={u.unitId}>
                  {u.label}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Tarih" hint={`En geç ${formatDate(lastDate)} için rezervasyon yapılabilir.`}>
          <Input type="date" min={today} max={lastDate} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </FormField>
      </div>

      <section aria-label="Saatler" className="flex flex-col gap-2">
        <h3 className="text-small font-medium">{dayLabel(date)}</h3>
        {day.isPending ? (
          <Skeleton className="h-24" />
        ) : day.isError ? (
          <Alert tone="danger">{errorMessage(day.error)}</Alert>
        ) : !day.data.open ? (
          <p className="text-small text-muted">Ortak alan bu gün kapalı.</p>
        ) : !day.data.bookable ? (
          <p className="text-small text-muted">Bu tarih için rezervasyon yapılamaz.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map((s, i) => {
              const chosen = startIndex !== undefined && chosenMinutes !== undefined && i >= startIndex && i < startIndex + chosenMinutes / day.data.slotMinutes;
              return (
                <li key={s.start}>
                  <button
                    type="button"
                    disabled={s.state !== 'free'}
                    aria-pressed={startIndex === i}
                    onClick={() => {
                      setStartIndex(i);
                      setMinutes(undefined);
                    }}
                    className={cn(
                      'flex w-full flex-col items-center rounded-md border border-border-strong bg-surface px-2 py-2 text-small transition-colors',
                      'hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                      'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted disabled:hover:border-border-strong',
                      chosen && 'border-accent bg-accent/10 text-accent',
                      s.state === 'mine' && 'border-success/40 text-success',
                    )}
                  >
                    <span className="font-mono tabular-nums">{s.start}</span>
                    <span className="text-xs">{SLOT_TEXT[s.state]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {start && chosenMinutes && (
        <Card className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Süre">
              <Select value={String(chosenMinutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
                {durations.map((m) => (
                  <option key={m} value={String(m)}>
                    {formatMinutes(m)} ({start.start}–{addClock(start.start, m)})
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Kişi sayısı (isteğe bağlı)" error={partyInvalid ? `1–${facility.capacity} arasında olmalı` : undefined}>
              <Input inputMode="numeric" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Not (isteğe bağlı)">
            <Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
          <div className="flex flex-col gap-1 text-small">
            <p className="font-medium">
              {dayLabel(date)} · {start.start}–{addClock(start.start, chosenMinutes)}
            </p>
            <p className="text-muted">
              {facility.feeKurus ? `Ücret: ${formatTRY(facility.feeKurus)} — ${facility.requiresApproval ? 'onaylanınca' : 'rezervasyonla birlikte'} dairenizin borcuna eklenir.` : 'Ücretsiz.'}
              {facility.requiresApproval ? ' Rezervasyon yönetici onayından sonra kesinleşir.' : ''}
              {facility.cancelNoticeHours ? ` Başlangıçtan en geç ${facility.cancelNoticeHours} saat önce iptal edebilirsiniz.` : ''}
            </p>
          </div>
          {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          <Button loading={create.isPending} disabled={partyInvalid} onClick={() => void submit()}>
            <CalendarCheck className="size-4" aria-hidden="true" />
            {facility.requiresApproval ? 'Rezervasyon talebi gönder' : 'Rezervasyonu onayla'}
          </Button>
        </Card>
      )}
    </div>
  );
}

function MyBookingsList() {
  const list = useMyBookings();
  const cancel = useCancelMyBooking();
  const [confirming, setConfirming] = useState<string>();
  const [notice, setNotice] = useState<string>();
  if (list.isPending) return <Skeleton className="h-40" />;
  if (list.isError) return <Alert tone="danger">{errorMessage(list.error)}</Alert>;
  const { upcoming, history } = list.data;

  const row = (b: MyBooking) => (
    <li key={b.bookingId}>
      <Card className="flex flex-col gap-2 p-4 md:p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block font-medium break-words">{b.facilityName}</span>
            <span className="text-small text-muted">
              {dayLabel(b.date)} · {b.startTime}–{b.endTime}
            </span>
          </span>
          <Badge tone={BOOKING_STATUS_TONES[b.status]}>{b.expired ? 'Süresi geçti' : BOOKING_STATUS_LABELS[b.status]}</Badge>
        </div>
        {b.fee.amount > 0 && (
          <p className="text-xs text-muted">
            {formatTRY(b.fee.amount)} · {FEE_STATUS_LABELS[b.fee.status]}
          </p>
        )}
        {b.decisionNote && <p className="text-xs text-danger">Ret gerekçesi: {b.decisionNote}</p>}
        {b.cancelKind === 'manager' && b.cancelReason && <p className="text-xs text-danger">Yönetim iptal etti: {b.cancelReason}</p>}
        {b.canCancel ? (
          confirming === b.bookingId ? (
            <div className="flex flex-col gap-2">
              <p className="text-small">Rezervasyon iptal edilsin mi?{b.fee.status === 'charged' ? ' Ücret ters kayıtla borcunuzdan düşülür.' : ''}</p>
              {cancel.isError && <Alert tone="danger">{errorMessage(cancel.error)}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(undefined)} disabled={cancel.isPending}>
                  Vazgeç
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  loading={cancel.isPending}
                  onClick={() =>
                    cancel.mutate(
                      { id: b.bookingId, version: b.version },
                      {
                        onSuccess: (r) => {
                          setConfirming(undefined);
                          setNotice(r.warning);
                        },
                      },
                    )
                  }
                >
                  İptal et
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted">En geç {formatDateTime(b.cancelDeadline)} iptal edilebilir</span>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  cancel.reset();
                  setConfirming(b.bookingId);
                }}
              >
                İptal et
              </Button>
            </div>
          )
        ) : (
          !b.past && b.status !== 'cancelled' && b.status !== 'rejected' && <p className="text-xs text-muted">İptal süresi geçti; değişiklik için yönetimle görüşün.</p>
        )}
      </Card>
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="danger">{notice}</Alert>}
      {upcoming.length === 0 ? <p className="py-6 text-center text-small text-muted">Yaklaşan rezervasyonunuz yok.</p> : <ul className="flex flex-col gap-2">{upcoming.map(row)}</ul>}
      {history.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-small font-semibold text-muted">Geçmiş ve iptal edilenler</h2>
          <ul className="flex flex-col gap-2">{history.map(row)}</ul>
        </section>
      )}
    </div>
  );
}
