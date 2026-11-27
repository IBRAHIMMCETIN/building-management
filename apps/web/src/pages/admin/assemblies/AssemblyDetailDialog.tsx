import { FileText, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useAssembly, useCancelAssembly, useRecordQuorum, useRecordTally, useSetAttendance } from '@/hooks/useAssemblies';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useBlocks, usePeople } from '@/hooks/useUnits';
import {
  ATTENDANCE_MODES,
  type AgendaItem,
  type Assembly,
  type AssemblyUnit,
  type AttendanceInput,
  type AttendanceMode,
  KIND_LABELS,
  MODE_LABELS,
  type Quorum,
  SECOND_MEETING_MAX_DAYS,
  assembliesApi,
  quorumText,
} from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatBps, formatFraction } from '@/lib/api/pollModel';
import { formatDate, formatDateTime } from '@/lib/dates';
import { tallyIssue } from './schemas';

type Props = { assemblyId: string | null; canWrite: boolean; onClose: () => void; onEdit: (a: Assembly) => void };

/** Genel kurul ayrintisi: dondurulmus oy listesi, yeter sayi, gundem sayimlari, katilim ve hazirun. */
export function AssemblyDetailDialog({ assemblyId, canWrite, onClose, onEdit }: Props) {
  const detail = useAssembly(assemblyId ?? undefined);
  const doc = useOpenDocument();
  const data = detail.data;
  const a = data?.assembly;
  const editable = canWrite && a?.status === 'planned';

  return (
    <Dialog open={assemblyId !== null} onClose={onClose} title={a ? `${KIND_LABELS[a.kind]} · ${formatDateTime(a.scheduledAt)}` : 'Genel kurul'} variant="panel">
      {detail.isPending ? (
        <div role="status" aria-label="Toplantı yükleniyor" className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : detail.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(detail.error)}</Alert>
          <Button variant="secondary" onClick={() => void detail.refetch()}>
            Tekrar dene
          </Button>
        </div>
      ) : (
        a &&
        data && (
          <div key={a.assemblyId} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 text-small">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={a.status === 'cancelled' ? 'neutral' : 'accent'}>{a.status === 'cancelled' ? 'İptal edildi' : 'Planlandı'}</Badge>
                {a.secondMeeting && <Badge tone="warning">İkinci toplantı</Badge>}
              </div>
              {a.location && <p>Yer: {a.location}</p>}
              {a.onlineUrl && (
                <p className="break-all">
                  Çevrim içi:{' '}
                  <a href={a.onlineUrl} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">
                    {a.onlineUrl}
                  </a>
                </p>
              )}
              <p className="text-muted">
                Oy listesi (hazirun) tarihi: {formatDate(a.rollDate)} ·{' '}
                {data.rollFrozen && a.roll
                  ? `${formatDateTime(a.roll.frozenAt)} itibarıyla donduruldu`
                  : 'henüz dondurulmadı (ön izleme); ilk katılım, yeter sayı kaydı veya hazirun cetveliyle dondurulur'}
              </p>
              {a.cancelReason && <p className="text-muted">İptal gerekçesi: {a.cancelReason}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="secondary" loading={doc.pendingId === a.assemblyId} onClick={() => void doc.open(a.assemblyId, () => assembliesApi.attendanceSheet(a.assemblyId))}>
                  <FileText className="size-4" aria-hidden="true" />
                  Hazirun cetveli (PDF)
                </Button>
                {editable && !data.rollFrozen && (
                  <Button size="sm" variant="subtle" onClick={() => onEdit(a)}>
                    <Pencil className="size-4" aria-hidden="true" />
                    Düzenle
                  </Button>
                )}
              </div>
              {doc.error && <Alert tone="danger">{doc.error}</Alert>}
            </div>

            <QuorumCard assembly={a} quorum={data.quorum} editable={editable} />

            <Card className="flex flex-col gap-3">
              <CardTitle>Gündem ve sayım</CardTitle>
              <ol className="flex flex-col gap-3">
                {a.agenda.map((item, i) => (
                  <li key={item.itemId}>
                    <AgendaRow index={i} item={item} assembly={a} quorum={data.quorum} canTally={editable && data.quorum.met && a.quorumRecord?.met !== false} />
                  </li>
                ))}
              </ol>
            </Card>

            <AttendanceTable assembly={a} units={data.units} editable={editable} />

            {editable && <CancelBox assembly={a} />}
          </div>
        )
      )}
    </Dialog>
  );
}

