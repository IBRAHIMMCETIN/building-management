import { LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Dialog, FormField, Select, Skeleton, Textarea } from '@/components/ui';
import { useStartSupport, useSupportSessions } from '@/hooks/useSecurity';
import { errorMessage } from '@/lib/api/errors';
import { SUPPORT_DURATIONS, SUPPORT_REASON_MIN } from '@/lib/api/support';
import { formatDateTime } from '@/lib/dates';

/**
 * Platform yoneticisi: bir apartmana gerekceli ve sureli (en fazla 60 dk) SALT OKUNUR destek
 * erisimi acar. Oturum acilisi, kapanisi ve oturumdaki her istek apartmanin denetim gunlugune
 * yazilir; apartman yoneticisi bu kayitlari kendi gunlugunde gorur.
 */
export function SupportDialog({
  apartment,
  onClose,
}: {
  apartment: { siteId: string; name: string } | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const sessions = useSupportSessions(apartment?.siteId);
  const start = useStartSupport();
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<number>(30);
  const tooShort = reason.trim().length < SUPPORT_REASON_MIN;

  const close = () => {
    setReason('');
    start.reset();
    onClose();
  };

  return (
    <Dialog open={!!apartment} onClose={close} title={`Destek erişimi · ${apartment?.name ?? ''}`}>
      {apartment && (
        <div className="flex flex-col gap-5">
          <Alert tone="info">
            Erişim salt okunurdur (denetçi yetkisi). Açılış, kapanış ve oturumdaki her istek apartmanın denetim günlüğüne
            yazılır.
          </Alert>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (tooShort) return;
              start.mutate(
                { apartmentId: apartment.siteId, apartmentName: apartment.name, reason: reason.trim(), durationMinutes: duration },
                {
                  onSuccess: () => {
                    close();
                    navigate('/admin', { replace: true });
                  },
                },
              );
            }}
          >
            <FormField
              label="Gerekçe"
              hint={`En az ${SUPPORT_REASON_MIN} karakter; talep numarası ve amaç (ör. "Talep #123: makbuz görüntüleme hatası").`}
              error={reason.length > 0 && tooShort ? `En az ${SUPPORT_REASON_MIN} karakter yazın` : undefined}
            >
              <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <FormField label="Süre">
              <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {SUPPORT_DURATIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} dakika
                  </option>
                ))}
              </Select>
            </FormField>
            {start.isError && <Alert tone="danger">{errorMessage(start.error)}</Alert>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Vazgeç
              </Button>
              <Button type="submit" disabled={tooShort} loading={start.isPending}>
                <LifeBuoy className="size-4" aria-hidden="true" />
                Oturumu başlat
              </Button>
            </div>
          </form>

          <div className="flex flex-col gap-2">
            <span className="text-small font-medium">Geçmiş oturumlar</span>
            {sessions.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : sessions.isError ? (
              <Alert tone="danger">{errorMessage(sessions.error)}</Alert>
            ) : (sessions.data?.length ?? 0) === 0 ? (
              <p className="text-small text-muted">Bu apartmanda destek oturumu açılmamış.</p>
            ) : (
              <ul className="flex max-h-56 flex-col gap-2 overflow-auto" aria-label="Destek oturumları">
                {sessions.data?.map((s) => (
                  <li key={s.sessionId} className="rounded-md border border-border p-2 text-small">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{formatDateTime(s.startedAt)}</span>
                      {s.active ? <Badge tone="warning">Aktif</Badge> : <Badge>Kapandı</Badge>}
                      <span className="text-muted">
                        {s.endedAt ? `bitiş ${formatDateTime(s.endedAt)}` : `süre sonu ${formatDateTime(s.expiresAt)}`}
                      </span>
                    </div>
                    <p className="mt-1 text-muted">{s.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
