import { BarChart3, Ban, CalendarClock, Eye, Lock, Pencil, Plus, Scale, Send, Users, Vote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Skeleton, Textarea } from '@/components/ui';
import { useCancelPoll, useClosePoll, usePollPermissions, usePolls, usePublishPoll } from '@/hooks/usePolls';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { AUDIENCE_LABELS, PHASE_LABELS, PHASE_TONES, type Poll, type PollPhaseFilter, WEIGHTING_LABELS } from '@/lib/api/polls';
import { formatDateTime } from '@/lib/dates';
import { PollDialog } from './PollDialog';
import { PollResultsDialog } from './PollResultsDialog';
import { closeReasonSchema } from './schemas';

const FILTERS: readonly { value: PollPhaseFilter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'draft', label: 'Taslak' },
  { value: 'scheduled', label: 'Planlı' },
  { value: 'open', label: 'Oylamada' },
  { value: 'closed', label: 'Sona erdi' },
  { value: 'cancelled', label: 'İptal' },
];

type Confirm = { kind: 'publish' | 'close' | 'cancel'; item: Poll } | null;
type Editor = { item?: Poll } | null;

export function PollsPage() {
  const { canRead, canWrite } = usePollPermissions();
  const list = usePolls('all');
  const [filter, setFilter] = useState<PollPhaseFilter>('all');
  const [editor, setEditor] = useState<Editor>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [resultsOf, setResultsOf] = useState<Poll | null>(null);

  const items = list.data ?? [];
  const visible = items.filter((p) => filter === 'all' || p.phase === filter);

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Oylamalar</h1>
        <Alert>Bu rol oylamaları görüntüleyemez.</Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Oylamalar</h1>
          <p className="text-small text-muted">Kat malikleri veya sakinler için anket ve oylama düzenleyin; sonuçları bölüm ve arsa payına göre izleyin.</p>
        </div>
        {canWrite && (
          <Button onClick={() => setEditor({})}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni oylama
          </Button>
        )}
      </div>

      <FilterChips<PollPhaseFilter>
        label="Duruma göre filtrele"
        value={filter}
        onChange={setFilter}
        options={FILTERS.map((f) => ({ ...f, count: list.data ? items.filter((p) => f.value === 'all' || p.phase === f.value).length : undefined }))}
      />

      {list.isPending ? (
        <div role="status" aria-label="Oylamalar yükleniyor" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-8" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(list.error)}</Alert>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            Tekrar dene
          </Button>
        </Card>
      ) : visible.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Vote className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">{items.length === 0 ? 'Henüz oylama yok' : 'Bu filtrede oylama yok'}</p>
          {items.length === 0 && canWrite && (
            <Button variant="secondary" onClick={() => setEditor({})}>
              İlk oylamayı oluşturun
            </Button>
          )}
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {visible.map((p) => (
            <li key={p.pollId}>
              <PollCard
                item={p}
                canWrite={canWrite}
                onEdit={() => setEditor({ item: p })}
                onResults={() => setResultsOf(p)}
                onConfirm={(kind) => setConfirm({ kind, item: p })}
              />
            </li>
          ))}
        </ul>
      )}

      <PollResultsDialog poll={resultsOf} onClose={() => setResultsOf(null)} />
      {canWrite && (
        <>
          <PollDialog open={editor !== null} onClose={() => setEditor(null)} poll={editor?.item} />
          <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </>
      )}
    </div>
  );
}

type CardProps = {
  item: Poll;
  canWrite: boolean;
  onEdit: () => void;
  onResults: () => void;
  onConfirm: (kind: 'publish' | 'close' | 'cancel') => void;
};

