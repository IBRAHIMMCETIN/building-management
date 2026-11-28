import { type ChecklistAnswer, checklistErrors } from '@bm/shared/api/work';
import { AlertTriangle, CheckCircle2, Play, UserCheck, Wrench, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PhotoGallery } from '@/components/tickets/PhotoGallery';
import { PhotoPicker, uploadPhotos } from '@/components/tickets/PhotoPicker';
import { TaskStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Button, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useEquipmentNames } from '@/hooks/useEquipment';
import { useMaintenanceTask, useTaskActions } from '@/hooks/useMaintenance';
import { useTicketPermissions } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import { type MaintenanceTask, maintenanceApi } from '@/lib/api/maintenance';
import { formatDate, formatDateTime } from '@/lib/dates';
import { CATEGORY_LABELS, PRIORITY_LABELS, TICKET_PRIORITIES, type TicketPriority } from '@/lib/tickets/model';
import { EstimateCard } from './EstimateCard';
import { WorkCostCard } from './WorkCostCard';
import { useTicketLabels } from './shared';

type Result = ChecklistAnswer;

/** Tamamlama formu dogrulamasi (API kurali: zorunlu maddeler cevaplanir; basarisiz maddede not). Web + mobil ortak. */
export { checklistErrors };

/** Bakim gorevi: kontrol listesiyle tamamlama, fotograf, atama / ustlenme, atlama, gorevden ariza, masraf. */
export function MaintenanceTaskDialog({ taskId, onClose, onOpenTicket }: { taskId: string | null; onClose: () => void; onOpenTicket?: (ticketId: string) => void }) {
  const task = useMaintenanceTask(taskId);
  return (
    <Dialog open={!!taskId} onClose={onClose} title={task.data ? `${task.data.name} · ${formatDate(task.data.dueDate)}` : 'Bakım görevi'} variant="panel">
      {!taskId ? null : task.isPending ? (
        <Skeleton className="h-96" />
      ) : task.isError ? (
        <Alert tone="danger">{errorMessage(task.error)}</Alert>
      ) : (
        <TaskBody key={`${task.data.taskId}-${task.data.version}`} task={task.data} onOpenTicket={onOpenTicket} />
      )}
    </Dialog>
  );
}

