import { ApiError } from '@bm/shared/api/errors';
import { type FeatureKey, type FeatureMap, type SiteFeatures, featureMapOf, siteFeaturesSchema, uniformFeatures } from '@bm/shared/features/catalog';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, createContext, use, useMemo } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { useServices } from '@/services';

/*
 * Adim 1 - sitenin ozellik anahtarlari (web: context/SiteFeaturesContext.tsx, ayni API: GET /api/site-features).
 *  - Yuklenirken ve hata durumunda kapali ozellikler GIZLI kalir (fail closed); API de 403 doner.
 *  - Saglayici disinda (tekil ekran testleri) eski davranis: her sey acik.
 *  - Anahtar apartman + kullanici: baglam degisince yeni sitenin durumu okunur.
 */

export type SiteFeaturesValue = {
  /** 'none': saglayici yok -> her sey acik (Adim 1 oncesi davranis). */
  status: 'none' | 'loading' | 'ready' | 'error';
  features: FeatureMap;
  isEnabled: (key: FeatureKey) => boolean;
  catalog?: SiteFeatures['catalog'];
  retry: () => void;
};

const ALL_ON = uniformFeatures(true);
const ALL_OFF = uniformFeatures(false);
const NO_PROVIDER: SiteFeaturesValue = { status: 'none', features: ALL_ON, isEnabled: () => true, retry: () => undefined };

const SiteFeaturesContext = createContext<SiteFeaturesValue>(NO_PROVIDER);

export const siteFeatureKeys = {
  current: (apt: string, user: string) => ['apartment', apt, 'site-features', user] as const,
};

export function SiteFeaturesProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  const query = useQuery({
    queryKey: siteFeatureKeys.current(apt, user?.sub ?? ''),
    queryFn: ({ signal }) => api.get('/api/site-features', { signal, schema: siteFeaturesSchema }),
    enabled: !!apt && !!user?.role,
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });

  const { refetch } = query;
  const value = useMemo<SiteFeaturesValue>(() => {
    const retryFetch = () => void refetch();
    // Baglam secilmeden (apartman yok) apartman ekrani acilmaz: her sey kapali, beklenecek bir sey yok.
    if (!apt) return { status: 'ready', features: ALL_OFF, isEnabled: () => false, retry: retryFetch };
    if (query.data) {
      const features = featureMapOf(query.data);
      return { status: 'ready', features, isEnabled: (k) => features[k], catalog: query.data.catalog, retry: retryFetch };
    }
    return { status: query.isError ? 'error' : 'loading', features: ALL_OFF, isEnabled: () => false, retry: retryFetch };
  }, [apt, query.data, query.isError, refetch]);

  return <SiteFeaturesContext value={value}>{children}</SiteFeaturesContext>;
}

export function useSiteFeatures(): SiteFeaturesValue {
  return use(SiteFeaturesContext);
}

/** Tek anahtar: kapaliysa / yukleniyorsa / okunamadiysa false (saglayici disinda true). */
export function useFeature(key: FeatureKey): boolean {
  return use(SiteFeaturesContext).isEnabled(key);
}