function QuorumCard({ assembly: a, quorum: q, editable }: { assembly: Assembly; quorum: Quorum; editable: boolean }) {
  const record = useRecordQuorum(a.assemblyId);
  const tallied = a.agenda.some((i) => i.tally);
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Yeter sayı (KMK m.30)</CardTitle>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
          <dt className="text-xs text-muted">Katılan oy</dt>
          <dd className="font-semibold tabular-nums">
            {q.presentVotes} / {q.totalVotes} · {formatBps(q.unitsBps)}{' '}
            <span className="text-xs font-normal text-muted">
              ({q.presentUnits}/{q.totalUnits} bölüm{q.proxyUnits > 0 ? `, ${q.proxyUnits} vekaleten` : ''})
            </span>
          </dd>
        </div>
        <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
          <dt className="text-xs text-muted">Katılan arsa payı</dt>
          <dd className="font-semibold tabular-nums">{q.presentLandShare ? `${formatFraction(q.presentLandShare)} · ${formatBps(q.landShareBps ?? 0)}` : 'Hesaplanamıyor'}</dd>
        </div>
      </dl>
      <Alert tone={q.met ? 'success' : 'info'}>{quorumText(q)}</Alert>
      {q.met && <p className="text-small text-muted">Karar yeter sayısı: katılanların oy çokluğu (en az {q.decisionThreshold} kabul oyu).</p>}
      {q.warnings.length > 0 && <Alert>{q.warnings.join(' · ')}</Alert>}
      {a.quorumRecord && (
        <p className="text-small">
          Tutanak: yeter sayı {a.quorumRecord.met ? 'sağlandı' : 'sağlanmadı'} ({a.quorumRecord.presentVotes}/{a.quorumRecord.totalVotes} oy, {formatDateTime(a.quorumRecord.recordedAt)}).
          {!a.quorumRecord.met && !a.secondMeeting && ` Karar için en geç ${SECOND_MEETING_MAX_DAYS} gün içinde bu toplantıya bağlı ikinci toplantı oluşturun.`}
        </p>
      )}
      {editable && !tallied && (
        <div className="flex flex-col items-start gap-2">
          <Button size="sm" variant="secondary" loading={record.isPending} onClick={() => record.mutate(a.version)}>
            Yeter sayıyı tutanağa geçir
          </Button>
          {record.isError && <Alert tone="danger">{errorMessage(record.error)}</Alert>}
        </div>
      )}
    </Card>
  );
}

