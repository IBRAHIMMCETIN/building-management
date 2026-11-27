import { Link } from 'react-router';
import { Badge } from '@/components/ui';
import type { TenderSummary } from '@/lib/api/tenders';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { istanbulToday } from '@/lib/reservations/model';
import { TENDER_CATEGORY_LABELS, TENDER_STATUS_LABELS, TENDER_STATUS_TONES, deadlineText } from '@/lib/tenders/model';

/** Liste karti (yonetim ve sakin portali ayni ozeti kullanir). */
export function TenderCard({ tender: t, to }: { tender: TenderSummary; to: string }) {
  const collecting = t.status === 'draft' || t.status === 'collecting';
  return (
    <Link
      to={to}
      className={cn(
        'flex h-full flex-col gap-2 rounded-xl border border-border bg-surface/60 p-4 shadow-sm transition-colors hover:border-border-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
    >
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 font-semibold break-words">{t.title}</span>
        <Badge tone={TENDER_STATUS_TONES[t.status]}>{TENDER_STATUS_LABELS[t.status]}</Badge>
      </span>
      <span className="text-xs text-muted">
        {TENDER_CATEGORY_LABELS[t.category]}
        {t.ticket ? ` · ${t.ticket.number}` : ''}
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-small">
        <span>
          <span className="text-muted">Teklif: </span>
          <span className={cn('tabular-nums', t.quoteCount < t.minQuotes && collecting && 'text-warning')}>
            {t.quoteCount}/{t.minQuotes}
          </span>
        </span>
        {t.lowestTotalKurus !== undefined && (
          <span>
            <span className="text-muted">En düşük: </span>
            <span className="tabular-nums">{formatTRY(t.lowestTotalKurus)}</span>
          </span>
        )}
      </span>
      {t.decision ? (
        <span className="text-small">
          <span className="text-muted">Seçilen: </span>
          {t.decision.supplierName} · <span className="tabular-nums">{formatTRY(t.decision.totalKurus)}</span>
        </span>
      ) : collecting ? (
        <span className={cn('text-xs', t.deadlinePassed ? 'text-warning' : 'text-muted')}>
          Son teklif: {formatDate(t.deadline)} · {deadlineText(t.deadline, istanbulToday())}
        </span>
      ) : null}
    </Link>
  );
}