export function TaskBody({ task, onOpenTicket }: { task: MaintenanceTask; onOpenTicket?: (ticketId: string) => void }) {
  const p = useTicketPermissions();
  const labels = useTicketLabels();
  const act = useTaskActions(task.taskId);
  const equipmentName = useEquipmentNames([task.equipmentId]);
  const [mode, setMode] = useState<'complete' | 'skip' | 'ticket' | null>(null);
  const [suggest, setSuggest] = useState(false);
  const has = (a: string) => task.actions.includes(a);
  const err = act.assign.error ?? act.start.error;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <TaskStatusBadge status={task.status} overdue={task.overdue} />
        <span className="text-xs text-muted">{CATEGORY_LABELS[task.category]}</span>
        {task.asset && <span className="text-xs text-muted">· {task.asset}</span>}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
        <dt className="text-muted">Vade</dt>
        <dd>{formatDate(task.dueDate)}</dd>
        {task.equipmentId && (
          <>
            <dt className="text-muted">Ekipman</dt>
            <dd>
              <Link to={`/admin/equipment?equipment=${encodeURIComponent(task.equipmentId)}`} className="text-accent underline-offset-2 hover:underline">
                {equipmentName(task.equipmentId) ?? 'Ekipman kaydı'}
              </Link>
            </dd>
          </>
        )}
        <dt className="text-muted">Görevli</dt>
        <dd>{task.assigneeId ? (labels.nameOf(task.assigneeId) ?? (task.assigneeId === p.userId ? 'Siz' : 'Görevli')) : 'Atanmamış'}</dd>
        {task.completedAt && (
          <>
            <dt className="text-muted">Tamamlandı</dt>
            <dd>{formatDateTime(task.completedAt)}</dd>
          </>
        )}
        {task.skipReason && (
          <>
            <dt className="text-muted">Atlama gerekçesi</dt>
            <dd>{task.skipReason}</dd>
          </>
        )}
        {task.cancelReason && (
          <>
            <dt className="text-muted">İptal</dt>
            <dd>{task.cancelReason}</dd>
          </>
        )}
      </dl>

      {suggest && (
        <Alert>
          Başarısız madde var. Sorunu takip etmek için{' '}
          <button type="button" className="font-medium underline" onClick={() => setMode('ticket')}>
            arıza talebi açın
          </button>
          .
        </Alert>
      )}

      {mode === 'complete' ? (
        <CompleteForm task={task} onDone={(s) => { setMode(null); setSuggest(s); }} onCancel={() => setMode(null)} />
      ) : mode === 'skip' ? (
        <SkipForm task={task} onDone={() => setMode(null)} />
      ) : mode === 'ticket' ? (
        <OpenTicketForm task={task} onDone={(id) => { setMode(null); setSuggest(false); onOpenTicket?.(id); }} onCancel={() => setMode(null)} />
      ) : (
        <>
          <Checklist task={task} />
          <div className="flex flex-wrap gap-2">
            {has('assign') && !p.canManage && (
              <Button size="sm" variant="secondary" loading={act.assign.isPending} onClick={() => act.assign.mutate({ version: task.version, assigneeId: p.userId })}>
                <UserCheck className="size-4" aria-hidden="true" />
                Üstlen
              </Button>
            )}
            {has('start') && (
              <Button size="sm" variant="secondary" loading={act.start.isPending} onClick={() => act.start.mutate(task.version)}>
                <Play className="size-4" aria-hidden="true" />
                Başla
              </Button>
            )}
            {has('complete') && (
              <Button size="sm" onClick={() => setMode('complete')}>
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Tamamla
              </Button>
            )}
            {has('ticket') && (
              <Button size="sm" variant="secondary" onClick={() => setMode('ticket')}>
                <Wrench className="size-4" aria-hidden="true" />
                Arıza aç
              </Button>
            )}
            {has('skip') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('skip')}>
                Atla
              </Button>
            )}
          </div>
          {has('assign') && p.canManage && (
            <label className="flex items-center gap-3 text-small">
              <span className="text-muted">Görevli</span>
              <Select className="max-w-64" value={task.assigneeId ?? ''} disabled={act.assign.isPending} aria-label="Görevli ata" onChange={(e) => act.assign.mutate({ version: task.version, assigneeId: e.target.value || null })}>
                <option value="">Atanmamış</option>
                {labels.assignees.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {err && <Alert tone="danger">{errorMessage(err)}</Alert>}
        </>
      )}

      {!!task.photoKeys?.length && (
        <section className="flex flex-col gap-2">
          <h3 className="text-small font-semibold">Fotoğraflar</h3>
          <PhotoGallery keys={task.photoKeys} load={(photoId) => maintenanceApi.photo(task.taskId, photoId)} />
        </section>
      )}
      {task.ticketIds.length > 0 && (
        <p className="text-small">
          <span className="text-muted">Açılan arızalar: </span>
          {task.ticketIds.map((id, i) => (
            <button key={id} type="button" className="mr-2 font-medium text-accent underline-offset-2 hover:underline" onClick={() => onOpenTicket?.(id)}>
              Talep {i + 1}
            </button>
          ))}
        </p>
      )}
      <EstimateCard estimate={task.estimate} canEdit={has('estimate')} version={task.version} mutation={act.estimate} nameOf={labels.nameOf} />
      {p.canReadCosts && <WorkCostCard target={{ kind: 'maintenance', id: task.taskId }} />}
    </div>
  );
}

