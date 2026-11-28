import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { siteFeatureKeys } from '@/context/SiteFeaturesContext';
import { ApiError } from '@/lib/api/errors';
import { type UpdateSiteFeaturesInput, siteFeaturesApi } from '@/lib/api/siteFeatures';
import type { FeatureKey } from '@/lib/features/catalog';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';

const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

/** "Acilmasini istiyorum" talebini gonderebilen roller (API ile ayni). */
export const FEATURE_REQUEST_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];
const REQUEST_READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

export const featureAdminKeys = {
  siteRequests: (apt: string) => ['site-features', apt, 'requests'] as const,
  platformSite: (siteId: string) => ['platform', 'site-features', siteId] as const,
  pending: () => ['platform', 'site-features', 'requests'] as const,
};

export function useCanRequestFeature(): boolean {
  const { user, support } = useAuth();
  return !support && !!user?.role && FEATURE_REQUEST_ROLES.includes(user.role);
}

/** Aktif apartmanin bekleyen talepleri (yonetim + denetci). */
export function useSiteFeatureRequests() {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  return useQuery({
    queryKey: featureAdminKeys.siteRequests(apt),
    queryFn: ({ signal }) => siteFeaturesApi.siteRequests(signal).then((r) => r.items),
    enabled: !!apt && !!user?.role && REQUEST_READ_ROLES.includes(user.role),
    retry,
  });
}

export function useRequestFeature() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const apt = user?.apartmentId ?? '';
  return useMutation({
    mutationFn: ({ feature, note }: { feature: FeatureKey; note?: string }) => siteFeaturesApi.requestEnable(feature, note),
    onSettled: () => qc.invalidateQueries({ queryKey: featureAdminKeys.siteRequests(apt) }),
  });
}

// ----- Platform -----

export function usePlatformSiteFeatures(siteId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: featureAdminKeys.platformSite(siteId ?? ''),
    queryFn: ({ signal }) => siteFeaturesApi.platformGet(siteId as string, signal),
    enabled: !!siteId && user?.role === 'platform_admin',
    retry,
  });
}

export function useUpdateSiteFeatures(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSiteFeaturesInput) => siteFeaturesApi.platformUpdate(siteId, input),
    onSuccess: (view) => qc.setQueryData(featureAdminKeys.platformSite(siteId), view),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: featureAdminKeys.platformSite(siteId) });
      void qc.invalidateQueries({ queryKey: featureAdminKeys.pending() });
      // Ayni tarayicida o sitenin baglamindaki onbellek (destek gorunumu) de tazelensin.
      void qc.invalidateQueries({ queryKey: siteFeatureKeys.current(siteId, '').slice(0, 2) });
    },
  });
}

export function usePendingFeatureRequests() {
  const { user } = useAuth();
  return useQuery({
    queryKey: featureAdminKeys.pending(),
    queryFn: ({ signal }) => siteFeaturesApi.pendingRequests(signal).then((r) => r.items),
    enabled: user?.role === 'platform_admin',
    retry,
  });
}

export function useDismissFeatureRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { siteId: string; feature: FeatureKey; reason: string }) => siteFeaturesApi.dismissRequest(v.siteId, v.feature, v.reason),
    onSettled: () => qc.invalidateQueries({ queryKey: featureAdminKeys.pending() }),
  });
}
