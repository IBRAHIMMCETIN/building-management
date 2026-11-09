import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import { Badge } from '@/components/ui';
import { type PortalStatus, STATUS_LABELS } from '@/lib/api/portal';

const STYLE = {
  no_debt: { tone: 'success', icon: CircleCheck },
  paid: { tone: 'success', icon: CircleCheck },
  pending: { tone: 'accent', icon: Clock },
  overdue: { tone: 'warning', icon: CircleAlert },
} as const;

export function PortalStatusBadge({ status }: { status: PortalStatus }) {
  const { tone, icon: Icon } = STYLE[status];
  return (
    <Badge tone={tone}>
      <Icon className="size-3.5" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
