import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { FormField, Input, Select } from '@/components/ui';
import { useEquipmentNames, useEquipmentSearch } from '@/hooks/useEquipment';
import type { Equipment } from '@/lib/api/equipment';
import { cn } from '@/lib/cn';

type Props = {
  label: string;
  hint?: string;
  value: string;
  onChange: (equipmentId: string, equipment?: Equipment) => void;
  /** Kapsayici izgaradaki yerlesim (ornek `sm:col-span-2`); bilesen gizliyken bos satir kalmaz. */
  className?: string;
};

/**
 * v2: talep ve bakim sablonu formlarinda ekipman secimi. Secenekler sunucuda aranir (en fazla
 * `EQUIPMENT_PICKER_LIMIT`); fazlasi varsa liste ustunde arama kutusu gorunur (TicketList gibi
 * Enter ile), liste sessizce kesilmez. Bagli ekipman hizmetten cikmis ya da sonuclarda yoksa
 * adiyla yine secili gosterilir. Kayit yoksa (ya da rol sicili okuyamiyorsa) hic gorunmez.
 */
export function EquipmentSelect({ label, hint, value, onChange, className }: Props) {
  const searchId = useId();
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const search = useEquipmentSearch(term);
  const nameOf = useEquipmentNames([value]);
  const items = search.data?.items ?? [];
  const total = search.data?.total ?? 0;
  const searching = term.trim() !== '';
  const searchable = total > items.length || searching;
  if (!search.data || (total === 0 && !searching && !value)) return null;
  const selectedMissing = !!value && !items.some((e) => e.equipmentId === value);
  const status = searching && total === 0 ? 'Bu aramaya uyan ekipman yok.' : total > items.length ? `${total} kayıttan ${items.length} tanesi gösteriliyor; aramayı daraltın.` : hint;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {searchable && (
        <form
          className="flex flex-col gap-1 text-xs text-muted"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setTerm(draft.trim());
          }}
        >
          <label htmlFor={searchId}>Ekipman ara (ad, marka, seri no)</label>
          <div className="relative">
            <Input id={searchId} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Asansör, SN-1001…" className="pl-9" />
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          </div>
        </form>
      )}
      <FormField label={label} hint={status}>
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
    </div>
  );
}
