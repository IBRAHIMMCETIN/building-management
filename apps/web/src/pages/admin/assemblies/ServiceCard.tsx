import { ClipboardCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useAddServiceAttempt, useServiceReport, useUpdateServiceAttempt } from '@/hooks/useAssemblies';
import {
  type Assembly,
  SERVICE_METHODS,
  SERVICE_METHOD_LABELS,
  SERVICE_STATE_LABELS,
  SERVICE_STATE_TONES,
  SERVICE_STATUS_LABELS,
  type ServiceAttempt,
  type ServiceMethod,
  type ServiceRow,
  type ServiceStatus,
} from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/dates';
import { istanbulToday } from '@/lib/reservations/model';
import { serviceAttemptInput } from './schemas';

type Props = { assembly: Assembly; canWrite: boolean };
type Filter = 'all' | 'unserved';
type Editing = { kind: 'add'; row: ServiceRow } | { kind: 'result'; row: ServiceRow; attempt: ServiceAttempt } | { kind: 'void'; row: ServiceRow; attempt: ServiceAttempt } | null;

/**
 * Yasal cagri (KMK m.29) teslim takibi: oy listesindeki her kat maliki icin imza karsiligi elden /
 * taahhutlu mektup / e-posta bilgilendirme denemeleri, teslim / iade sonucu ve m.29 sure uyarilari.
 * Denemeler silinmez; hatali giris gerekceyle iptal edilir. Rapor acilinca yuklenir.
 */