function AgendaRow({ index, item, assembly, quorum, canTally }: { index: number; item: AgendaItem; assembly: Assembly; quorum: Quorum; canTally: boolean }) {
  const record = useRecordTally(assembly.assemblyId);
  const [values, setValues] = useState({ yes: String(item.tally?.yes ?? ''), no: String(item.tally?.no ?? ''), abstain: String(item.tally?.abstain ?? '') });
  const [issue, setIssue] = useState<string | null>(null);
  const parsed = { yes: Number(values.yes || 0), no: Number(values.no || 0), abstain: Number(values.abstain || 0) };

  const save = async () => {
    const problem = tallyIssue(parsed, quorum.presentVotes);
    setIssue(problem);
    if (problem) return;
    try {
      await record.mutateAsync({ itemId: item.itemId, version: assembly.version, ...parsed });
    } catch {
      // Hata satirda gosterilir.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium break-words">
          {index + 1}. {item.title}
        </p>
        {item.tally && <Badge tone={item.tally.decision === 'accepted' ? 'success' : 'danger'}>{item.tally.decision === 'accepted' ? 'Kabul edildi' : 'Reddedildi'}</Badge>}
      </div>
      {item.description && <p className="text-small text-muted">{item.description}</p>}
      {item.tally && (
        <p className="text-xs text-muted tabular-nums">
          Kabul {item.tally.yes} · Ret {item.tally.no} · Çekimser {item.tally.abstain} · Katılan {item.tally.presentVotes} oy · {formatDateTime(item.tally.recordedAt)}
        </p>
      )}
      {canTally && (
        <div className="flex flex-wrap items-end gap-2">
          {(['yes', 'no', 'abstain'] as const).map((k) => (
            <div key={k} className="w-24">
              <FormField label={k === 'yes' ? 'Kabul' : k === 'no' ? 'Ret' : 'Çekimser'}>
                <Input type="number" inputMode="numeric" min={0} max={quorum.presentVotes} value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              </FormField>
            </div>
          ))}
          <Button size="sm" loading={record.isPending} onClick={() => void save()}>
            {item.tally ? 'Sayımı düzelt' : 'Sayımı kaydet'}
          </Button>
        </div>
      )}
      {(issue || record.isError) && <Alert tone="danger">{issue ?? errorMessage(record.error)}</Alert>}
    </div>
  );
}

function AttendanceTable({ assembly, units, editable }: { assembly: Assembly; units: AssemblyUnit[]; editable: boolean }) {
  const blocks = useBlocks();
  const people = usePeople();
  const blockNames = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const showBlock = new Set(units.map((u) => u.blockId)).size > 1;
  const persons = useMemo(() => [...(people.data ?? [])].sort((x, y) => x.fullName.localeCompare(y.fullName, 'tr')), [people.data]);
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Katılım (hazirun)</CardTitle>
      <p className="text-small text-muted">
        Hisseli bölümü paydaşların seçtiği tek kişi temsil eder. Vekil (KMK m.31) yazılı vekaletnameyle katılır; 40 ve daha az bölümde en fazla iki kat malikini, üstünde oyların %5&apos;ini
        temsil edebilir.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-small">
          <caption className="sr-only">Bölüm bazında katılım</caption>
          <thead className="border-b border-border bg-surface-muted/50 text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Bölüm
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Kat maliki
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Arsa payı
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Katılım
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {units.map((u) => (
              <tr key={u.unitId} className="align-top">
                <td className="px-3 py-2">
                  {showBlock ? `${blockNames.get(u.blockId) ?? 'Blok'} · ` : ''}
                  {u.number}
                </td>
                <td className="px-3 py-2">
                  {u.owners.length ? u.owners.map((o) => `${o.name ?? 'Kayıtlı kişi'}${o.share ? ` (${o.share.numerator}/${o.share.denominator})` : ''}`).join(', ') : <span className="text-muted">Malik kaydı yok</span>}
                  {u.warnings.length > 0 && <span className="block text-xs text-warning">{u.warnings.join(' · ')}</span>}
                </td>
                <td className="px-3 py-2 tabular-nums">{u.landShare ? formatFraction(u.landShare) : '—'}</td>
                <td className="px-3 py-2">
                  {editable ? (
                    <AttendanceCell assemblyId={assembly.assemblyId} unit={u} persons={persons} />
                  ) : (
                    <span>
                      {u.attendance
                        ? `${MODE_LABELS[u.attendance.mode]}${u.attendance.attendee?.name ? ` · ${u.attendance.attendee.name}` : ''}${u.attendance.proxy ? ` · ${u.attendance.proxy.name}` : ''}`
                        : '—'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const OTHER = '__other__';

function AttendanceCell({ assemblyId, unit, persons }: { assemblyId: string; unit: AssemblyUnit; persons: { userId: string; fullName: string }[] }) {
  const set = useSetAttendance(assemblyId);
  const att = unit.attendance;
  const [mode, setMode] = useState<AttendanceMode>(att?.mode ?? 'absent');
  const [attendee, setAttendee] = useState(att?.attendee?.userId ?? '');
  const [proxyUser, setProxyUser] = useState(att?.proxy ? (att.proxy.userId ?? OTHER) : '');
  const [proxyName, setProxyName] = useState(att?.proxy && !att.proxy.userId ? att.proxy.name : '');
  const ownerIds = new Set(unit.owners.map((o) => o.userId));
  const proxyChoices = persons.filter((p) => !ownerIds.has(p.userId));

  const input: AttendanceInput | null =
    mode === 'proxy'
      ? proxyUser && proxyUser !== OTHER
        ? { mode, proxyUserId: proxyUser }
        : proxyName.trim().length >= 3
          ? { mode, proxyName: proxyName.trim() }
          : null
      : mode === 'present'
        ? { mode, ...(attendee ? { attendeeUserId: attendee } : {}) }
        : { mode };
  const savedKey = JSON.stringify(
    att ? { mode: att.mode, a: att.attendee?.userId ?? '', p: att.proxy?.userId ?? '', n: att.proxy && !att.proxy.userId ? att.proxy.name : '' } : { mode: 'absent', a: '', p: '', n: '' },
  );
  const currentKey = JSON.stringify({ mode, a: mode === 'present' ? attendee : '', p: mode === 'proxy' && proxyUser !== OTHER ? proxyUser : '', n: mode === 'proxy' && proxyUser === OTHER ? proxyName.trim() : '' });
  const dirty = savedKey !== currentKey;
  const label = `${unit.number}`;

  return (
    <div className="flex min-w-48 flex-col gap-1.5">
      <Select aria-label={`${label} katılım`} value={mode} onChange={(e) => setMode(e.target.value as AttendanceMode)}>
        {ATTENDANCE_MODES.map((m) => (
          <option key={m} value={m}>
            {MODE_LABELS[m]}
          </option>
        ))}
      </Select>
      {mode === 'present' && unit.owners.length > 1 && (
        <Select aria-label={`${label} katılan paydaş`} value={attendee} onChange={(e) => setAttendee(e.target.value)}>
          <option value="">Temsilci paydaş (isteğe bağlı)</option>
          {unit.owners.map((o) => (
            <option key={o.userId} value={o.userId}>
              {o.name ?? 'Kayıtlı kişi'}
            </option>
          ))}
        </Select>
      )}
      {mode === 'proxy' && (
        <>
          <Select aria-label={`${label} vekil`} value={proxyUser} onChange={(e) => setProxyUser(e.target.value)}>
            <option value="">Vekil seçin</option>
            {proxyChoices.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.fullName}
              </option>
            ))}
            <option value={OTHER}>Apartman dışından (ad yazın)</option>
          </Select>
          {proxyUser === OTHER && (
            <Input aria-label={`${label} vekil adı`} placeholder="Vekilin adı soyadı" maxLength={150} value={proxyName} onChange={(e) => setProxyName(e.target.value)} />
          )}
        </>
      )}
      {dirty && (
        <Button size="xs" className="self-start" loading={set.isPending} disabled={!input} onClick={() => input && set.mutate({ unitId: unit.unitId, ...input })}>
          Kaydet
        </Button>
      )}
      {set.isError && <p className="text-xs text-danger">{errorMessage(set.error)}</p>}
    </div>
  );
}

function CancelBox({ assembly }: { assembly: Assembly }) {
  const cancel = useCancelAssembly();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Toplantıyı iptal et
        </Button>
      </div>
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <FormField label="İptal gerekçesi" hint="Gerekçe denetim günlüğüne yazılır. Kayıt silinmez.">
        <Textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {cancel.isError && <Alert tone="danger">{errorMessage(cancel.error)}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={cancel.isPending}>
          Vazgeç
        </Button>
        <Button variant="danger" loading={cancel.isPending} disabled={reason.trim().length < 3} onClick={() => cancel.mutate({ id: assembly.assemblyId, version: assembly.version, reason: reason.trim() })}>
          İptal et
        </Button>
      </div>
    </Card>
  );
}
