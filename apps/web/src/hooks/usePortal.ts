import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useFeature } from '@/context/SiteFeaturesContext';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { ApiError } from '@/lib/api/errors';
import { announcementsApi } from '@/lib/api/announcements';
import { portalApi } from '@/lib/api/portal';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

export const portalKeys = {
  all: (apt: string, user: string) => [...unitKeys.apartment(apt), 'portal', user] as const,
  summary: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'summary', unitId ?? 'auto'] as const,
  statement: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'statement', unitId ?? 'auto'] as const,
  announcements: (apt: string, user: string, unitId?: string) =>
    [...portalKeys.all(apt, user), 'announcements', unitId ?? 'auto'] as const,
  receipts: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'receipts', unitId ?? 'auto'] as const,
  expenses: (apt: string, user: string, month: string) => [...portalKeys.all(apt, user), 'expense-breakdown', month] as const,
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

/** Sakinin dairesinin blogunu kapsayan, yayin penceresindeki duyurular (en yeni once). */
export function useMyAnnouncements() {
  const { apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalKeys.announcements(apt, userId, unitId),
    queryFn: ({ signal }) => announcementsApi.portalList(unitId, signal).then((r) => r.items),
    enabled,
    retry,
  });
}

/** Son odemeler (makbuzlar, en yeni once). */
export function useMyReceipts() {
  const { apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalKeys.receipts(apt, userId, unitId),
    queryFn: ({ signal }) => portalApi.myReceipts(unitId, signal),
    enabled,
    retry,
  });
}

/** Adim 3: aylik gider dagilimi. `resident.expenseChart` kapaliysa istek atilmaz (API de 403 doner). */
export function useExpenseBreakdown(month: string) {
  const { apt, userId, enabled } = useScope();
  const on = useFeature('resident.expenseChart');
  return useQuery({
    queryKey: portalKeys.expenses(apt, userId, month),
    queryFn: ({ signal }) => portalApi.expenseBreakdown(month, signal),
    enabled: enabled && on,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry,
  });
}