export function ServiceCard({ assembly: a, canWrite }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const report = useServiceReport(expanded ? a.assemblyId : undefined, filter === 'unserved');
  const [editing, setEditing] = useState<Editing>(null);
  const writable = canWrite && a.status !== 'cancelled';
  const r = report.data;

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <ClipboardCheck className="size-5 text-muted" aria-hidden="true" />
        Tebligat takibi (KMK m.29)
      </CardTitle>
      <p className="text-small text-muted">
        Yasal çağrı imza karşılığı elden veya taahhütlü mektupla yapılır; e-posta bilgilendirmesi tebligat sayılmaz. Olağanüstü toplantıda çağrı toplantıdan en az 15 gün önce yapılmalıdır.
      </p>
      {!expanded ? (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setExpanded(true)}>
            Tebligat listesini aç
          </Button>
        </div>
      ) : report.isPending ? (
        <div role="status" aria-label="Tebligat listesi yükleniyor">
          <Skeleton className="h-24" />
        </div>
      ) : report.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="danger">{errorMessage(report.error)}</Alert>
          <Button size="sm" variant="secondary" onClick={() => void report.refetch()}>
            Tekrar dene
          </Button>
        </div>
      ) : (
        r && (
          <>
            <p className="text-small tabular-nums">
              {r.summary.served}/{r.summary.owners} kat maliki tebliğ edildi
              {r.summary.lateDelivery ? ` · ${r.summary.lateDelivery} zamanında postalandı, geç teslim` : ''}
              {r.summary.servedLate ? ` · ${r.summary.servedLate} süre sonrası` : ''}
              {r.summary.pending ? ` · ${r.summary.pending} teslim bekleniyor` : ''}
              {r.summary.returned ? ` · ${r.summary.returned} iade` : ''} · son teslim günü {formatDate(r.deadline)}
              {r.deadlineLenient ? ` (tebligat günü sayılırsa ${formatDate(r.deadlineLenient)})` : ''}
              {r.daysToDeadline >= 0 ? ` (${r.daysToDeadline} gün kaldı)` : ' (geçti)'}
            </p>
            {r.warnings.length > 0 && <Alert>{r.warnings.join(' ')}</Alert>}
            <FilterChips
              label="Tebligat filtresi"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'Tümü' },
                { value: 'unserved', label: 'Tebliğ edilmeyenler', count: r.summary.unserved },
              ]}
            />
            {r.rows.length === 0 ? (
              <p className="text-small text-muted">{filter === 'unserved' ? 'Tebliğ edilmeyen kat maliki yok.' : 'Oy listesinde kat maliki yok.'}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-small">
                  <caption className="sr-only">Kat maliki bazında tebligat</caption>
                  <thead className="border-b border-border bg-surface-muted/50 text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Kat maliki
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Durum
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Denemeler
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {r.rows.map((row) => (
                      <tr key={row.ownerId} className="align-top">
                        <td className="px-3 py-2">
                          {row.name ?? 'Kayıtlı kişi'}
                          <span className="block text-xs text-muted">{row.units.map((u) => u.number).join(', ')}</span>
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={SERVICE_STATE_TONES[row.state]}>{SERVICE_STATE_LABELS[row.state]}</Badge>
                          {row.servedOn && <span className="block text-xs text-muted">{formatDate(row.servedOn)}</span>}
                        </td>
                        <td className="px-3 py-2">
                          <ul className="flex flex-col gap-1.5">
                            {row.attempts.map((x) => (
                              <li key={x.seq} className={x.voidedAt ? 'text-xs text-muted line-through' : 'text-xs'}>
                                {SERVICE_METHOD_LABELS[x.method]} · {formatDate(x.sentOn)}
                                {x.referenceNo ? ` · ${x.referenceNo}` : ''} · {SERVICE_STATUS_LABELS[x.status]}
                                {x.statusOn ? ` (${formatDate(x.statusOn)})` : ''}
                                {x.voidedAt && <span className="no-underline"> · iptal: {x.voidReason}</span>}
                                {x.stale && !x.voidedAt && (
                                  <Badge tone="warning" className="ml-1">
                                    Ertelemeden önce: yeni tarih için geçersiz
                                  </Badge>
                                )}
                                {writable && !x.voidedAt && (
                                  <span className="mt-1 flex flex-wrap gap-1">
                                    {x.status === 'pending' && (
                                      <Button size="xs" variant="subtle" onClick={() => setEditing({ kind: 'result', row, attempt: x })}>
                                        Sonucu gir
                                      </Button>
                                    )}
                                    <Button size="xs" variant="subtle" onClick={() => setEditing({ kind: 'void', row, attempt: x })}>
                                      Hatalı giriş
                                    </Button>
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                          {writable && (
                            <Button size="xs" variant="subtle" className="mt-1" onClick={() => setEditing({ kind: 'add', row })}>
                              Deneme ekle
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}
      {writable && <AttemptDialog assembly={a} editing={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function AttemptDialog({ assembly: a, editing, onClose }: { assembly: Assembly; editing: Editing; onClose: () => void }) {
  const add = useAddServiceAttempt(a.assemblyId);
  const update = useUpdateServiceAttempt(a.assemblyId);
  const [method, setMethod] = useState<ServiceMethod>('hand_signed');
  const [sentOn, setSentOn] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [status, setStatus] = useState<ServiceStatus | ''>('');
  const [statusOn, setStatusOn] = useState('');
  const [note, setNote] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const today = istanbulToday();

  useEffect(() => {
    if (!editing) return;
    add.reset();
    update.reset();
    setMethod('hand_signed');
    setSentOn(today);
    setReferenceNo('');
    setStatus(editing.kind === 'result' ? 'delivered' : '');
    setStatusOn(today);
    setNote('');
    setIssue(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [editing]);

  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      if (editing.kind === 'add') {
        const r = serviceAttemptInput({ version: editing.row.version, method, sentOn, referenceNo, status, statusOn, note }, { today, rollDate: a.rollDate });
        if ('issue' in r) return setIssue(r.issue);
        await add.mutateAsync({ ownerId: editing.row.ownerId, input: r.input });
      } else if (editing.kind === 'result') {
        if (!statusOn || statusOn > today || statusOn < editing.attempt.sentOn) return setIssue('Teslim / iade tarihi gönderimden önce veya bugünden sonra olamaz');
        await update.mutateAsync({
          ownerId: editing.row.ownerId,
          seq: editing.attempt.seq,
          input: { version: editing.row.version, status: status === 'returned' ? 'returned' : 'delivered', statusOn, ...(note.trim() ? { note: note.trim() } : {}) },
        });
      } else {
        if (note.trim().length < 3) return setIssue('Gerekçe en az 3 karakter olmalı');
        await update.mutateAsync({ ownerId: editing.row.ownerId, seq: editing.attempt.seq, input: { version: editing.row.version, void: true, reason: note.trim() } });
      }
      onClose();
    } catch {
      // Hata diyalogda gosterilir.
    }
  };
  const title = !editing ? '' : editing.kind === 'add' ? `Tebligat denemesi · ${editing.row.name ?? 'Kayıtlı kişi'}` : editing.kind === 'result' ? 'Teslim sonucu' : 'Hatalı girişi iptal et';

  return (
    <Dialog open={editing !== null} onClose={() => !pending && onClose()} title={title}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        {editing?.kind === 'add' && (
          <>
            <FormField label="Yöntem" hint={method === 'email_info' ? 'E-posta bilgilendirmesi yasal tebligat sayılmaz.' : undefined}>
              <Select value={method} onChange={(e) => setMethod(e.target.value as ServiceMethod)}>
                {SERVICE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {SERVICE_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={method === 'hand_signed' ? 'İmza tarihi' : method === 'registered_mail' ? 'Postaya veriliş tarihi' : 'Gönderim tarihi'}>
                <Input type="date" max={today} value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
              </FormField>
              <FormField label={method === 'registered_mail' ? 'Gönderi (barkod) no' : 'Referans no (isteğe bağlı)'}>
                <Input autoComplete="off" maxLength={60} value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
              </FormField>
            </div>
            {method === 'registered_mail' && (
              <FormField label="Durum" hint="Teslim veya iade bilgisi gelince sonradan da girilebilir.">
                <Select value={status} onChange={(e) => setStatus(e.target.value as ServiceStatus | '')}>
                  <option value="">Bekliyor</option>
                  <option value="delivered">{SERVICE_STATUS_LABELS.delivered}</option>
                  <option value="returned">{SERVICE_STATUS_LABELS.returned}</option>
                </Select>
              </FormField>
            )}
          </>
        )}
        {editing?.kind === 'result' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Sonuç">
              <Select value={status} onChange={(e) => setStatus(e.target.value as ServiceStatus)}>
                <option value="delivered">{SERVICE_STATUS_LABELS.delivered}</option>
                <option value="returned">{SERVICE_STATUS_LABELS.returned}</option>
              </Select>
            </FormField>
            <FormField label="Tarih">
              <Input type="date" max={today} value={statusOn} onChange={(e) => setStatusOn(e.target.value)} />
            </FormField>
          </div>
        )}
        {editing?.kind === 'add' && method === 'registered_mail' && status && status !== 'pending' && (
          <FormField label="Teslim / iade tarihi">
            <Input type="date" max={today} value={statusOn} onChange={(e) => setStatusOn(e.target.value)} />
          </FormField>
        )}
        <FormField label={editing?.kind === 'void' ? 'İptal gerekçesi' : 'Not (isteğe bağlı)'} hint={editing?.kind === 'void' ? 'Deneme silinmez; gerekçe denetim günlüğüne yazılır.' : undefined}>
          <Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {issue && <Alert tone="danger">{issue}</Alert>}
        {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" variant={editing?.kind === 'void' ? 'danger' : 'primary'} loading={pending}>
            {editing?.kind === 'void' ? 'İptal et' : 'Kaydet'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
