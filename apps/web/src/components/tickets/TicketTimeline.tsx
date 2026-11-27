import { EyeOff, Star } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { SignedDownload } from '@/lib/api/documentModel';
import type { TicketEvent } from '@/lib/api/tickets';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { CATEGORY_LABELS, EVENT_LABELS, PRIORITY_LABELS, STATUS_LABELS, type TicketCategory, type TicketPriority } from '@/lib/tickets/model';
import { ROLE_LABELS, isRole } from '@/types/roles';
import { PhotoGallery } from './PhotoGallery';

const FIELD_LABELS: Record<string, string> = { title: 'Başlık', description: 'Açıklama', category: 'Kategori', priority: 'Öncelik', location: 'Konum', equipmentId: 'Ekipman' };

function fieldValue(field: string, v: unknown, equipmentName?: (id: string) => string | undefined): string {
  if (field === 'equipmentId') return typeof v === 'string' ? (equipmentName?.(v) ?? 'Ekipman') : '—';
  if (field === 'category' && typeof v === 'string') return CATEGORY_LABELS[v as TicketCategory] ?? v;
  if (field === 'priority' && typeof v === 'string') return PRIORITY_LABELS[v as TicketPriority] ?? v;
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  return '—';
}

type Props = {
  events: readonly TicketEvent[];
  loadPhoto: (photoId: string) => Promise<SignedDownload>;
  /** Kullanici kimligi -> ad (yonetim gorunumu). */
  nameOf?: (userId: string) => string | undefined;
  /** v2: ekipman kimligi -> ad (yonetim gorunumu; "Bilgiler düzeltildi" olayinda). */
  equipmentName?: (equipmentId: string) => string | undefined;
};

/**
 * Zaman cizelgesi (eskiden yeniye). Ic olaylar "Sakin görmez" etiketiyle ayri renkte; sakin
 * gorunumunde API yalnizca herkese acik olaylari dondurur.
 */
export function TicketTimeline({ events, loadPhoto, nameOf, equipmentName }: Props) {
  if (!events.length) return <p className="text-small text-muted">Henüz kayıt yok.</p>;
  return (
    <ol className="flex flex-col gap-3" aria-label="Zaman çizelgesi">
      {events.map((e) => {
        const internal = e.visibility === 'internal';
        const who = e.mine ? 'Siz' : e.by ? (nameOf?.(e.by) ?? (e.byRole && isRole(e.byRole) ? ROLE_LABELS[e.byRole] : undefined)) : e.byRole && isRole(e.byRole) ? ROLE_LABELS[e.byRole] : undefined;
        return (
          <li key={e.eventId} className={cn('rounded-lg border px-3 py-2 text-small', internal ? 'border-warning/30 bg-warning/5' : 'border-border bg-surface/40')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{titleOf(e)}</span>
              {internal && (
                <Badge tone="warning">
                  <EyeOff className="size-3" aria-hidden="true" />
                  Sakin görmez
                </Badge>
              )}
              <span className="ml-auto text-xs text-muted">
                {who ? `${who} · ` : ''}
                {formatDateTime(e.at)}
              </span>
            </div>
            {e.kind === 'field_changed' && e.changes && (
              <ul className="mt-1 text-xs text-muted">
                {Object.entries(e.changes).map(([f, [from, to]]) => (
                  <li key={f}>
                    {FIELD_LABELS[f] ?? f}: {fieldValue(f, from, equipmentName)} → {fieldValue(f, to, equipmentName)}
                  </li>
                ))}
              </ul>
            )}
            {e.rating !== undefined && (
              <p className="mt-1 flex items-center gap-1 text-xs" aria-label={`Puan ${e.rating}/5`}>
                {Array.from({ length: 5 }, (_, i) => (
                  <Star key={i} className={cn('size-3.5', i < (e.rating ?? 0) ? 'fill-warning text-warning' : 'text-muted')} aria-hidden="true" />
                ))}
              </p>
            )}
            {e.amount !== undefined && <p className="mt-1 text-xs tabular-nums">{formatTRY(e.amount)}</p>}
            {e.body && <p className="mt-1 whitespace-pre-wrap text-text-secondary">{e.body}</p>}
            {!!e.photoKeys?.length && (
              <div className="mt-2">
                <PhotoGallery keys={e.photoKeys} load={loadPhoto} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function titleOf(e: TicketEvent): string {
  if (e.kind === 'status_changed' && e.to) return `${e.from ? `${STATUS_LABELS[e.from]} → ` : ''}${STATUS_LABELS[e.to]}`;
  if (e.kind === 'assigned') return e.assigneeId === undefined ? 'Atama kaldırıldı' : 'Görevli atandı';
  return EVENT_LABELS[e.kind] ?? e.kind;
}
