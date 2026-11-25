import { Download, Search } from 'lucide-react';
import { useState } from 'react';
import { PriorityBadge, SlaBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Button, Input, Skeleton } from '@/components/ui';
import { useTicketList } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import type { Ticket, TicketListQuery } from '@/lib/api/tickets';
import { formatDate } from '@/lib/dates';
import { CATEGORY_LABELS, PRIORITY_LABELS, STATUS_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, locationText } from '@/lib/tickets/model';
import { FilterSelect } from './TicketBoard';
import { type TicketLabels, useTicketLabels } from './shared';

const PAGE = 50;

/** CSV (Excel uyumlu: noktali virgul, UTF-8 BOM). */
export function ticketsCsv(items: readonly Ticket[], labels: Pick<TicketLabels, 'unitLabel' | 'nameOf'>): string {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const rows = [
    ['Numara', 'Başlık', 'Kategori', 'Öncelik', 'Durum', 'Konum', 'Görevli', 'Açılış', 'SLA hedefi', 'Gecikti'],
    ...items.map((t) => [
      t.number,
      t.title,
      CATEGORY_LABELS[t.category],
      PRIORITY_LABELS[t.priority],
      STATUS_LABELS[t.status],
      locationText(t.location, labels.unitLabel),
      t.assigneeId ? (labels.nameOf(t.assigneeId) ?? t.assigneeId) : '',
      formatDate(t.createdAt),
      formatDate(t.dueAt),
      t.overdue ? 'Evet' : 'Hayır',
    ]),
  ];
  return `﻿${rows.map((r) => r.map(esc).join(';')).join('\r\n')}`;
}

export function TicketList({ onOpen }: { onOpen: (id: string) => void }) {
  const labels = useTicketLabels();
  const [q, setQ] = useState<TicketListQuery>({ limit: PAGE });
  const [term, setTerm] = useState('');
  const list = useTicketList(q);
  const set = (patch: Partial<TicketListQuery>) => setQ({ ...q, ...patch, cursor: undefined });

  const exportCsv = () => {
    const blob = new Blob([ticketsCsv(list.data?.items ?? [], labels)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'talepler.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: term.trim() || undefined });
          }}
        >
          <label htmlFor="ticket-search">Ara (numara veya başlık)</label>
          <div className="relative">
            <Input id="ticket-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="T-000123, asansör…" className="pl-9" />
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          </div>
        </form>
        <FilterSelect label="Durum" value={q.status ?? ''} onChange={(v) => set({ status: v || undefined })} options={[{ value: 'active', label: 'Çözüm bekleyen' }, ...TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))]} />
        <FilterSelect label="Kategori" value={q.category ?? ''} onChange={(v) => set({ category: v || undefined })} options={TICKET_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
        <FilterSelect label="Öncelik" value={q.priority ?? ''} onChange={(v) => set({ priority: v || undefined })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
        <FilterSelect
          label="Görevli"
          value={q.assignee ?? ''}
          onChange={(v) => set({ assignee: v || undefined })}
          options={[{ value: 'none', label: 'Atanmamış' }, ...labels.assignees.map((a) => ({ value: a.userId, label: a.name }))]}
        />
        <label className="flex h-10 items-center gap-2 text-small">
          <input type="checkbox" checked={q.overdue === 'true'} onChange={(e) => set({ overdue: e.target.checked ? 'true' : undefined })} className="size-4 accent-accent" />
          Gecikenler
        </label>
        <Button variant="secondary" onClick={exportCsv} disabled={!list.data?.items.length}>
          <Download className="size-4" aria-hidden="true" />
          CSV
        </Button>
      </div>

      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : list.data.items.length === 0 ? (
        <p className="py-8 text-center text-small text-muted">Bu filtrelere uyan talep yok.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-small">
            <caption className="sr-only">Talepler ({list.data.total})</caption>
            <thead className="bg-surface-muted/40 text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Numara</th>
                <th scope="col" className="px-3 py-2 font-medium">Başlık</th>
                <th scope="col" className="px-3 py-2 font-medium">Konum</th>
                <th scope="col" className="px-3 py-2 font-medium">Durum</th>
                <th scope="col" className="px-3 py-2 font-medium">Öncelik</th>
                <th scope="col" className="px-3 py-2 font-medium">SLA</th>
                <th scope="col" className="px-3 py-2 font-medium">Açılış</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.data.items.map((t) => (
                <tr key={t.ticketId} className="cursor-pointer hover:bg-surface-muted/40" onClick={() => onOpen(t.ticketId)}>
                  <td className="px-3 py-2 font-mono text-xs">
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpen(t.ticketId)}>
                      {t.number}
                    </button>
                  </td>
                  <td className="max-w-72 truncate px-3 py-2">{t.title}</td>
                  <td className="px-3 py-2 text-muted">{locationText(t.location, labels.unitLabel)}</td>
                  <td className="px-3 py-2">
                    <TicketStatusBadge status={t.status} />
                  </td>
                  <td className="px-3 py-2">
                    <PriorityBadge priority={t.priority} />
                  </td>
                  <td className="px-3 py-2">
                    <SlaBadge ticket={t} />
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">{formatDate(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Toplam {list.data.total} talep</span>
          <span className="flex gap-2">
            {q.cursor && (
              <Button size="sm" variant="secondary" onClick={() => setQ({ ...q, cursor: String(Math.max(Number(q.cursor) - PAGE, 0)) || undefined })}>
                Önceki
              </Button>
            )}
            {list.data.nextCursor && (
              <Button size="sm" variant="secondary" onClick={() => setQ({ ...q, cursor: list.data.nextCursor })}>
                Sonraki
              </Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
