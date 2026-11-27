import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Textarea } from '@/components/ui';
import { useBookingActions } from '@/hooks/useReservations';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Booking } from '@/lib/api/reservations';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONES, FEE_STATUS_LABELS, formatMinutes } from '@/lib/reservations/model';

type Props = { booking: Booking | null; unitLabel: (id: string) => string; canWrite: boolean; onClose: () => void };
type Mode = 'view' | 'approve' | 'reject' | 'cancel';

const ADMIN_FEE_LABELS = { ...FEE_STATUS_LABELS, charged: 'Oturanın carisine tahakkuk edildi' };

/** Rezervasyon ayrintisi; onay (not), ret ve iptal (gerekce zorunlu), yarim kalan iadenin yeniden denenmesi. */
export function BookingDialog({ booking, unitLabel, canWrite, onClose }: Props) {
  const actions = useBookingActions();
  const [mode, setMode] = useState<Mode>('view');
  const [text, setText] = useState('');
  const [last, setLast] = useState<Booking | null>(null);

  useEffect(() => {
    if (!booking) return;
    setLast(booking);
    setMode('view');
    setText('');
    actions.approve.reset();
    actions.reject.reset();
    actions.cancel.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca yeni secimde
  }, [booking?.bookingId]);

  const b = booking ?? last;
  if (!b) return null;
  const mutation = mode === 'approve' ? actions.approve : mode === 'reject' ? actions.reject : actions.cancel;
  const pending = actions.approve.isPending || actions.reject.isPending || actions.cancel.isPending;
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const reasonRequired = mode === 'reject' || mode === 'cancel';
  const tooShort = reasonRequired && text.trim().length < 3;

  const run = async (m: Mode = mode) => {
    try {
      if (m === 'approve') await actions.approve.mutateAsync({ id: b.bookingId, version: b.version, ...(text.trim() ? { note: text.trim() } : {}) });
      else if (m === 'reject') await actions.reject.mutateAsync({ id: b.bookingId, version: b.version, reason: text.trim() });
      else await actions.cancel.mutateAsync({ id: b.bookingId, version: b.version, reason: text.trim() || b.cancelReason || 'Ücret iadesi yeniden denendi' });
      onClose();
    } catch {
      // Hata diyalogda gosterilir; liste onSettled ile yenilenir.
    }
  };

  const rows: [string, string][] = [
    ['Ortak alan', b.facilityName],
    ['Daire', unitLabel(b.unitId)],
    ['Tarih', formatDate(b.date)],
    ['Saat', `${b.startTime}–${b.endTime} (${formatMinutes(b.minutes)})`],
    ...(b.partySize ? ([['Kişi sayısı', String(b.partySize)]] as [string, string][]) : []),
    ...(b.note ? ([['Sakin notu', b.note]] as [string, string][]) : []),
    ['Ücret', b.fee.amount ? `${formatTRY(b.fee.amount)} · ${ADMIN_FEE_LABELS[b.fee.status]}` : 'Ücretsiz'],
    ['Oluşturma', formatDateTime(b.createdAt)],
    ...(b.decisionNote ? ([[b.status === 'rejected' ? 'Ret gerekçesi' : 'Onay notu', b.decisionNote]] as [string, string][]) : []),
    ...(b.cancelledAt ? ([['İptal', `${formatDateTime(b.cancelledAt)} · ${b.cancelKind === 'manager' ? 'yönetim' : 'sakin'}${b.cancelReason ? ` · ${b.cancelReason}` : ''}`]] as [string, string][]) : []),
  ];

  return (
    <Dialog open={booking !== null} onClose={() => !pending && onClose()} title="Rezervasyon">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={BOOKING_STATUS_TONES[b.status]}>{BOOKING_STATUS_LABELS[b.status]}</Badge>
          {b.expired && <Badge>Süresi geçti</Badge>}
        </div>
        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-small">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="col-span-2 break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {b.fee.error && <Alert tone="danger">{b.fee.error}</Alert>}

        {mode !== 'view' && (
          <FormField
            label={mode === 'approve' ? 'Not (isteğe bağlı)' : mode === 'reject' ? 'Ret gerekçesi' : 'İptal gerekçesi'}
            hint={reasonRequired ? 'Sakin bu gerekçeyi görür ve denetim günlüğüne yazılır.' : undefined}
          >
            <Textarea rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
          </FormField>
        )}
        {mode === 'cancel' && b.fee.status === 'charged' && <p className="text-small text-muted">Tahakkuk edilen ücret ters kayıtla iade edilir.</p>}
        {mutation.isError && <Alert tone="danger">{conflict ? 'Rezervasyon bu arada değişti. Liste yenilendi; kontrol edip tekrar deneyin.' : errorMessage(mutation.error)}</Alert>}

        {canWrite && (
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            {mode === 'view' ? (
              <>
                <Button variant="ghost" onClick={onClose}>
                  Kapat
                </Button>
                {b.canRetryReversal && (
                  <Button variant="secondary" loading={actions.cancel.isPending} onClick={() => void run('cancel')}>
                    Ücret iadesini yeniden dene
                  </Button>
                )}
                {b.canCancel && (
                  <Button variant="secondary" onClick={() => setMode('cancel')}>
                    İptal et
                  </Button>
                )}
                {b.status === 'pending' && (
                  <Button variant="secondary" onClick={() => setMode('reject')}>
                    Reddet
                  </Button>
                )}
                {b.canApprove && <Button onClick={() => setMode('approve')}>Onayla</Button>}
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setMode('view')} disabled={pending}>
                  Vazgeç
                </Button>
                {!conflict && (
                  <Button variant={mode === 'approve' ? 'primary' : 'danger'} loading={pending} disabled={tooShort} onClick={() => void run()}>
                    {mode === 'approve' ? (b.fee.amount ? `Onayla ve ${formatTRY(b.fee.amount)} tahakkuk et` : 'Onayla') : mode === 'reject' ? 'Reddet' : 'Rezervasyonu iptal et'}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
