import { Trophy } from 'lucide-react';
import { Alert, Badge } from '@/components/ui';
import { type PollResults, WEIGHTING_LABELS, formatBps, formatFraction, optionBasisBps, outcomeText } from '@/lib/api/pollModel';
import { formatDate } from '@/lib/dates';

type Props = {
  results: PollResults;
  /** Sakinin kendi secimi (vurgulanir). */
  highlightOptionId?: string;
};

/**
 * Oylama sonucu (yonetici ve sakin ortak): katilim, secenek cubuklari ve salt cogunluk sonucu.
 * Cubuk genisligi oylamanin karar olcutundeki paydir (bolum sayisi veya arsa payi).
 */
export function PollResultsView({ results: r, highlightOptionId }: Props) {
  const hasLand = r.eligible.landShare !== null;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
          <dt className="text-xs text-muted">Katılım (bölüm)</dt>
          <dd className="font-semibold tabular-nums">
            {r.participation.units} / {r.eligible.units} bölüm · {formatBps(r.participation.unitsBps)}
          </dd>
        </div>
        {hasLand && r.participation.landShare && r.eligible.landShare && (
          <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
            <dt className="text-xs text-muted">Katılım (arsa payı)</dt>
            <dd className="font-semibold tabular-nums">
              {formatFraction(r.participation.landShare)} · {formatBps(r.participation.landShareBps ?? 0)}
            </dd>
          </div>
        )}
      </dl>

      <p className="text-xs text-muted">
        Karar ölçütü: {WEIGHTING_LABELS[r.weighting].toLocaleLowerCase('tr')} · Oy listesi tarihi {formatDate(r.rollDate)}
      </p>

      {r.tallyHidden ? (
        <Alert>Gizli oylama sürüyor: seçeneklerin dağılımı oylama bitince açıklanır. Şimdilik yalnızca katılım görünür.</Alert>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Seçeneklere göre sonuç">
          {(r.options ?? []).map((o) => {
            const bps = optionBasisBps(o, r.weighting);
            const winner = r.winnerOptionId === o.optionId;
            return (
              <li key={o.optionId} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="inline-flex min-w-0 items-center gap-2 font-medium break-words">
                    {winner && <Trophy className="size-4 shrink-0 text-success" aria-hidden="true" />}
                    {o.label}
                    {highlightOptionId === o.optionId && <Badge tone="accent">Sizin oyunuz</Badge>}
                  </span>
                  <span className="text-small font-semibold tabular-nums">{formatBps(bps)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                  <div className={winner ? 'h-full rounded-full bg-success' : 'h-full rounded-full bg-accent'} style={{ width: `${bps / 100}%` }} />
                </div>
                <p className="text-xs text-muted tabular-nums">
                  {o.units} bölüm ({formatBps(o.unitsBps)})
                  {hasLand && o.landShare ? ` · arsa payı ${formatFraction(o.landShare)} (${formatBps(o.landShareBps ?? 0)})` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {!r.tallyHidden && <p className="text-small font-medium">{outcomeText(r)}</p>}
      {r.warnings.length > 0 && <Alert>{r.warnings.join(' · ')}</Alert>}
    </div>
  );
}
