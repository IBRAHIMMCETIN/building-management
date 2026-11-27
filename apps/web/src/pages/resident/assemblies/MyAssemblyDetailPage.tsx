import { ArrowLeft, CalendarClock, FileText, MapPin } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useMyAssembly } from '@/hooks/useAssemblies';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import {
  CHOICE_LABELS,
  DECISION_LABELS,
  KIND_LABELS,
  MAJORITY_LABELS,
  PORTAL_PHASE_LABELS,
  PORTAL_PHASE_TONES,
  type PortalAssembly,
  type PortalDecision,
  VOTE_CHOICES,
  assembliesApi,
} from '@/lib/api/assemblies';
import { formatBps } from '@/lib/api/pollModel';
import { formatDateTime } from '@/lib/dates';
import { AssemblyQueryState } from './AssemblyQueryState';

/** Sakin genel kurul ayrintisi (kat maliki): toplanti bilgisi, gundem; kesinlesince kararlar ve tutanak. */
export function MyAssemblyDetailPage() {
  const { assemblyId } = useParams();
  const detail = useMyAssembly(assemblyId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/app/genel-kurul" className="inline-flex items-center gap-1 self-start text-small text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Genel Kurul
      </Link>
      {detail.isPending ? (
        <Skeleton className="h-64" />
      ) : detail.isError ? (
        <AssemblyQueryState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Detail key={detail.data.assemblyId} assembly={detail.data} />
      )}
    </div>
  );
}

/** Toplam sayilar: oy (m.31 sinirli), varsa bolum ve arsa payi. Bolum / kisi bazinda bilgi yok. */
function decisionLine(d: PortalDecision) {
  return VOTE_CHOICES.map((k) => {
    const parts = [`${d.votes[k]} oy`];
    if (d.persons) parts.push(`${d.persons[k]} kat maliki`);
    if (d.units) parts.push(`${d.units[k]} bölüm`);
    if (d.landShareBps) parts.push(`arsa payı ${formatBps(d.landShareBps[k])}`);
    return `${CHOICE_LABELS[k]} ${parts.join(' · ')}`;
  }).join(' — ');
}

function Detail({ assembly: a }: { assembly: PortalAssembly }) {
  const doc = useOpenDocument();
  const held = a.phase === 'held';
  const q = a.quorum;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-bold break-words">
          {KIND_LABELS[a.kind]}
          {a.secondMeeting ? ' (ikinci toplantı)' : ''}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone={PORTAL_PHASE_TONES[a.phase]}>{PORTAL_PHASE_LABELS[a.phase]}</Badge>
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden="true" />
            {formatDateTime(a.scheduledAt)}
          </span>
          {a.location && (
            <span className="inline-flex min-w-0 items-center gap-1.5 break-all">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              {a.location}
            </span>
          )}
        </div>
      </div>

      <Card className="flex flex-col gap-3">
        <CardTitle>Toplantı bilgileri</CardTitle>
        <dl className="grid gap-3 text-small sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Tarih ve saat</dt>
            <dd>{formatDateTime(a.scheduledAt)} (Türkiye saati)</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Yer</dt>
            <dd className="break-words">{a.location ?? 'Çevrim içi'}</dd>
          </div>
          {a.onlineUrl && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted">Çevrim içi bağlantı</dt>
              <dd className="break-all">
                <a href={a.onlineUrl} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">
                  {a.onlineUrl}
                </a>
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted">Çağrı</dt>
            <dd>{a.calledAt ? `${formatDateTime(a.calledAt)}${a.lastCalledAt && a.lastCalledAt !== a.calledAt ? ` (güncelleme ${formatDateTime(a.lastCalledAt)})` : ''}` : '—'}</dd>
          </div>
          {a.secondMeetingPlan && (
            <div>
              <dt className="text-xs text-muted">Yeter sayı sağlanamazsa ikinci toplantı</dt>
              <dd className="break-words">
                {formatDateTime(a.secondMeetingPlan.scheduledAt)}
                {a.secondMeetingPlan.location ? ` · ${a.secondMeetingPlan.location}` : ''}
                {a.secondMeetingPlan.onlineUrl && (
                  <>
                    {' · '}
                    <a href={a.secondMeetingPlan.onlineUrl} target="_blank" rel="noreferrer" className="break-all text-accent hover:text-accent-hover">
                      {a.secondMeetingPlan.onlineUrl}
                    </a>
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>
        {a.cancelReason && <Alert>Toplantı iptal edildi: {a.cancelReason}</Alert>}
        <p className="text-small text-muted">
          Toplantıya kendiniz katılabilir veya yazılı vekaletnameyle temsil edilebilirsiniz. E-posta ve bu sayfa bilgilendirme amaçlıdır; yasal çağrı yönetiminizce ayrıca yapılır (KMK m.29).
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>{held ? 'Gündem ve kararlar' : 'Gündem'}</CardTitle>
        {held && q && (
          <Alert tone={q.met || q.secondMeeting ? 'success' : 'info'}>
            {q.secondMeeting
              ? 'İkinci toplantı: toplantı yeter sayısı aranmadı.'
              : q.met
                ? `Toplantı yeter sayısı sağlandı (${q.presentOwners}/${q.totalOwners} kat maliki).`
                : `Toplantı yeter sayısı sağlanamadı${q.noAttendance ? ' (katılım olmadı)' : ` (${q.presentOwners}/${q.totalOwners} kat maliki)`}; karar alınmadı.`}
          </Alert>
        )}
        <ol className="flex flex-col gap-3">
          {a.agenda.map((item, i) => (
            <li key={item.itemId} className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium break-words">
                  {i + 1}. {item.title}
                </p>
                {item.decision && <Badge tone={item.decision.decision === 'accepted' ? 'success' : 'danger'}>{DECISION_LABELS[item.decision.decision]}</Badge>}
              </div>
              {item.description && <p className="text-small whitespace-pre-line break-words text-text-secondary">{item.description}</p>}
              <p className="text-xs text-muted">Gerekli çoğunluk: {MAJORITY_LABELS[item.majority]}</p>
              {item.decision && (
                <p className="text-xs text-muted tabular-nums">
                  {decisionLine(item.decision)}
                  {item.decision.corrected ? ' · karar kaydı düzeltildi' : ''}
                </p>
              )}
              {held && !item.decision && q && (q.met || q.secondMeeting) && <p className="text-xs text-muted">Bu madde için karar kaydı yok.</p>}
            </li>
          ))}
        </ol>
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Toplantı tutanağı</CardTitle>
        {a.minutesAvailable ? (
          <div className="flex flex-col items-start gap-2">
            <Button size="sm" variant="secondary" loading={doc.pendingId === a.assemblyId} onClick={() => void doc.open(a.assemblyId, () => assembliesApi.portalMinutes(a.assemblyId))}>
              <FileText className="size-4" aria-hidden="true" />
              Tutanağı görüntüle (PDF)
            </Button>
            {doc.error && <Alert tone="danger">{doc.error}</Alert>}
          </div>
        ) : (
          <p className="text-small text-muted">{a.phase === 'cancelled' ? 'Toplantı iptal edildi.' : 'Tutanak, toplantıdan sonra yönetim tarafından kesinleştirildiğinde burada görünür.'}</p>
        )}
      </Card>
    </>
  );
}
