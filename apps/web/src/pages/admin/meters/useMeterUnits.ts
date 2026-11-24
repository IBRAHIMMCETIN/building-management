import { useMemo } from 'react';
import { useBlocks, useUnits } from '@/hooks/useUnits';

export type MeterUnitOption = { unitId: string; blockId: string; blockName: string; number: string; label: string };

/** Aktif daireler (blok + no sirali) ve blok adlari: sayac ekranlarinin ortak secicisi. */
export function useMeterUnits() {
  const units = useUnits();
  const blocks = useBlocks();
  const blockName = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const options = useMemo<MeterUnitOption[]>(
    () =>
      (units.data?.items ?? [])
        .filter((u) => u.status === 'active')
        .map((u) => {
          const name = blockName.get(u.blockId) ?? '';
          return { unitId: u.unitId, blockId: u.blockId, blockName: name, number: u.number, label: name ? `${name} · ${u.number}` : u.number };
        })
        .sort((a, b) => a.blockName.localeCompare(b.blockName, 'tr') || a.number.localeCompare(b.number, 'tr', { numeric: true })),
    [units.data, blockName],
  );
  const activeBlocks = useMemo(() => (blocks.data ?? []).filter((b) => b.status === 'active'), [blocks.data]);
  const labelOf = useMemo(() => new Map(options.map((o) => [o.unitId, o.label])), [options]);
  return { options, activeBlocks, blockName, labelOf, isPending: units.isPending || blocks.isPending, isError: units.isError };
}
