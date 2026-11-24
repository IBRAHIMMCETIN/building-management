import { Gauge, Plus, Repeat, Search, Unplug } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, FilterChips, Input, Select, Skeleton } from '@/components/ui';
import { useMeterPermissions, useMeters } from '@/hooks/useMeters';
import type { Meter } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/dates';
import { METER_KIND_LABELS, METER_STATUS_LABELS, formatIndex } from '@/lib/meters/model';
import { AddMeterDialog, RetireMeterDialog, SwapMeterDialog } from './MeterDialogs';
import { useMeterUnits } from './useMeterUnits';

type StatusFilter = 'active' | 'all';

/** Daire bazli sayac sicili: her dairenin sayaclari, son onayli endeks, degisim ve sokum. */
export function MeterRegistryPanel() {
  const { canManage } = useMeterPermissions();
  const [status, setStatus] = useState<StatusFilter>('active');
  const [blockId, setBlockId] = useState('');
  const [search, setSearch] = useState('');
  const meters = useMeters({ status });
  const units = useMeterUnits();
  const [adding, setAdding] = useState<{ unitId?: string } | null>(null);
  const [swapping, setSwapping] = useState<Meter | null>(null);
  const [retiring, setRetiring] = useState<Meter | null>(null);

  const byUnit = useMemo(() => {
    const map = new Map<string, Meter[]>();
    for (const m of meters.data ?? []) map.set(m.unitId, [...(map.get(m.unitId) ?? []), m]);
    return map;
  }, [meters.data]);

  const q = search.trim().toLocaleLowerCase('tr-TR');
  const rows = units.options.filter(
    (u) =>
      (!blockId || u.blockId === blockId) &&
      (!q ||
        u.label.toLocaleLowerCase('tr-TR').includes(q) ||
        (byUnit.get(u.unitId) ?? []).some((m) => (m.serialNo ?? '').toLocaleLowerCase('tr-TR').includes(q) || m.label.toLocaleLowerCase('tr-TR').includes(q))),
  );
  const total = meters.data?.length ?? 0;
  const unitsWithout = units.options.filter((u) => !byUnit.has(u.unitId)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips<StatusFilter>
            label="Sayaç durumu"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: 'Aktif', ...(status === 'active' ? { count: total } : {}) },
              { value: 'all', label: 'Tümü (geçmiş dahil)' },
            ]}
          />
          {units.activeBlocks.length > 1 && (
            <div className="w-40">
              <Select aria-label="Blok" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                <option value="">Tüm bloklar</option>
                {units.activeBlocks.map((b) => (
                  <option key={b.blockId} value={b.blockId}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input aria-label="Daire veya seri no ara" placeholder="Daire / seri no ara" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {canManage && (
          <Button onClick={() => setAdding({})}>
            <Plus className="size-4" aria-hidden="true" />
            Sayaç ekle
          </Button>
        )}
      </div>

      {status === 'active' && !meters.isPending && unitsWithout > 0 && (
        <p className="text-small text-muted">
          {unitsWithout} dairede aktif sayaç yok — bu daireler dağıtımda yalnızca ortak payı öder.
        </p>
      )}

      {meters.isError && <Alert tone="danger">{errorMessage(meters.error)}</Alert>}
      {(meters.isPending || units.isPending) && (
        <div className="flex flex-col gap-2" role="status" aria-label="Sayaçlar yükleniyor">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}

      {!meters.isPending && !units.isPending && rows.length === 0 && <Alert>Filtreye uyan daire yok.</Alert>}

      <div className="flex flex-col gap-3">
        {!meters.isPending &&
          rows.map((u) => {
            const list = byUnit.get(u.unitId) ?? [];
            return (
              <Card key={u.unitId} className="p-4 md:p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{u.label}</h3>
                  {canManage && (
                    <Button size="xs" variant="ghost" onClick={() => setAdding({ unitId: u.unitId })}>
                      <Plus className="size-3.5" aria-hidden="true" />
                      Sayaç
                    </Button>
                  )}
                </div>
                {list.length === 0 ? (
                  <p className="mt-1 text-small text-muted">Sayaç yok.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-border">
                    {list.map((m) => (
                      <li key={m.meterId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <Gauge className="size-4 shrink-0 text-muted" aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="truncate text-small font-medium">
                              {m.label} <span className="font-normal text-muted">· {METER_KIND_LABELS[m.kind]}</span>
                            </p>
                            <p className="text-small text-muted">
                              {m.serialNo ? `Seri ${m.serialNo} · ` : ''}
                              {m.lastReading
                                ? `Son endeks ${formatIndex(m.lastReading.index, m.scale)} (${formatDate(m.lastReading.date)})`
                                : `Açılış ${formatIndex(m.openingIndex, m.scale)} (${formatDate(m.installedAt)})`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{METER_STATUS_LABELS[m.status]}</Badge>
                          {canManage && m.status === 'active' && (
                            <>
                              <Button size="xs" variant="secondary" onClick={() => setSwapping(m)}>
                                <Repeat className="size-3.5" aria-hidden="true" />
                                Değiştir
                              </Button>
                              <Button size="xs" variant="ghost" onClick={() => setRetiring(m)}>
                                <Unplug className="size-3.5" aria-hidden="true" />
                                Sök
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
      </div>

      <AddMeterDialog open={!!adding} onClose={() => setAdding(null)} units={units.options} unitId={adding?.unitId} />
      <SwapMeterDialog meter={swapping} onClose={() => setSwapping(null)} />
      <RetireMeterDialog meter={retiring} onClose={() => setRetiring(null)} />
    </div>
  );
}
