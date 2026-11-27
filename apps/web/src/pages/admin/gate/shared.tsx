import { useState } from 'react';
import { Input, Select } from '@/components/ui';
import { useGateUnits } from '@/hooks/useGate';

/**
 * Bolum secici: once arama (blok / daire no), sonra yerel secici. Liste API'den en fazla 50
 * bolum; yalnizca etiket (kisi bilgisi yok).
 */
export function UnitPicker({ value, onChange, id, invalid, optional }: { value: string; onChange: (unitId: string) => void; id?: string; invalid?: boolean; optional?: boolean }) {
  const [q, setQ] = useState('');
  const units = useGateUnits(q.trim());
  const items = units.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      <Input type="search" placeholder="Blok veya daire no ile ara" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Bağımsız bölüm ara" className="h-12 text-body" />
      <Select id={id} invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)} className="h-12 text-body" aria-busy={units.isFetching || undefined}>
        <option value="">{optional ? 'Bağımsız bölüm yok' : 'Bağımsız bölüm seçin'}</option>
        {items.map((u) => (
          <option key={u.unitId} value={u.unitId}>
            {u.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
