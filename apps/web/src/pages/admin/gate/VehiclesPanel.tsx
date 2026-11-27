import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { VehicleList } from '@/components/gate/VehicleList';
import { Alert, Button, Card, CardTitle, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useAllVehicles, useDeskActions, useUnitResidents } from '@/hooks/useGate';
import { errorMessage } from '@/lib/api/errors';
import { normalizePlate, plateError } from '@/lib/gate/plate';
import { UnitPicker } from './shared';

/**
 * Yonetim: sitedeki tum araclar; daire sakini adina plaka ekleme (sahip secimi zorunlu: sahip
 * tasininca arac gorevliye pasif gorunur), pasife alma (denetim gunlugune yazilir).
 */
export function VehiclesPanel() {
  const list = useAllVehicles();
  const a = useDeskActions();
  const [q, setQ] = useState('');
  const [unitId, setUnitId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const residents = useUnitResidents(unitId);
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const plateMsg = touched ? plateError(plate) : undefined;

  const items = useMemo(() => {
    const term = normalizePlate(q);
    const t = q.trim().toLocaleLowerCase('tr');
    return (list.data?.items ?? []).filter((v) => !q.trim() || v.plate.includes(term) || v.unitLabel.toLocaleLowerCase('tr').includes(t));
  }, [list.data, q]);

  const add = () => {
    setTouched(true);
    if (plateError(plate) || !unitId || !ownerUserId) return;
    a.createVehicle.mutate(
      { unitId, ownerUserId, plate: normalizePlate(plate), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setPlate('');
          setNote('');
          setTouched(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <CardTitle>Daire adına araç ekle</CardTitle>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-small font-medium">Bağımsız bölüm</span>
            <UnitPicker
              value={unitId}
              onChange={(u) => {
                setUnitId(u);
                setOwnerUserId('');
              }}
            />
            {unitId && (
              <FormField label="Aracın sahibi" hint="Bölümde oturan sakin; taşınınca araç güvenliğe pasif görünür">
                <Select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} disabled={residents.isPending}>
                  <option value="">{residents.data?.length === 0 ? 'Bu bölümde oturan sakin yok' : 'Sakin seçin'}</option>
                  {(residents.data ?? []).map((r) => (
                    <option key={r.userId} value={r.userId}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <FormField label="Plaka" error={plateMsg} hint="Örnek: 34 ABC 123">
              <Input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} onBlur={() => setTouched(true)} maxLength={14} autoCapitalize="characters" className="font-mono" />
            </FormField>
            <FormField label="Not (isteğe bağlı)" hint="Renk / marka; görevli görür">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} />
            </FormField>
          </div>
        </div>
        {a.createVehicle.error && <Alert tone="danger">{errorMessage(a.createVehicle.error)}</Alert>}
        <div className="flex justify-end">
          <Button disabled={!unitId || !ownerUserId} loading={a.createVehicle.isPending} onClick={add}>
            <Plus className="size-4" aria-hidden="true" />
            Aracı kaydet
          </Button>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading font-semibold">Kayıtlı araçlar{list.data ? ` (${list.data.items.length})` : ''}</h2>
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Plaka veya daire ara" aria-label="Araç ara" className="max-w-xs" />
      </div>
      {toggleError && <Alert tone="danger">{toggleError}</Alert>}
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-small text-muted">Kayıtlı araç yok.</p>
      ) : (
        <VehicleList
          items={items}
          pendingId={pendingId}
          onToggle={(v) => {
            setPendingId(v.vehicleId);
            setToggleError(undefined);
            a.updateVehicle.mutate(
              { id: v.vehicleId, input: { version: v.version, status: v.status === 'active' ? 'inactive' : 'active' } },
              { onError: (err) => setToggleError(errorMessage(err)), onSettled: () => setPendingId(undefined) },
            );
          }}
        />
      )}
    </div>
  );
}
