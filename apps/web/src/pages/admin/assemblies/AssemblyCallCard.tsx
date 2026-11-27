import { Mail } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FormField, Textarea } from '@/components/ui';
import { useSendCall } from '@/hooks/useAssemblies';
import type { Assembly, CallCheck } from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';

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

      {canSend &&
        (calls.length === 0 ? (
          <div>
            <Button size="sm" loading={send.isPending} onClick={() => send.mutate({ version: a.version })}>
              Çağrıyı gönder
            </Button>
          </div>
        ) : resending ? (
          <div className="flex flex-col gap-3">
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
          </div>
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
