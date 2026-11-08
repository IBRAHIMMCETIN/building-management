import { useQuery } from '@tanstack/react-query';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { ApiError } from '@/lib/api/errors';
import { portalApi } from '@/lib/api/portal';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

export const portalKeys = {
  all: (apt: string, user: string) => [...unitKeys.apartment(apt), 'portal', user] as const,
  summary: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'summary', unitId ?? 'auto'] as const,
  statement: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'statement', unitId ?? 'auto'] as const,
};

/** Daire secimi / uyelik yok gibi "beklenen" 4xx'ler tekrar denenmez (ekran secici gosterir). */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

function useScope() {
  const { user } = useAuth();
  const { unitId } = usePortalUnit();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', unitId, enabled: user?.role === 'resident' && !!user.apartmentId };
}

export function useMySummary() {
  const { apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalKeys.summary(apt, userId, unitId),
    queryFn: ({ signal }) => portalApi.mySummary(unitId, signal),
    enabled,
    retry,
  });
}

export function useMyStatement() {
  const { apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalKeys.statement(apt, userId, unitId),
    queryFn: ({ signal }) => portalApi.myStatement(unitId, signal),
    enabled,
    retry,
  });
}
