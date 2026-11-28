import { Car } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import type { ManagerVehicle } from '@/lib/api/gate';

/** Pasif aracin nedeni (yonetim): sistem tasinmada otomatik pasife alir. */
export function inactiveReasonText(v: Pick<ManagerVehicle, 'status' | 'inactiveReason'>): string | undefined {
  if (v.status !== 'inactive' || !v.inactiveReason) return undefined;
  return v.inactiveReason === 'taşınma' ? 'Sahibi taşındığı için otomatik pasife alındı' : `Pasif nedeni: ${v.inactiveReason}`;
}

/**
 * Arac listesi (yonetim + sakin): plaka, bolum, not, aktif / pasif ve durum degistirme. Sahibi tasinan
 * arac gorevliye pasif gorunur. `showReason` (yalnizca yonetim): pasif aracin nedeni (taşınma); sakin
 * listesinin anlami degismez.
 */
export function VehicleList({
  items,
  onToggle,
  pendingId,
  showUnit = true,
  showReason = false,
}: {
  items: ManagerVehicle[];
  onToggle?: (v: ManagerVehicle) => void;
  pendingId?: string;
  showUnit?: boolean;
  showReason?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((v) => {
        const reason = showReason ? inactiveReasonText(v) : undefined;
        return (
          <li key={v.vehicleId} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs">
            <Car className={v.status === 'active' ? 'size-6 shrink-0 text-accent' : 'size-6 shrink-0 text-muted'} aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-mono text-body font-semibold">{v.plateDisplay}</span>
              <span className="text-small text-text-secondary">
                {showUnit ? v.unitLabel : null}
                {showUnit && v.note ? ' · ' : null}
                {v.note}
              </span>
              {reason && <span className="text-xs text-muted">{reason}</span>}
            </span>
            <Badge tone={v.status === 'active' && !v.ownerLeft ? 'success' : 'neutral'}>{v.status !== 'active' ? 'Pasif' : v.ownerLeft ? 'Sahibi taşındı' : 'Aktif'}</Badge>
            {onToggle && (
              <Button variant="subtle" size="sm" loading={pendingId === v.vehicleId} onClick={() => onToggle(v)}>
                {v.status === 'active' ? 'Pasife al' : 'Etkinleştir'}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
