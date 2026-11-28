import { TASK_STATUS_LABELS, TASK_STATUS_TONES, type TaskStatus } from '@bm/shared/api/work';
import { PRIORITY_LABELS, PRIORITY_TONES, STATUS_LABELS, STATUS_TONES, type TicketPriority, type TicketStatus, slaText } from '@bm/shared/tickets/model';
import { AlarmClock, Clock } from '@/components/icons';
import { Badge } from '@/components/ui';

/** Talep durumu rozeti (web: components/tickets/TicketBadges.tsx). */
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONES[status]} label={STATUS_LABELS[status]} />;
}

/** Oncelik rozeti (gorevli / yonetim gorunumu; sakin onceligi secmez). */
export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge tone={PRIORITY_TONES[priority]} label={PRIORITY_LABELS[priority]} />;
}

/** SLA kalan / gecikme: yalnizca cozum bekleyen taleplerde. */
export function SlaBadge({ ticket }: { ticket: { status: TicketStatus; dueAt: string } }) {
  const sla = slaText(ticket);
  if (!sla) return null;
  return <Badge tone={sla.overdue ? 'danger' : 'neutral'} icon={sla.overdue ? AlarmClock : Clock} label={sla.text} />;
}

/** Periyodik bakim gorevi durumu (gecikmisse "Gecikti"). */
export function TaskStatusBadge({ status, overdue }: { status: TaskStatus; overdue?: boolean }) {
  if (overdue) return <Badge tone="danger" label="Gecikti" />;
  return <Badge tone={TASK_STATUS_TONES[status]} label={TASK_STATUS_LABELS[status]} />;
}
