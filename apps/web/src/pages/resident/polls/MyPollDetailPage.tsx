import { ArrowLeft, CheckCircle2, Lock, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { PollResultsView } from '@/components/polls/PollResultsView';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useMyPoll, useVote } from '@/hooks/usePolls';
import { errorMessage } from '@/lib/api/errors';
import { AUDIENCE_LABELS, PHASE_LABELS, PHASE_TONES, type PortalPoll, WEIGHTING_LABELS, myVoteText } from '@/lib/api/polls';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/dates';

/** Sakin oylama ayrintisi: oy verme / degistirme, kendi oyum ve (aciksa) sonuclar. */
export function MyPollDetailPage() {
  const { pollId } = useParams();
  const detail = useMyPoll(pollId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/app/oylamalar" className="inline-flex items-center gap-1 self-start text-small text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Oylamalar
      </Link>
      {detail.isPending ? (
        <Skeleton className="h-64" />
      ) : detail.isError ? (
        <PortalQueryState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Detail key={`${detail.data.pollId}-${detail.data.unitId}`} poll={detail.data} />
      )}
    </div>
  );
}

function Detail({ poll: p }: { poll: PortalPoll }) {
  const vote = useVote(p.pollId);
  const [choice, setChoice] = useState<string | undefined>(p.myVote?.optionId);
  const mine = myVoteText(p);
  const changing = Boolean(p.myVote);

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-bold break-words">{p.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone={PHASE_TONES[p.phase]}>{PHASE_LABELS[p.phase]}</Badge>
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5" aria-hidden="true" />
            {AUDIENCE_LABELS[p.audience]} · {WEIGHTING_LABELS[p.weighting]}
          </span>
          <span>
            {formatDateTime(p.opensAt)} – {formatDateTime(p.closedAt ?? p.closesAt)}
            {p.closedEarly ? ' (erken kapatıldı)' : ''}
          </span>
        </div>
        {p.description && <p className="text-sm leading-relaxed whitespace-pre-line break-words text-text-secondary">{p.description}</p>}
      </div>

      <Card className="flex flex-col gap-4">
        <CardTitle>{p.phase === 'open' && p.canVote ? (changing ? 'Oyunuzu değiştirin' : 'Oyunuzu kullanın') : 'Oyunuz'}</CardTitle>

        {mine && (
          <p className="inline-flex items-center gap-2 text-small font-medium text-success">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            {mine}
          </p>
        )}

        {!p.eligible && p.ineligibleReason && <Alert>{p.ineligibleReason}. Oy listesi yönetimin mülkiyet kayıtlarından hazırlanır; bir hata olduğunu düşünüyorsanız yönetiminize başvurun.</Alert>}

        {p.canVote ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (choice) vote.mutate(choice);
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Seçenekler</legend>
              {p.options.map((o) => (
                <label
                  key={o.optionId}
                  className={cn(
                    'flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 hover:border-accent',
                    choice === o.optionId && 'border-accent bg-accent/10',
                  )}
                >
                  <input type="radio" name="option" value={o.optionId} checked={choice === o.optionId} onChange={() => setChoice(o.optionId)} className="size-4 accent-accent" />
                  <span className="break-words">{o.label}</span>
                </label>
              ))}
            </fieldset>
            {vote.isError && <Alert tone="danger">{errorMessage(vote.error)}</Alert>}
            {vote.isSuccess && <Alert tone="success">Oyunuz kaydedildi. Oylama bitene kadar değiştirebilirsiniz.</Alert>}
            <Button type="submit" className="self-start" loading={vote.isPending} disabled={!choice || (p.myVote?.castByMe && choice === p.myVote.optionId)}>
              {changing ? 'Oyumu değiştir' : 'Oyu gönder'}
            </Button>
          </form>
        ) : (
          p.phase !== 'open' && <p className="text-small text-muted">{p.phase === 'closed' ? 'Oylama sona erdi; oy kabul edilmiyor.' : 'Oylama henüz başlamadı.'}</p>
        )}

        <ul className="flex flex-col gap-1.5 text-small text-muted">
          <li>
            Her bağımsız bölüm tek oy kullanır. Bölümünüzün başka bir {p.audience === 'owners' ? 'paydaşı (hisseli mülkiyet)' : 'sakini veya maliki'} de oy verebilir; oylama bitene kadar verilen son oy
            geçerlidir.
          </li>
          <li className="inline-flex items-start gap-1.5">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {p.secret
              ? 'Gizli oylama: yönetim hangi bölümün hangi seçeneği işaretlediğini göremez.'
              : 'Açık oylama: yönetim hangi bölümün hangi seçeneği işaretlediğini görebilir.'}
          </li>
          <li>Oy hakkı {formatDate(p.rollDate)} tarihli mülkiyet kayıtlarına göre belirlenir.</li>
        </ul>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>Sonuçlar</CardTitle>
        {p.results ? (
          <PollResultsView results={p.results} highlightOptionId={p.myVote?.castByMe ? p.myVote.optionId : undefined} />
        ) : (
          <p className="text-small text-muted">
            {p.resultsAvailable
              ? 'Sonuçlar yükleniyor…'
              : p.resultsAfterVote
                ? 'Ara sonuçlar dairenizin oyu kullanıldıktan sonra görünür.'
                : 'Sonuçlar oylama bitince açıklanır.'}
          </p>
        )}
      </Card>
    </>
  );
}
