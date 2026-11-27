import { UserRound } from 'lucide-react';
import { useMemo } from 'react';
import { PriorityBadge, SlaBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { useEquipmentOptions } from '@/hooks/useEquipment';
import { useAssignees } from '@/hooks/useTickets';
import { useUnits } from '@/hooks/useUnits';
import type { Ticket } from '@/lib/api/tickets';
import { cn } from '@/lib/cn';
import { CATEGORY_LABELS, locationText } from '@/lib/tickets/model';

/** Daire numarasi, gorevli adi ve (v2) ekipman adi cozumleyicileri (yonetim gorunumu). */
export function useTicketLabels() {
  const units = useUnits();
  const assignees = useAssignees();
  const equipment = useEquipmentOptions();
  return useMemo(() => {
    const unitMap = new Map((units.data?.items ?? []).map((u) => [u.unitId, u.number]));
    const people = new Map((assignees.data ?? []).map((a) => [a.userId, a.name]));
    const equipmentMap = new Map((equipment.data ?? []).map((e) => [e.equipmentId, e.name]));
    return {
      unitLabel: (id: string) => unitMap.get(id),
      nameOf: (id: string) => people.get(id),
      equipmentName: (id: string) => equipmentMap.get(id),
      units: units.data?.items ?? [],
      assignees: assignees.data ?? [],
      /** Secim listeleri: hizmetteki ekipman (calisiyor + devre disi). */
      equipment: equipment.data ?? [],
    };
  }, [units.data, assignees.data, equipment.data]);
}

export type TicketLabels = ReturnType<typeof useTicketLabels>;

export function TicketCard({ ticket, labels, onOpen, showStatus }: { ticket: Ticket; labels: TicketLabels; onOpen: (id: string) => void; showStatus?: boolean }) {
  const assignee = ticket.assigneeId ? (labels.nameOf(ticket.assigneeId) ?? 'Görevli') : undefined;
  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.ticketId)}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-lg border bg-surface/70 p-3 text-left text-small shadow-xs transition-colors hover:border-border-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        ticket.overdue ? 'border-danger/40' : 'border-border',
      )}
    >
      <span className="flex items-center gap-2 text-xs text-muted">
        <span className="font-mono">{ticket.number}</span>
        <span>·</span>
        <span>{CATEGORY_LABELS[ticket.category]}</span>
      </span>
      <span className="line-clamp-2 font-medium text-text">{ticket.title}</span>
      <span className="text-xs text-muted">{locationText(ticket.location, labels.unitLabel)}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        {showStatus && <TicketStatusBadge status={ticket.status} />}
        {ticket.priority !== 'normal' && <PriorityBadge priority={ticket.priority} />}
        <SlaBadge ticket={ticket} />
        {assignee && (
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <UserRound className="size-3" aria-hidden="true" />
            {assignee}
          </span>
        )}
      </span>
    </button>
  );
}
