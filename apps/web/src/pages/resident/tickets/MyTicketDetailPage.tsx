import { ArrowLeft, Star } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { PhotoPicker, uploadPhotos } from '@/components/tickets/PhotoPicker';
import { TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { TicketTimeline } from '@/components/tickets/TicketTimeline';
import { Alert, Button, Card, CardTitle, FormField, Skeleton, Textarea } from '@/components/ui';
import { useMyTicket, useMyTicketActions } from '@/hooks/usePortalTickets';
import { errorMessage } from '@/lib/api/errors';
import { portalTicketsApi } from '@/lib/api/portalTickets';
import type { Ticket } from '@/lib/api/tickets';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/dates';
import { CATEGORY_LABELS, RATING_LABELS } from '@/lib/tickets/model';

/** Sakin talep ayrintisi: yalnizca herkese acik olaylar; onay (1-5 puan), yeniden acma, geri cekme, yorum. */
export function MyTicketDetailPage() {
  const { ticketId } = useParams();
  const detail = useMyTicket(ticketId);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/app/talepler" className="inline-flex items-center gap-1 self-start text-small text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Taleplerim
      </Link>
      {detail.isPending ? (
        <Skeleton className="h-64" />
      ) : detail.isError ? (
        <Alert tone="danger">{errorMessage(detail.error)}</Alert>
      ) : (
        <Detail key={`${detail.data.ticket.ticketId}-${detail.data.ticket.version}`} ticket={detail.data.ticket} events={detail.data.events} />
      )}
    </div>
  );
}

function Detail({ ticket, events }: { ticket: Ticket; events: Parameters<typeof TicketTimeline>[0]['events'] }) {
  const can = (a: string) => ticket.actions.includes(a);
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">
          <span className="font-mono">{ticket.number}</span> · {CATEGORY_LABELS[ticket.category]} · {formatDateTime(ticket.createdAt)}
        </span>
        <h1 className="text-title font-bold">{ticket.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <TicketStatusBadge status={ticket.status} />
          {ticket.location.kind === 'common' ? <span className="text-small text-muted">Ortak alan · {ticket.location.area}</span> : <span className="text-small text-muted">Daire içi</span>}
          {ticket.assigned && ticket.status !== 'closed' && <span className="text-small text-muted">· Görevli atandı</span>}
        </div>
      </div>
      <p className="whitespace-pre-wrap rounded-lg bg-surface-muted/40 p-3 text-small">{ticket.description}</p>

      {can('confirm') && <ConfirmCard ticket={ticket} canReopen={can('reopen')} />}
      {!can('confirm') && can('reopen') && <ReopenCard ticket={ticket} />}
      {ticket.rating && (
        <p className="text-small">
          Puanınız: <strong>{ticket.rating.score}/5</strong> ({RATING_LABELS[ticket.rating.score]})
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Gelişmeler</h2>
        <TicketTimeline events={events} loadPhoto={(photoId) => portalTicketsApi.photo(ticket.ticketId, photoId)} />
      </section>

      {ticket.status !== 'closed' && ticket.status !== 'cancelled' && <CommentCard ticket={ticket} />}
      {can('cancel') && <WithdrawCard ticket={ticket} />}
    </>
  );
}

export function RatingInput({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Puan" className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} - ${RATING_LABELS[n]}`} onClick={() => onChange(n)} className="grid size-10 place-items-center rounded-md hover:bg-surface-muted">
          <Star className={cn('size-6', value !== null && n <= value ? 'fill-warning text-warning' : 'text-muted')} aria-hidden="true" />
        </button>
      ))}
      {value !== null && <span className="ml-2 text-small text-muted">{RATING_LABELS[value]}</span>}
    </div>
  );
}

function ConfirmCard({ ticket, canReopen }: { ticket: Ticket; canReopen: boolean }) {
  const act = useMyTicketActions(ticket.ticketId);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [reopening, setReopening] = useState(false);
  if (reopening) return <ReopenCard ticket={ticket} onCancel={() => setReopening(false)} />;
  return (
    <Card className="flex flex-col gap-3 border-success/40">
      <CardTitle>Sorun çözüldü mü?</CardTitle>
      <p className="text-small text-muted">Yönetim talebi çözüldü olarak işaretledi. Onaylarsanız talep kapanır; onaylamazsanız birkaç gün içinde otomatik kapanır.</p>
      <RatingInput value={rating} onChange={setRating} />
      <FormField label="Not (isteğe bağlı)">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </FormField>
      {act.confirm.isError && <Alert tone="danger">{errorMessage(act.confirm.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button loading={act.confirm.isPending} onClick={() => act.confirm.mutate({ version: ticket.version, ...(rating ? { rating } : {}), ...(note.trim() ? { note: note.trim() } : {}) })}>
          Onayla ve kapat
        </Button>
        {canReopen && (
          <Button variant="secondary" onClick={() => setReopening(true)}>
            Hâlâ sorun var
          </Button>
        )}
      </div>
    </Card>
  );
}

function ReopenCard({ ticket, onCancel }: { ticket: Ticket; onCancel?: () => void }) {
  const act = useMyTicketActions(ticket.ticketId);
  const [note, setNote] = useState('');
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Talebi yeniden aç</CardTitle>
      <FormField label="Sorun neden devam ediyor?">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </FormField>
      {act.reopen.isError && <Alert tone="danger">{errorMessage(act.reopen.error)}</Alert>}
      <div className="flex gap-2">
        <Button loading={act.reopen.isPending} disabled={note.trim().length < 3} onClick={() => act.reopen.mutate({ version: ticket.version, note: note.trim() })}>
          Yeniden aç
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Vazgeç
          </Button>
        )}
      </div>
    </Card>
  );
}

function CommentCard({ ticket }: { ticket: Ticket }) {
  const act = useMyTicketActions(ticket.ticketId);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const photos = await uploadPhotos(files, (f) => portalTicketsApi.uploadPhoto(f));
      await act.comment.mutateAsync({ body: body.trim(), ...(photos.length ? { photos } : {}) });
      setBody('');
      setFiles([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <h2 className="font-semibold">Mesaj ekle</h2>
      <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} aria-label="Mesaj" />
      <PhotoPicker files={files} onChange={setFiles} disabled={busy} />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button className="self-end" loading={busy} disabled={!body.trim()} onClick={() => void submit()}>
        Gönder
      </Button>
    </section>
  );
}

function WithdrawCard({ ticket }: { ticket: Ticket }) {
  const act = useMyTicketActions(ticket.ticketId);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <p className="text-small text-muted">Talep henüz işleme alınmadı; gerekmiyorsa geri çekebilirsiniz.</p>
      {act.cancel.isError && <Alert tone="danger">{errorMessage(act.cancel.error)}</Alert>}
      <Button
        variant="ghost"
        className="self-start text-danger"
        loading={act.cancel.isPending}
        onClick={() => {
          if (window.confirm('Talebi geri çekmek istediğinize emin misiniz?')) act.cancel.mutate({ version: ticket.version });
        }}
      >
        Talebi geri çek
      </Button>
    </div>
  );
}
