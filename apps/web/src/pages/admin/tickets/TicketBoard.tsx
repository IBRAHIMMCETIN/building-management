import { useMemo, useState } from 'react';
import { Alert, Card, FilterChips, Select, Skeleton } from '@/components/ui';
import { useTicketBoard } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import type { Ticket } from '@/lib/api/tickets';
import { cn } from '@/lib/cn';
import { BOARD_COLUMNS, CATEGORY_LABELS, PRIORITY_LABELS, STATUS_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketStatus } from '@/lib/tickets/model';
import { TicketCard, useTicketLabels } from './shared';

type Filters = { category: string; priority: string; assignee: string; overdue: boolean };

export function filterBoardItems(items: readonly Ticket[], f: Filters): Ticket[] {
  return items.filter(
    (t) =>
      (!f.category || t.category === f.category) &&
      (!f.priority || t.priority === f.priority) &&
      (!f.assignee || (f.assignee === 'none' ? !t.assigneeId : t.assigneeId === f.assignee)) &&
      (!f.overdue || t.overdue),
  );
}

/**
 * Durum sutunlu pano. Durum degisikligi not gerektirebildiginden surukle-birak yok; kart detayi
 * acar. Mobilde tek sutun ve sutun secici.
 */
export function TicketBoard({ onOpen }: { onOpen: (id: string) => void }) {
  const board = useTicketBoard();
  const labels = useTicketLabels();
  const [f, setF] = useState<Filters>({ category: '', priority: '', assignee: '', overdue: false });
  const [mobileCol, setMobileCol] = useState<TicketStatus>('open');

  const columns = useMemo(() => (board.data?.columns ?? []).map((c) => ({ ...c, items: filterBoardItems(c.items, f) })), [board.data, f]);

  if (board.isPending) return <Skeleton className="h-64" />;
  if (board.isError) return <Alert tone="danger">{errorMessage(board.error)}</Alert>;
  const b = board.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="SLA aşan" value={b.overdueCount} warn={b.overdueCount > 0} />
        <Stat label="Açık acil talep" value={b.urgentOpenCount} warn={b.urgentOpenCount > 0} />
        <Stat label="Son 30 günde kapanan" value={b.closedLast30Days} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Kategori" value={f.category} onChange={(category) => setF({ ...f, category })} options={TICKET_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
        <FilterSelect label="Öncelik" value={f.priority} onChange={(priority) => setF({ ...f, priority })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
        <FilterSelect
          label="Görevli"
          value={f.assignee}
          onChange={(assignee) => setF({ ...f, assignee })}
          options={[{ value: 'none', label: 'Atanmamış' }, ...labels.assignees.map((a) => ({ value: a.userId, label: a.name }))]}
        />
        <label className="flex h-10 items-center gap-2 text-small">
          <input type="checkbox" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })} className="size-4 accent-accent" />
          Yalnızca gecikenler
        </label>
      </div>

      <div className="md:hidden">
        <FilterChips
          label="Sütun"
          value={mobileCol}
          onChange={setMobileCol}
          options={BOARD_COLUMNS.map((s) => ({ value: s, label: STATUS_LABELS[s], count: columns.find((c) => c.status === s)?.items.length ?? 0 }))}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        {columns.map((c) => (
          <section key={c.status} aria-label={`${STATUS_LABELS[c.status]} (${c.items.length})`} className={cn('flex-col gap-2 rounded-xl bg-surface-muted/30 p-2', c.status === mobileCol ? 'flex' : 'hidden md:flex')}>
            <h3 className="flex items-center justify-between px-1 text-small font-semibold">
              {STATUS_LABELS[c.status]}
              <span className="rounded-full bg-surface-muted px-2 text-xs tabular-nums text-muted">{c.items.length}</span>
            </h3>
            {c.items.length === 0 ? <p className="px-1 py-4 text-center text-xs text-muted">Kayıt yok</p> : c.items.map((t) => <TicketCard key={t.ticketId} ticket={t} labels={labels} onOpen={onOpen} />)}
          </section>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <Card className="flex flex-col gap-1 p-4 md:p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('text-xl font-semibold tabular-nums', warn && 'text-danger')}>{value}</p>
    </Card>
  );
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex min-w-36 flex-col gap-1 text-xs text-muted">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">Tümü</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
