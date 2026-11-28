import { CalendarClock, Mail } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FormField, Input, Textarea } from '@/components/ui';
import { useRescheduleAssembly, useSendCall } from '@/hooks/useAssemblies';
import type { Assembly, CallCheck } from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime, isoToIstanbulLocal } from '@/lib/dates';
import { rescheduleInput } from './schemas';

type Props = { assembly: Assembly; check?: CallCheck; outdated: boolean; canWrite: boolean };

/**
 * Cagri (davet) e-postasi: oy listesindeki kat maliki kullanicilara. KMK m.29'daki 15 gun kuralina
 * uyulmamissa uyari gosterilir, gonderim engellenmez. Ilk gonderimden sonra yalnizca gerekceli
 * "yeniden gonder". E-posta yasal cagri yontemi (imza karsiligi tebligat / taahhutlu mektup) yerine gecmez.
 */
export function AssemblyCallCard({ assembly: a, check, outdated, canWrite }: Props) {
  const send = useSendCall(a.assemblyId);
  const [resending, setResending] = useState(false);
  const [reason, setReason] = useState('');
  const calls = a.calls ?? [];
  const canSend = canWrite && a.status === 'planned' && Boolean(check);
  const result = send.data;

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <Mail className="size-5 text-muted" aria-hidden="true" />
        Çağrı
      </CardTitle>
      <p className="text-small text-muted">
        E-posta, oy listesindeki ve apartmanda kullanıcısı olan kat maliklerine bilgilendirme olarak gider; KMK m.29&apos;daki çağrının (imza karşılığı tebliğ veya taahhütlü mektup,
        toplantıdan en az 15 gün önce) yerine geçmez.
      </p>

      {calls.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-small">
          {calls.map((c) => (
            <li key={c.seq}>
              {c.resend ? 'Yeniden gönderildi' : 'Gönderildi'}: {formatDateTime(c.calledAt)} · {c.recipients} kat maliki · toplantıdan {c.daysBefore} gün önce
              {c.lateNotice && <span className="text-warning"> · 15 gün süresinden sonra</span>}
              {c.reason && <span className="text-muted"> · Gerekçe: {c.reason}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small">Çağrı henüz gönderilmedi.</p>
      )}

      {check && a.status === 'planned' && (
        <p className="text-small text-muted tabular-nums">
          Şimdi gönderilirse: {check.recipients} kat maliki e-posta alır
          {check.ownersWithoutAccount > 0 ? `, ${check.ownersWithoutAccount} malikin apartmanda kullanıcısı yok (yasal çağrıyı ayrıca yapın)` : ''} · toplantıya {check.daysBefore} gün var.
        </p>
      )}
      {outdated && <Alert>Son çağrıdan sonra toplantı bilgileri veya gündem değişti; maliklere güncel bilgiyi yeniden gönderin.</Alert>}
      {canSend && check && check.warnings.length > 0 && <Alert>{check.warnings.join(' ')}</Alert>}
      {result && result.warnings.length > 0 && <Alert>{result.warnings.join(' ')}</Alert>}
      {send.isSuccess && <Alert tone="success">Çağrı kaydedildi; e-postalar kısa süre içinde gönderilir.</Alert>}
      {send.isError && <Alert tone="danger">{errorMessage(send.error)}</Alert>}

      {(a.reschedules?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1.5 text-small">
          {a.reschedules?.map((r) => (
            <li key={r.seq}>
              {r.previousScheduledAt === r.scheduledAt ? 'Yer değişti' : r.scheduledAt < r.previousScheduledAt ? 'Tarihi değişti' : 'Ertelendi'}: {formatDateTime(r.at)} · {formatDateTime(r.previousScheduledAt)}
              {r.previousScheduledAt !== r.scheduledAt ? ` yerine ${formatDateTime(r.scheduledAt)}` : ''}
              {(r.previousLocation ?? '') !== (r.location ?? '') ? ` · yeni yer: ${r.location ?? 'çevrim içi'}` : ''}
              <span className="text-muted"> · Gerekçe: {r.reason}</span>
            </li>
          ))}
        </ul>
      )}

      {canSend && calls.length > 0 && !a.roll && <RescheduleBox assembly={a} />}

      {canSend &&
        (calls.length === 0 ? (
          <div>
            <Button size="sm" loading={send.isPending} onClick={() => send.mutate({ version: a.version })}>
              Çağrıyı gönder
            </Button>
          </div>
        ) : resending ? (
          <Card className="flex flex-col gap-3">
            <FormField label="Yeniden gönderme gerekçesi" hint="Gerekçe denetim günlüğüne yazılır; tüm alıcılara yeniden e-posta gider.">
              <Textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setResending(false)} disabled={send.isPending}>
                Vazgeç
              </Button>
              <Button
                loading={send.isPending}
                disabled={reason.trim().length < 3}
                onClick={() =>
                  send.mutate(
                    { version: a.version, resend: true, reason: reason.trim() },
                    {
                      onSuccess: () => {
                        setResending(false);
                        setReason('');
                      },
                    },
                  )
                }
              >
                Yeniden gönder
              </Button>
            </div>
          </Card>
        ) : (
          <div>
            <Button size="sm" variant="secondary" onClick={() => setResending(true)}>
              Çağrıyı yeniden gönder
            </Button>
          </div>
        ))}
    </Card>
  );
}

/**
 * Cagrisi gonderilmis toplantinin ertelenmesi / yer degisikligi: gerekceli, denetimli; tum cagri
 * alicilarina e-posta ve mobil bildirim gider. Onceki cagri eskir (gerekirse yeniden gonderilir).
 */
function RescheduleBox({ assembly: a }: { assembly: Assembly }) {
  const reschedule = useRescheduleAssembly(a.assemblyId);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reason: '', scheduledAt: '', location: '', onlineUrl: '', secondAt: '', secondLocation: '' });
  const [issue, setIssue] = useState<string | null>(null);
  const start = () => {
    setForm({
      reason: '',
      scheduledAt: isoToIstanbulLocal(a.scheduledAt),
      location: a.location ?? '',
      onlineUrl: a.onlineUrl ?? '',
      secondAt: a.secondMeetingPlan ? isoToIstanbulLocal(a.secondMeetingPlan.scheduledAt) : '',
      secondLocation: a.secondMeetingPlan?.location ?? '',
    });
    setIssue(null);
    reschedule.reset();
    setOpen(true);
  };
  const submit = () => {
    const r = rescheduleInput(a, form);
    if ('issue' in r) {
      setIssue(r.issue);
      return;
    }
    setIssue(null);
    reschedule.mutate(r.input, { onSuccess: () => setOpen(false) });
  };
  const result = reschedule.data;

  return (
    <>
      {result && (
        <Alert tone="success">
          Değişiklik kaydedildi; kat maliklerine bildirim gönderilir. {result.warnings.join(' ')}
        </Alert>
      )}
      {open ? (
        <Card className="flex flex-col gap-3">
          <p className="text-small text-muted">Çağrı alan bütün kat maliklerine e-posta ve mobil bildirim gider. Kanun erteleme usulü öngörmez; yeni tarih için yasal çağrıyı yeniden yapın.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Yeni tarih ve saat">
              <Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
            </FormField>
            <FormField label="Toplantı yeri">
              <Input autoComplete="off" maxLength={300} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Çevrim içi bağlantı (isteğe bağlı)">
            <Input type="url" autoComplete="off" maxLength={500} placeholder="https://" value={form.onlineUrl} onChange={(e) => setForm({ ...form, onlineUrl: e.target.value })} />
          </FormField>
          {a.secondMeetingPlan && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="İkinci toplantı tarihi" hint="İlk toplantı tarihi değişince ikinci toplantı yeniden bildirilir (KMK m.29/3; 7-15 gün sonra).">
                <Input type="datetime-local" value={form.secondAt} onChange={(e) => setForm({ ...form, secondAt: e.target.value })} />
              </FormField>
              <FormField label="İkinci toplantı yeri">
                <Input autoComplete="off" maxLength={300} value={form.secondLocation} onChange={(e) => setForm({ ...form, secondLocation: e.target.value })} />
              </FormField>
            </div>
          )}
          <FormField label="Erteleme / değişiklik gerekçesi" hint="Gerekçe denetim günlüğüne ve maliklere giden bildirime yazılır.">
            <Textarea maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </FormField>
          {issue && <Alert tone="danger">{issue}</Alert>}
          {reschedule.isError && <Alert tone="danger">{errorMessage(reschedule.error)}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={reschedule.isPending}>
              Vazgeç
            </Button>
            <Button loading={reschedule.isPending} disabled={form.reason.trim().length < 3} onClick={submit}>
              Kaydet ve bildir
            </Button>
          </div>
        </Card>
      ) : (
        <div>
          <Button size="sm" variant="secondary" onClick={start}>
            <CalendarClock className="size-4" aria-hidden="true" />
            Ertele / yer değiştir
          </Button>
        </div>
      )}
    </>
  );
}
