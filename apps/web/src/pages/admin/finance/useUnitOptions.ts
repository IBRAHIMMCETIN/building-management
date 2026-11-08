import { useMemo } from 'react';
import { useBlocks, useUnits } from '@/hooks/useUnits';

export type UnitOption = { unitId: string; label: string; blockName: string; number: string };

/** Daire secim listesi: "A Blok · 5" (blok + numaraya gore sirali). */
export function useUnitOptions() {
  const units = useUnits();
  const blocks = useBlocks();
  const options = useMemo<UnitOption[]>(() => {
    const names = new Map((blocks.data ?? []).map((b) => [b.blockId, b.name]));
    return (units.data?.items ?? [])
      .filter((u) => u.status === 'active')
      .map((u) => {
        const blockName = names.get(u.blockId) ?? '';
        return { unitId: u.unitId, number: u.number, blockName, label: blockName ? `${blockName} · ${u.number}` : u.number };
      })
      .sort((a, b) => a.blockName.localeCompare(b.blockName, 'tr') || a.number.localeCompare(b.number, 'tr', { numeric: true }));
  }, [units.data, blocks.data]);
  return { options, isPending: units.isPending || blocks.isPending, activeCount: options.length };
}
