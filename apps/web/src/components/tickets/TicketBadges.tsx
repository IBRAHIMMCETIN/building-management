import { AlarmClock, Clock } from 'lucide-react';
import { Badge } from '@/components/ui';
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, type TaskStatus } from '@/lib/maintenance/schedule';
import { PRIORITY_LABELS, PRIORITY_TONES, STATUS_LABELS, STATUS_TONES, type TicketPriority, type TicketStatus, slaText } from '@/lib/tickets/model';

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge tone={PRIORITY_TONES[priority]}>{PRIORITY_LABELS[priority]}</Badge>;
}

/** SLA kalan / gecikme: yalnizca cozum bekleyen taleplerde. */
export function SlaBadge({ ticket, now }: { ticket: { status: TicketStatus; dueAt: string }; now?: Date }) {
  const sla = slaText(ticket, now);
  if (!sla) return null;
  const Icon = sla.overdue ? AlarmClock : Clock;
  return (
    <Badge tone={sla.overdue ? 'danger' : 'neutral'} title={`SLA hedefi: ${new Date(ticket.dueAt).toLocaleString('tr-TR')}`}>
      <Icon className="size-3" aria-hidden="true" />
      {sla.text}
    </Badge>
  );
}

export function TaskStatusBadge({ status, overdue }: { status: TaskStatus; overdue?: boolean }) {
  if (overdue) return <Badge tone="danger">Gecikti</Badge>;
  return <Badge tone={TASK_STATUS_TONES[status]}>{TASK_STATUS_LABELS[status]}</Badge>;
}
