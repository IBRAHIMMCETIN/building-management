import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useDeskCouriers, useGatePermissions } from '@/hooks/useGate';
import { CourierDesk } from './CourierDesk';
import { GateLogPanel } from './GateLogPanel';
import { PassDesk } from './PassDesk';
import { PassesPanel } from './PassesPanel';
import { PlateDesk } from './PlateDesk';
import { VehiclesPanel } from './VehiclesPanel';

type Tab = 'pass' | 'plate' | 'courier' | 'log' | 'vehicles' | 'passes';
const TABS: readonly Tab[] = ['pass', 'plate', 'courier', 'log', 'vehicles', 'passes'];

/**
 * Guvenlik Kapisi. Guvenlik gorevlisi (mobil oncelikli, buyuk dokunma alanlari): misafir QR /
 * kisa kod, plaka sorgusu, kurye ve dun + bugunun kapi kayitlari. Yonetim ayrica arac sicilini,
 * misafir gecislerini ve tum kapi gunlugunu (tarih filtresi) yonetir.
 */
export function GatePage() {
  const p = useGatePermissions();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const allowed = TABS.filter((t) => p.canManage || (t !== 'vehicles' && t !== 'passes'));
  const [tab, setTabState] = useState<Tab>(requested && allowed.includes(requested) ? requested : 'pass');
  const couriers = useDeskCouriers('open');
  const waiting = couriers.data?.items.length;
  const setTab = (t: Tab) => {
    setTabState(t);
    setParams(t === 'pass' ? {} : { tab: t }, { replace: true });
  };

  if (!p.canUseDesk) return <Alert>Bu sayfa güvenlik görevlisi ve yönetim içindir.</Alert>;

  const options: { value: Tab; label: string; count?: number }[] = [
    { value: 'pass', label: 'Misafir QR / kod' },
    { value: 'plate', label: 'Plaka sorgu' },
    { value: 'courier', label: 'Kurye', ...(waiting ? { count: waiting } : {}) },
    { value: 'log', label: 'Kapı kayıtları' },
    ...(p.canManage
      ? [
          { value: 'vehicles' as const, label: 'Araçlar' },
          { value: 'passes' as const, label: 'Misafir geçişleri' },
        ]
      : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="text-title font-bold">Güvenlik Kapısı</h1>
      {/* Buyuk dokunma alanli sekmeler (eldivenle / tek elle kullanim). */}
      <div role="group" aria-label="Kapı işlemleri" className={cn('grid gap-2', p.canManage ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-4')}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={tab === o.value}
            onClick={() => setTab(o.value)}
            className={cn(
              'inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-body font-medium text-text-secondary transition-colors',
              'hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              tab === o.value && 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15',
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="rounded-full bg-warning/15 px-2 text-small font-semibold text-warning tabular-nums">{o.count}</span>}
          </button>
        ))}
      </div>
      {tab === 'pass' && <PassDesk />}
      {tab === 'plate' && <PlateDesk />}
      {tab === 'courier' && <CourierDesk />}
      {tab === 'log' && <GateLogPanel />}
      {tab === 'vehicles' && p.canManage && <VehiclesPanel />}
      {tab === 'passes' && p.canManage && <PassesPanel />}
    </div>
  );
}