function PollCard({ item, canWrite, onEdit, onResults, onConfirm }: CardProps) {
  const when =
    item.phase === 'closed'
      ? `Sona erdi: ${formatDateTime(item.closedAt ?? item.closesAt)}${item.closedEarly ? ' (erken kapatıldı)' : ''}`
      : item.phase === 'cancelled'
        ? `İptal edildi${item.cancelledAt ? `: ${formatDateTime(item.cancelledAt)}` : ''}`
        : item.phase === 'draft'
          ? `Bitiş: ${formatDateTime(item.closesAt)}`
          : `${formatDateTime(item.opensAt)} – ${formatDateTime(item.closesAt)}`;
  const live = item.phase === 'open' || item.phase === 'scheduled';

  return (
    <Card interactive className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 text-base font-semibold break-words text-text md:text-lg">{item.title}</h2>
        <Badge tone={PHASE_TONES[item.phase]}>{PHASE_LABELS[item.phase]}</Badge>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-3.5" aria-hidden="true" />
          {AUDIENCE_LABELS[item.audience]}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Scale className="size-3.5" aria-hidden="true" />
          {WEIGHTING_LABELS[item.weighting]}
        </span>
        <span className="inline-flex items-center gap-1.5">
          {item.secret ? <Lock className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
          {item.secret ? 'Gizli oylama' : 'Açık oylama'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock className="size-3.5" aria-hidden="true" />
          {when}
        </span>
      </p>
      {item.description && <p className="line-clamp-3 text-sm leading-relaxed whitespace-pre-line break-words text-text-secondary">{item.description}</p>}
      <ol className="flex flex-wrap gap-2">
        {item.options.map((o, i) => (
          <li key={o.optionId} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-secondary">
            {i + 1}. {o.label}
          </li>
        ))}
      </ol>
      {item.closeReason && <p className="text-xs text-muted">Kapatma gerekçesi: {item.closeReason}</p>}

      <div className="-mx-2.5 -mb-1.5 flex flex-wrap items-center justify-end gap-1 pt-1">
        {item.phase !== 'draft' && item.phase !== 'cancelled' && (
          <Button size="xs" variant="subtle" onClick={onResults}>
            <BarChart3 className="size-3.5" aria-hidden="true" />
            Sonuçlar
          </Button>
        )}
        {canWrite && item.phase === 'draft' && (
          <>
            <Button size="xs" variant="subtle" onClick={onEdit}>
              <Pencil className="size-3.5" aria-hidden="true" />
              Düzenle
            </Button>
            <Button size="xs" variant="subtle" onClick={() => onConfirm('cancel')}>
              <Ban className="size-3.5" aria-hidden="true" />
              İptal et
            </Button>
            <Button size="xs" onClick={() => onConfirm('publish')}>
              <Send className="size-3.5" aria-hidden="true" />
              Yayınla
            </Button>
          </>
        )}
        {canWrite && live && (
          <Button size="xs" variant="subtle" onClick={() => onConfirm('close')}>
            <Ban className="size-3.5" aria-hidden="true" />
            Erken kapat
          </Button>
        )}
      </div>
    </Card>
  );
}

const CONFIRM_TITLES = { publish: 'Oylamayı yayınla', close: 'Oylamayı erken kapat', cancel: 'Taslağı iptal et' } as const;
const CONFIRM_ACTIONS = { publish: 'Yayınla', close: 'Oylamayı kapat', cancel: 'İptal et' } as const;

function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) {
  const publish = usePublishPoll();
  const close = useClosePoll();
  const cancel = useCancelPoll();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  // Kapanirken icerik bos kalmasin diye son secim tutulur.
  const [last, setLast] = useState<NonNullable<Confirm> | null>(null);
  useEffect(() => {
    if (!confirm) return;
    setLast(confirm);
    setReason('');
    setReasonError(undefined);
    publish.reset();
    close.reset();
    cancel.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca yeni secimde
  }, [confirm]);
  const current = confirm ?? last;
  if (!current) return null;

  const mutation = current.kind === 'publish' ? publish : current.kind === 'close' ? close : cancel;
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const { item } = current;
  const future = Date.parse(item.opensAt) > Date.now();

  const run = async () => {
    try {
      if (current.kind === 'close') {
        const parsed = closeReasonSchema.safeParse({ reason });
        if (!parsed.success) {
          setReasonError(parsed.error.issues[0]?.message);
          return;
        }
        await close.mutateAsync({ id: item.pollId, version: item.version, reason: parsed.data.reason });
      } else if (current.kind === 'publish') {
        await publish.mutateAsync({ id: item.pollId, version: item.version });
      } else {
        await cancel.mutateAsync({ id: item.pollId, version: item.version });
      }
      onClose();
    } catch {
      // Hata diyalogda gosterilir; liste onSettled ile yenilenir.
    }
  };

  return (
    <Dialog open={confirm !== null} onClose={() => !mutation.isPending && onClose()} title={CONFIRM_TITLES[current.kind]}>
      <div className="flex flex-col gap-4">
        <p className="font-medium break-words">“{item.title}”</p>
        {current.kind === 'publish' && (
          <div className="flex flex-col gap-2 text-small text-muted">
            <p>
              {future
                ? `Oylama ${formatDateTime(item.opensAt)} tarihinde açılacak ve ${formatDateTime(item.closesAt)} tarihinde sona erecek.`
                : `Oylama hemen açılacak ve ${formatDateTime(item.closesAt)} tarihinde sona erecek.`}{' '}
              {AUDIENCE_LABELS[item.audience]} bildirim alır.
            </p>
            <p>Yayınlandıktan sonra soru, seçenekler ve kurallar değiştirilemez. Oy listesi başlangıç günündeki mülkiyet kayıtlarına göre sabitlenir.</p>
          </div>
        )}
        {current.kind === 'cancel' && <p className="text-small text-muted">Taslak iptal edilir ve artık düzenlenemez. Kayıt silinmez.</p>}
        {current.kind === 'close' && (
          <>
            <p className="text-small text-muted">
              Oylama bitiş zamanından önce kapatılır, yeni oy kabul edilmez ve sonuç kullanılan oylara göre kesinleşir. İşlem gerekçesiyle denetim günlüğüne yazılır.
              {item.secret && item.phase === 'open' && ' Gizli oylama en az 3 bölüm oy kullanmadan erken kapatılamaz; hangi bölümün oy kullandığı planlanan bitişe kadar gizli kalır.'}
            </p>
            <FormField label="Kapatma gerekçesi" error={reasonError}>
              <Textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Kat malikleri kurulunda karar alındı" />
            </FormField>
          </>
        )}
        {mutation.isError && (
          <Alert tone="danger">
            {conflict ? 'Oylama bu arada başka biri tarafından değiştirildi. Liste yenilendi; kontrol edip tekrar deneyin.' : errorMessage(mutation.error)}
          </Alert>
        )}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Vazgeç
          </Button>
          {!conflict && (
            <Button variant={current.kind === 'publish' ? 'primary' : 'danger'} loading={mutation.isPending} onClick={() => void run()}>
              {CONFIRM_ACTIONS[current.kind]}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
