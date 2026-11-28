import { useQuery } from '@tanstack/react-query';
import { metersApi } from '@/lib/api/meters';
import { portalKeys, retry, useScope } from './usePortal';

/*
 * Sakin tuketim gecmisi (web: hooks/useMeters.ts -> useMyConsumption). API daireyi zorunlu ister:
 * secili daire, yoksa borc ozetindeki daire (web ConsumptionPage ile ayni).
 */
export const consumptionKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'meters'] as const,
  history: (apt: string, user: string, unitId: string) => [...consumptionKeys.all(apt, user), 'consumption', unitId] as const,
};

export function useMyConsumption(unitId: string | undefined) {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: consumptionKeys.history(apt, userId, unitId ?? ''),
    queryFn: ({ signal }) => metersApi.consumption(api, unitId ?? '', signal),
    enabled: enabled && !!unitId,
    retry,
  });
}
