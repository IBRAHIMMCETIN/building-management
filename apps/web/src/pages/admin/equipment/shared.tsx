import { Badge } from '@/components/ui';
import type { ExpiryItem } from '@/lib/api/equipment';
import { formatDate } from '@/lib/dates';
import { EQUIPMENT_STATUS_LABELS, EXPIRY_KIND_LABELS, type EquipmentStatus, daysLeftText } from '@/lib/equipment/model';

const STATUS_TONES: Record<EquipmentStatus, 'success' | 'warning' | 'neutral'> = { active: 'success', out_of_service: 'warning', retired: 'neutral' };

export function EquipmentStatusBadge({ status }: { status: EquipmentStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{EQUIPMENT_STATUS_LABELS[status]}</Badge>;
}

/** Garanti / sozlesme / kontrol tarihi: gecmisse kirmizi, yaklasiyorsa turuncu; metin de durumu tasir. */
export function ExpiryBadge({ item }: { item: Pick<ExpiryItem, 'kind' | 'date' | 'expired' | 'daysLeft'> }) {
  return (
    <Badge tone={item.expired ? 'danger' : 'warning'}>
      {EXPIRY_KIND_LABELS[item.kind]}: {formatDate(item.date)} ({daysLeftText(item.daysLeft)})
    </Badge>
  );
}
