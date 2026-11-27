import { Search } from 'lucide-react';
import { useState } from 'react';
import { FormField, Input, Select } from '@/components/ui';
import { useEquipmentNames, useEquipmentSearch } from '@/hooks/useEquipment';
import type { Equipment } from '@/lib/api/equipment';

type Props = {
  label: string;
  hint?: string;
  value: string;
  onChange: (equipmentId: string, equipment?: Equipment) => void;
};

/**
 * v2: talep ve bakim sablonu formlarinda ekipman secimi. Secenekler sunucuda aranir (en fazla
 * `EQUIPMENT_PICKER_LIMIT`); fazlasi varsa arama kutusu gorunur, liste sessizce kesilmez. Bagli
 * ekipman hizmetten cikmis ya da sonuclarda yoksa adiyla ("(hizmet dışı)") yine secili gosterilir.
 * Kayit yoksa (ya da rol sicili okuyamiyorsa) hic gorunmez.
 */
export function EquipmentSelect({ label, hint, value, onChange }: Props) {
  const [term, setTerm] = useState('');
  const search = useEquipmentSearch(term);
  const nameOf = useEquipmentNames([value]);
  const items = search.data?.items ?? [];
  const total = search.data?.total ?? 0;
  const searchable = total > items.length || term.trim() !== '';
  if (!search.data || (total === 0 && !term.trim() && !value)) return null;
  const selectedMissing = !!value && !items.some((e) => e.equipmentId === value);

  return (
    <div className="flex flex-col gap-2">
      <FormField label={label} hint={searchable ? `${total} kayıttan ${items.length} tanesi gösteriliyor; aşağıdan arayın.` : hint}>
        <Select value={value} onChange={(e) => onChange(e.target.value, items.find((x) => x.equipmentId === e.target.value))}>
          <option value="">Bağlı değil</option>
          {selectedMissing && <option value={value}>{nameOf(value) ?? 'Ekipman kaydı'}</option>}
          {items.map((e) => (
            <option key={e.equipmentId} value={e.equipmentId}>
              {e.name}
            </option>
          ))}
        </Select>
      </FormField>
      {searchable && (
        <div className="relative">
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Ekipman ara (ad, marka, seri no)" aria-label="Ekipman ara" className="pl-9" />
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
