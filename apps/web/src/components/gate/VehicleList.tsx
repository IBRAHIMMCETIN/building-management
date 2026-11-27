import { Car } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import type { Vehicle } from '@/lib/api/gate';

/** Arac listesi (yonetim + sakin): plaka, bolum, not, aktif / pasif ve durum degistirme. */
export function VehicleList({ items, onToggle, pendingId, showUnit = true }: { items: Vehicle[]; onToggle?: (v: Vehicle) => void; pendingId?: string; showUnit?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((v) => (
        <li key={v.vehicleId} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs">
          <Car className={v.status === 'active' ? 'size-6 shrink-0 text-accent' : 'size-6 shrink-0 text-muted'} aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-mono text-body font-semibold">{v.plateDisplay}</span>
            <span className="text-small text-text-secondary">
              {showUnit ? v.unitLabel : null}
              {showUnit && v.note ? ' · ' : null}
              {v.note}
            </span>
          </span>
          <Badge tone={v.status === 'active' ? 'success' : 'neutral'}>{v.status === 'active' ? 'Aktif' : 'Pasif'}</Badge>
          {onToggle && (
            <Button variant="subtle" size="sm" loading={pendingId === v.vehicleId} onClick={() => onToggle(v)}>
              {v.status === 'active' ? 'Pasife al' : 'Etkinleştir'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
