import { type PortalStatus, STATUS_LABELS } from '@bm/shared/api/portal';
import { CircleAlert, CircleCheck, Clock } from '@/components/icons';
import { Badge } from '@/components/ui';

const STYLE = {
  no_debt: { tone: 'success', icon: CircleCheck },
  paid: { tone: 'success', icon: CircleCheck },
  pending: { tone: 'accent', icon: Clock },
  overdue: { tone: 'warning', icon: CircleAlert },
} as const;

/** Borc durumu rozeti (web: components/portal/PortalStatusBadge.tsx). */
export function PortalStatusBadge({ status }: { status: PortalStatus }) {
  const { tone, icon } = STYLE[status];
  return <Badge tone={tone} icon={icon} label={STATUS_LABELS[status]} />;
}