function Checklist({ task }: { task: MaintenanceTask }) {
  if (!task.checklist.length) return null;
  const result = (id: string) => task.checklistResults?.find((r) => r.id === id);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-small font-semibold">Kontrol listesi</h3>
      <ul className="flex flex-col gap-1.5 text-small">
        {task.checklist.map((c) => {
          const r = result(c.id);
          return (
            <li key={c.id} className="flex items-start gap-2">
              {r ? r.ok ? <CheckCircle2 className="mt-0.5 size-4 text-success" aria-label="Uygun" /> : <XCircle className="mt-0.5 size-4 text-danger" aria-label="Sorunlu" /> : <span className="mt-1.5 size-2 rounded-full bg-border-strong" aria-hidden="true" />}
              <span>
                {c.text}
                {!c.required && <span className="text-xs text-muted"> (isteğe bağlı)</span>}
                {r?.note && <span className="block text-xs text-muted">{r.note}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CompleteForm({ task, onDone, onCancel }: { task: MaintenanceTask; onDone: (suggestTicket: boolean) => void; onCancel: () => void }) {
  const act = useTaskActions(task.taskId);
  const [results, setResults] = useState<Result[]>(task.checklist.map((c) => ({ id: c.id, ok: null, note: '' })));
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, patch: Partial<Result>) => setResults(results.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const submit = async () => {
    const invalid = checklistErrors(task, results);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photos = await uploadPhotos(files, (f) => maintenanceApi.uploadPhoto(f));
      const r = await act.complete.mutateAsync({
        version: task.version,
        checklistResults: results.filter((x) => x.ok !== null).map((x) => ({ id: x.id, ok: x.ok as boolean, ...(x.note.trim() ? { note: x.note.trim() } : {}) })),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(photos.length ? { photos } : {}),
      });
      onDone(r.suggestTicket);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Görevi tamamla">
      <ul className="flex flex-col gap-3">
        {task.checklist.map((c) => {
          const r = results.find((x) => x.id === c.id) as Result;
          return (
            <li key={c.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <span className="text-small font-medium">
                {c.text}
                {!c.required && <span className="text-xs font-normal text-muted"> (isteğe bağlı)</span>}
              </span>
              <div role="radiogroup" aria-label={c.text} className="grid grid-cols-2 gap-2">
                <button type="button" role="radio" aria-checked={r.ok === true} onClick={() => set(c.id, { ok: true })} className={`h-11 rounded-md border text-small font-medium ${r.ok === true ? 'border-success bg-success/10 text-success' : 'border-border-strong'}`}>
                  Uygun
                </button>
                <button type="button" role="radio" aria-checked={r.ok === false} onClick={() => set(c.id, { ok: false })} className={`h-11 rounded-md border text-small font-medium ${r.ok === false ? 'border-danger bg-danger/10 text-danger' : 'border-border-strong'}`}>
                  Sorunlu
                </button>
              </div>
              {r.ok === false && <Input value={r.note} onChange={(e) => set(c.id, { note: e.target.value })} placeholder="Sorunu kısaca yazın" aria-label={`${c.text} açıklaması`} maxLength={500} />}
            </li>
          );
        })}
      </ul>
      <FormField label="Not (isteğe bağlı)">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </FormField>
      <PhotoPicker label="Önce / sonra fotoğrafları (isteğe bağlı)" files={files} onChange={setFiles} disabled={busy} />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Vazgeç
        </Button>
        <Button loading={busy} onClick={() => void submit()}>
          Tamamla
        </Button>
      </div>
    </section>
  );
}

function SkipForm({ task, onDone }: { task: MaintenanceTask; onDone: () => void }) {
  const act = useTaskActions(task.taskId);
  const [reason, setReason] = useState('');
  return (
    <section className="flex flex-col gap-3" aria-label="Görevi atla">
      <FormField label="Atlama gerekçesi" hint="Örn. firma gelemedi, bir sonraki bakımda yapılacak.">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </FormField>
      {act.skip.isError && <Alert tone="danger">{errorMessage(act.skip.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Vazgeç
        </Button>
        <Button variant="danger" loading={act.skip.isPending} disabled={reason.trim().length < 3} onClick={() => act.skip.mutate({ version: task.version, reason: reason.trim() }, { onSuccess: onDone })}>
          Atla
        </Button>
      </div>
    </section>
  );
}

function OpenTicketForm({ task, onDone, onCancel }: { task: MaintenanceTask; onDone: (ticketId: string) => void; onCancel: () => void }) {
  const act = useTaskActions(task.taskId);
  const [key] = useIdempotencyKey();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const failed = (task.checklistResults ?? []).filter((r) => !r.ok).length;
  return (
    <section className="flex flex-col gap-3" aria-label="Görevden arıza aç">
      <p className="flex items-center gap-2 text-small text-muted">
        <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
        {failed ? `${failed} sorunlu madde açıklamaya eklenecek.` : 'Talep bakım görevine bağlanır.'}
      </p>
      <FormField label="Başlık (isteğe bağlı)" hint={`Boş bırakılırsa: "${task.name} - bulgu"`}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </FormField>
      <FormField label="Öncelik">
        <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
          {TICKET_PRIORITIES.map((x) => (
            <option key={x} value={x}>
              {PRIORITY_LABELS[x]}
            </option>
          ))}
        </Select>
      </FormField>
      {act.openTicket.isError && <Alert tone="danger">{errorMessage(act.openTicket.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Vazgeç
        </Button>
        <Button
          loading={act.openTicket.isPending}
          onClick={() => act.openTicket.mutate({ idempotencyKey: key, priority, ...(title.trim().length >= 3 ? { title: title.trim() } : {}) }, { onSuccess: (r) => onDone(r.ticket.ticketId) })}
        >
          Arıza talebi aç
        </Button>
      </div>
    </section>
  );
}
