import { Pencil, Send, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { PhotoPicker, uploadPhotos } from '@/components/tickets/PhotoPicker';
import { PriorityBadge, SlaBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { TicketTimeline } from '@/components/tickets/TicketTimeline';
import { Alert, Button, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useEquipmentPermissions } from '@/hooks/useEquipment';
import { useAssignTicket, useCommentTicket, useEstimateTicket, useTicket, useTicketPermissions, useTransitionTicket, useUpdateTicket } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import { type Ticket, ticketsApi } from '@/lib/api/tickets';
import { formatDateTime } from '@/lib/dates';
import {
  ACTION_LABELS,
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type TicketCategory,
  type TicketPriority,
  type TransitionAction,
  locationText,
  noteRequired,
} from '@/lib/tickets/model';
import { EstimateCard } from './EstimateCard';
import { WorkCostCard } from './WorkCostCard';
import { type TicketLabels, useTicketLabels } from './shared';

/** Talep ayrintisi (sagdan panel): bilgiler, atama, durum gecisleri, yorum / ic not, zaman cizelgesi, masraf. */
export function TicketDetailPanel({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const detail = useTicket(ticketId);
  const title = detail.data ? `${detail.data.ticket.number} · ${detail.data.ticket.title}` : 'Talep';
  return (
    <Dialog open={!!ticketId} onClose={onClose} title={title} variant="panel">
      {!ticketId ? null : detail.isPending ? (
        <Skeleton className="h-96" />
      ) : detail.isError ? (
        <Alert tone="danger">{errorMessage(detail.error)}</Alert>
      ) : (
        <TicketDetail key={detail.data.ticket.ticketId} ticket={detail.data.ticket} events={detail.data.events} />
      )}
    </Dialog>
  );
}

function TicketDetail({ ticket, events }: { ticket: Ticket; events: Parameters<typeof TicketTimeline>[0]['events'] }) {
  const p = useTicketPermissions();
  const { canRead: canReadEquipment } = useEquipmentPermissions();
  const labels = useTicketLabels();
  const estimate = useEstimateTicket(ticket.ticketId);
  const [action, setAction] = useState<TransitionAction | null>(null);
  const [editing, setEditing] = useState(false);
  const loadPhoto = (photoId: string) => ticketsApi.photo(ticket.ticketId, photoId);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        <SlaBadge ticket={ticket} />
        {ticket.source === 'maintenance' && <span className="text-xs text-muted">Bakım görevinden açıldı</span>}
        {ticket.canEdit && (
          <Button size="xs" variant="subtle" className="ml-auto" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden="true" />
            Düzelt
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
        <dt className="text-muted">Konum</dt>
        <dd>{locationText(ticket.location, labels.unitLabel)}</dd>
        <dt className="text-muted">Kategori</dt>
        <dd>{CATEGORY_LABELS[ticket.category]}</dd>
        {ticket.equipmentId && (
          <>
            <dt className="text-muted">Ekipman</dt>
            <dd>
              {canReadEquipment ? (
                <Link to={`/admin/equipment?equipment=${encodeURIComponent(ticket.equipmentId)}`} className="text-accent underline-offset-2 hover:underline">
                  {labels.equipmentName(ticket.equipmentId) ?? 'Ekipman kaydı'}
                </Link>
              ) : (
                (labels.equipmentName(ticket.equipmentId) ?? 'Ekipman kaydı')
              )}
            </dd>
          </>
        )}
        <dt className="text-muted">Açılış</dt>
        <dd>{formatDateTime(ticket.createdAt)}</dd>
        <dt className="text-muted">SLA hedefi</dt>
        <dd>
          {formatDateTime(ticket.dueAt)}
          {ticket.slaMet !== undefined && <span className="ml-2 text-xs text-muted">({ticket.slaMet ? 'süresinde çözüldü' : 'gecikmeli çözüldü'})</span>}
        </dd>
        {ticket.rating && (
          <>
            <dt className="text-muted">Sakin puanı</dt>
            <dd>{ticket.rating.score}/5</dd>
          </>
        )}
      </dl>

      <p className="whitespace-pre-wrap rounded-lg bg-surface-muted/40 p-3 text-small">{ticket.description}</p>

      <AssignRow ticket={ticket} labels={labels} />

      {ticket.actions.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Durum işlemleri">
          {ticket.actions.map((a) => (
            <Button key={a} size="sm" variant={a === 'resolve' || a === 'start' ? 'primary' : a === 'cancel' ? 'danger' : 'secondary'} onClick={() => setAction(a as TransitionAction)}>
              {ACTION_LABELS[a as TransitionAction] ?? a}
            </Button>
          ))}
        </div>
      )}

      <EstimateCard key={`estimate-${ticket.version}`} estimate={ticket.estimate} canEdit={ticket.canEstimate} version={ticket.version} mutation={estimate} nameOf={labels.nameOf} />

      {p.canReadCosts && <WorkCostCard target={{ kind: 'ticket', id: ticket.ticketId }} ticketStatus={ticket.status} />}

      <section className="flex flex-col gap-3">
        <h3 className="text-small font-semibold">Zaman çizelgesi</h3>
        <TicketTimeline events={events} loadPhoto={loadPhoto} nameOf={labels.nameOf} equipmentName={labels.equipmentName} />
      </section>

      {p.canCreate && ticket.status !== 'cancelled' && <CommentBox ticket={ticket} canInternal={p.canInternal} />}

      <TransitionDialog ticket={ticket} action={action} isManager={p.canManage} onClose={() => setAction(null)} />
      {editing && <EditDialog ticket={ticket} onClose={() => setEditing(false)} />}
    </div>
  );
}

function AssignRow({ ticket, labels }: { ticket: Ticket; labels: TicketLabels }) {
  const p = useTicketPermissions();
  const assign = useAssignTicket(ticket.ticketId);
  const current = ticket.assigneeId ? (labels.nameOf(ticket.assigneeId) ?? 'Görevli') : 'Atanmamış';
  if (!ticket.canAssign) {
    return (
      <p className="text-small">
        <span className="text-muted">Görevli: </span>
        {current}
      </p>
    );
  }
  if (!p.canManage) {
    // Gorevli: havuzdaki talebi kendine ustlenir.
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" variant="secondary" loading={assign.isPending} onClick={() => assign.mutate({ version: ticket.version, assigneeId: p.userId })}>
          <UserCheck className="size-4" aria-hidden="true" />
          Üstlen
        </Button>
        {assign.isError && <Alert tone="danger">{errorMessage(assign.error)}</Alert>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-3 text-small">
        <span className="text-muted">Görevli</span>
        <Select
          className="max-w-64"
          value={ticket.assigneeId ?? ''}
          disabled={assign.isPending}
          aria-label="Görevli ata"
          onChange={(e) => assign.mutate({ version: ticket.version, assigneeId: e.target.value || null })}
        >
          <option value="">Atanmamış</option>
          {labels.assignees.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.name}
            </option>
          ))}
        </Select>
      </label>
      {labels.assignees.length === 0 && <p className="text-xs text-muted">Aktif bina görevlisi yok; Ekip sayfasından davet edebilirsiniz.</p>}
      {assign.isError && <Alert tone="danger">{errorMessage(assign.error)}</Alert>}
    </div>
  );
}

function TransitionDialog({ ticket, action, isManager, onClose }: { ticket: Ticket; action: TransitionAction | null; isManager: boolean; onClose: () => void }) {
  const transition = useTransitionTicket(ticket.ticketId);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNote('');
    setFiles([]);
    setError(null);
  }, [action]);
  if (!action) return null;
  const required = noteRequired(action, isManager);
  const withPhotos = action === 'resolve' || action === 'hold' || action === 'start';

  const submit = async () => {
    if (required && note.trim().length < 3) {
      setError('Bu işlem için açıklama gerekli (en az 3 karakter).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photos = await uploadPhotos(files, (f) => ticketsApi.uploadPhoto(f));
      await transition.mutateAsync({ version: ticket.version, action, ...(note.trim() ? { note: note.trim() } : {}), ...(photos.length ? { photos } : {}) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`${ticket.number}: ${ACTION_LABELS[action]}`}>
      <div className="flex flex-col gap-4">
        <FormField label={required ? 'Açıklama' : 'Açıklama (isteğe bağlı)'} hint={action === 'resolve' ? 'Sakine "çözüldü, onaylayın" bildirimiyle iletilir.' : undefined}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FormField>
        {withPhotos && <PhotoPicker label="Önce / sonra fotoğrafları (isteğe bağlı)" files={files} onChange={setFiles} disabled={busy} />}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant={action === 'cancel' ? 'danger' : 'primary'} loading={busy} onClick={() => void submit()}>
            {ACTION_LABELS[action]}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CommentBox({ ticket, canInternal }: { ticket: Ticket; canInternal: boolean }) {
  const comment = useCommentTicket(ticket.ticketId);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>(canInternal ? 'internal' : 'public');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const photos = await uploadPhotos(files, (f) => ticketsApi.uploadPhoto(f));
      await comment.mutateAsync({ body: body.trim(), visibility, ...(photos.length ? { photos } : {}) });
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
      <h3 className="text-small font-semibold">{visibility === 'internal' ? 'İç not ekle' : 'Yorum yaz'}</h3>
      {canInternal && (
        <div role="radiogroup" aria-label="Görünürlük" className="flex gap-4 text-small">
          <label className="flex items-center gap-2">
            <input type="radio" name={`vis-${ticket.ticketId}`} checked={visibility === 'internal'} onChange={() => setVisibility('internal')} className="accent-accent" />
            İç not (sakin görmez)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`vis-${ticket.ticketId}`} checked={visibility === 'public'} onChange={() => setVisibility('public')} className="accent-accent" />
            Sakine yorum
          </label>
        </div>
      )}
      <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} aria-label="Yorum metni" />
      {canInternal && <PhotoPicker files={files} onChange={setFiles} disabled={busy} />}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end">
        <Button size="sm" loading={busy} disabled={!body.trim()} onClick={() => void submit()}>
          <Send className="size-4" aria-hidden="true" />
          Gönder
        </Button>
      </div>
    </section>
  );
}

function EditDialog({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const update = useUpdateTicket(ticket.ticketId);
  const labels = useTicketLabels();
  const [title, setTitle] = useState(ticket.title);
  const [category, setCategory] = useState<TicketCategory>(ticket.category);
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);
  const [equipmentId, setEquipmentId] = useState(ticket.equipmentId ?? '');
  const submit = () =>
    update.mutate(
      {
        version: ticket.version,
        ...(title.trim() !== ticket.title ? { title: title.trim() } : {}),
        ...(category !== ticket.category ? { category } : {}),
        ...(priority !== ticket.priority ? { priority } : {}),
        ...(equipmentId !== (ticket.equipmentId ?? '') ? { equipmentId: equipmentId || null } : {}),
      },
      { onSuccess: onClose },
    );
  // Bagli ekipman hizmetten cikmis olabilir (secim listesinde yok): mevcut baglanti yine gosterilir.
  const linkedMissing = !!ticket.equipmentId && !labels.equipment.some((e) => e.equipmentId === ticket.equipmentId);
  return (
    <Dialog open onClose={onClose} title={`${ticket.number}: bilgileri düzelt`}>
      <div className="flex flex-col gap-4">
        <FormField label="Başlık">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </FormField>
        <FormField label="Kategori">
          <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Öncelik" hint="Öncelik değişirse SLA hedefi yeniden hesaplanır.">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
            {TICKET_PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {PRIORITY_LABELS[x]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Ekipman (isteğe bağlı)" hint="Arıza ekipmanın geçmişinde ve masraf toplamında görünür.">
          <Select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
            <option value="">Bağlı değil</option>
            {linkedMissing && <option value={ticket.equipmentId}>{labels.equipmentName(ticket.equipmentId ?? '') ?? 'Mevcut ekipman'}</option>}
            {labels.equipment.map((e) => (
              <option key={e.equipmentId} value={e.equipmentId}>
                {e.name}
              </option>
            ))}
          </Select>
        </FormField>
        {update.isError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button loading={update.isPending} disabled={title.trim().length < 3} onClick={submit}>
            Kaydet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
