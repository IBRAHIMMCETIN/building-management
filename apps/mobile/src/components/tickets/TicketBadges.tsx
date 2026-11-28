import { STATUS_LABELS, STATUS_TONES, type TicketStatus } from '@bm/shared/tickets/model';
import { Badge } from '@/components/ui';

/** Talep durumu rozeti (web: components/tickets/TicketBadges.tsx). */
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONES[status]} label={STATUS_LABELS[status]} />;
}
