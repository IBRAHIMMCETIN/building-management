import { useQuery } from '@tanstack/react-query';
import { type ReactNode, createContext, use, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api/errors';
import { type FeatureDefinition, type SiteFeatureView, siteFeaturesApi } from '@/lib/api/siteFeatures';
import { type FeatureKey, type FeatureMap, uniformFeatures } from '@/lib/features/catalog';

export type SiteFeaturesValue = {
  /** 'none': saglayici yok (tekil bilesen testleri) -> eski davranis, her sey acik. */
  status: 'none' | 'loading' | 'ready' | 'error';
  features: FeatureMap;
  isEnabled: (key: FeatureKey) => boolean;
  view?: SiteFeatureView;
  catalog: readonly FeatureDefinition[];
};

const ALL_ON = uniformFeatures(true);
const ALL_OFF = uniformFeatures(false);

/** Saglayici disinda (bilesen testleri) Adim 1 oncesi davranis: tum ozellikler acik. */
const NO_PROVIDER: SiteFeaturesValue = { status: 'none', features: ALL_ON, isEnabled: () => true, catalog: [] };

const SiteFeaturesContext = createContext<SiteFeaturesValue>(NO_PROVIDER);

export const siteFeatureKeys = {
  current: (apt: string, user: string) => ['site-features', apt, user] as const,
};

/**
 * Aktif apartmanin ozellik anahtarlarini okur (AdminLayout / ResidentLayout).
 *  - Yuklenirken ve hata durumunda kapali ozellikler GIZLI kalir (fail closed); API zaten 403 doner.
 *  - Platform yoneticisi (apartman baglami yok) apartman ekrani gormez; destek oturumunda
 *    (denetci gorunumu) sitenin gercek durumu gosterilir.
 */
export function SiteFeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  const query = useQuery({
    queryKey: siteFeatureKeys.current(apt, user?.sub ?? ''),
    queryFn: ({ signal }) => siteFeaturesApi.current(signal),
    enabled: !!apt && !!user?.role && user.role !== 'platform_admin',
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });

  const value = useMemo<SiteFeaturesValue>(() => {
    if (!apt) return { status: 'ready', features: ALL_OFF, isEnabled: () => false, catalog: [] };
    if (query.data) {
      const features = query.data.features as FeatureMap;
      return { status: 'ready', features, isEnabled: (k) => features[k] === true, view: query.data, catalog: query.data.catalog };
    }
    return { status: query.isError ? 'error' : 'loading', features: ALL_OFF, isEnabled: () => false, catalog: [] };
  }, [apt, query.data, query.isError]);

  return <SiteFeaturesContext value={value}>{children}</SiteFeaturesContext>;
}

export function useSiteFeatures(): SiteFeaturesValue {
  return use(SiteFeaturesContext);
}

/** Tek anahtar: kapaliysa / yukleniyorsa false. */
export function useFeature(key: FeatureKey): boolean {
  return use(SiteFeaturesContext).isEnabled(key);
}
