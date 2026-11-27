import { CircleCheck, CircleDashed } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PollResultsView } from '@/components/polls/PollResultsView';
import { Alert, Badge, Button, Dialog, FilterChips, Skeleton } from '@/components/ui';
import { usePollParticipation, usePollResults } from '@/hooks/usePolls';
import { useBlocks } from '@/hooks/useUnits';
import { errorMessage } from '@/lib/api/errors';
import { PHASE_LABELS, PHASE_TONES, type Poll, type PollUnitRow, formatFraction } from '@/lib/api/polls';
import { formatDateTime } from '@/lib/dates';

type Tab = 'results' | 'units';
const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'results', label: 'Sonuç' },
  { value: 'units', label: 'Bölüm bazında katılım' },
];

/** Yonetici sonuc penceresi: secenek dagilimi + bolum bazinda katilim (gizli oylamada secim yok). */
export function PollResultsDialog({ poll, onClose }: { poll: Poll | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('results');
  // Kapanirken icerik bos kalmasin diye son secim tutulur.
  const [last, setLast] = useState<Poll | null>(null);
  useEffect(() => {
    if (!poll) return;
    setLast(poll);
    setTab('results');
  }, [poll]);
  const current = poll ?? last;
  const results = usePollResults(current?.pollId);
  const participation = usePollParticipation(current?.pollId, tab === 'units');

  if (!current) return null;
  const phase = results.data?.poll.phase ?? current.phase;

  return (
    <Dialog open={poll !== null} onClose={onClose} title={current.title} variant="wide">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone={PHASE_TONES[phase]}>{PHASE_LABELS[phase]}</Badge>
          <span>
            {formatDateTime(current.opensAt)} – {formatDateTime(current.closedAt ?? current.closesAt)}
          </span>
          <span>{current.secret ? 'Gizli oylama' : 'Açık oylama'}</span>
        </div>

        <FilterChips<Tab> label="Görünüm" value={tab} onChange={setTab} options={TABS} />

        {tab === 'results' ? (
          results.isPending ? (
            <div role="status" aria-label="Sonuçlar yükleniyor" className="flex flex-col gap-3">
              <Skeleton className="h-12" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : results.isError ? (
            <div className="flex flex-col items-start gap-3">
              <Alert tone="danger">{errorMessage(results.error)}</Alert>
              <Button variant="secondary" onClick={() => void results.refetch()}>
                Tekrar dene
              </Button>
            </div>
          ) : (
            <PollResultsView results={results.data.results} />
          )
        ) : participation.isPending ? (
          <div role="status" aria-label="Katılım yükleniyor" className="flex flex-col gap-2">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : participation.isError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert tone="danger">{errorMessage(participation.error)}</Alert>
            <Button variant="secondary" onClick={() => void participation.refetch()}>
              Tekrar dene
            </Button>
          </div>
        ) : (
          <ParticipationTable poll={current} secret={participation.data.secret} rows={participation.data.items} />
        )}

        <div className="flex justify-end pt-2">
          <Button variant="ghost" onClick={onClose}>
            Kapat
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ParticipationTable({ poll, secret, rows }: { poll: Poll; secret: boolean; rows: PollUnitRow[] }) {
  const blocks = useBlocks();
  const blockNames = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const showBlock = new Set(rows.map((r) => r.blockId)).size > 1;
  const optionLabel = (id?: string) => poll.options.find((o) => o.optionId === id)?.label ?? '';
  const voted = rows.filter((r) => r.voted).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small">
        <span className="font-semibold tabular-nums">
          {voted} / {rows.length}
        </span>{' '}
        bölüm oy kullandı.
      </p>
      {secret && <Alert>Gizli oylama: bölümlerin hangi seçeneği işaretlediği hiçbir zaman gösterilmez; yalnızca oy kullanıp kullanmadığı görünür.</Alert>}
      <div className="max-h-96 overflow-auto rounded-xl border border-border">
        <table className="w-full text-left text-small">
          <caption className="sr-only">Bölüm bazında katılım</caption>
          <thead className="sticky top-0 border-b border-border bg-surface text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Bölüm
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Arsa payı
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Durum
              </th>
              {!secret && (
                <th scope="col" className="px-3 py-2 font-medium">
                  Seçim
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.unitId}>
                <td className="px-3 py-2">
                  {showBlock ? `${blockNames.get(r.blockId) ?? 'Blok'} · ` : ''}
                  {r.number}
                  {r.warnings.length > 0 && <span className="block text-xs text-warning">{r.warnings.join(' · ')}</span>}
                </td>
                <td className="px-3 py-2 tabular-nums">{r.landShare ? formatFraction(r.landShare) : '—'}</td>
                <td className="px-3 py-2">
                  {r.voted ? (
                    <span className="inline-flex items-center gap-1.5 text-success">
                      <CircleCheck className="size-4" aria-hidden="true" />
                      Oy kullandı
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-muted">
                      <CircleDashed className="size-4" aria-hidden="true" />
                      Kullanmadı
                    </span>
                  )}
                </td>
                {!secret && (
                  <td className="px-3 py-2">
                    {r.optionId ? optionLabel(r.optionId) : ''}
                    {r.voterRelation === 'tenant' && <span className="block text-xs text-muted">Kiracı</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
