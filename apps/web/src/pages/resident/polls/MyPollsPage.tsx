import { ChevronRight, Vote } from 'lucide-react';
import { Link } from 'react-router';
import { ChangeUnitLink, PortalQueryState } from '@/components/portal/PortalQueryState';
import { Badge, Card, Skeleton } from '@/components/ui';
import { useMyPolls } from '@/hooks/usePolls';
import { AUDIENCE_LABELS, PHASE_LABELS, PHASE_TONES, type PortalPoll } from '@/lib/api/polls';
import { formatDateTime } from '@/lib/dates';

/** Sakin "Oylamalar": dairemin katilabildigi acik oylamalar once, ardindan bitenler. */
export function MyPollsPage() {
  const list = useMyPolls();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-title font-bold">Oylamalar</h1>
        <ChangeUnitLink />
      </div>

      {list.isPending ? (
        <div role="status" aria-label="Oylamalar yükleniyor" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Vote className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Açık oylama yok</p>
          <p className="text-small text-muted">Yönetiminiz bir anket veya oylama başlattığında burada görünecek.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.data.map((p) => (
            <li key={p.pollId}>
              <PollLink poll={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PollLink({ poll: p }: { poll: PortalPoll }) {
  const voted = Boolean(p.myVote);
  const status =
    p.phase === 'open'
      ? voted
        ? { tone: 'success' as const, label: p.myVote?.castByMe ? 'Oy verdiniz' : 'Dairenizin oyu kullanıldı' }
        : p.canVote
          ? { tone: 'accent' as const, label: 'Oyunuzu bekliyor' }
          : { tone: 'neutral' as const, label: 'Oy hakkınız yok' }
      : { tone: PHASE_TONES[p.phase], label: PHASE_LABELS[p.phase] };
  return (
    <Link
      to={`/app/oylamalar/${encodeURIComponent(p.pollId)}`}
      className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs hover:border-border-strong"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium break-words">{p.title}</span>
        <span className="text-xs text-muted">
          {AUDIENCE_LABELS[p.audience]} · {p.phase === 'open' ? `Bitiş: ${formatDateTime(p.closesAt)}` : `Sona erdi: ${formatDateTime(p.closedAt ?? p.closesAt)}`}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={status.tone}>{status.label}</Badge>
          {p.resultsAvailable && p.phase === 'closed' && <span className="text-xs text-muted">Sonuçlar açıklandı</span>}
        </span>
      </span>
      <ChevronRight className="size-5 text-muted" aria-hidden="true" />
    </Link>
  );
}
