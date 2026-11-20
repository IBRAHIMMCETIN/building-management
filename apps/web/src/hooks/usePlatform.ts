import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/errors';
import { platformApi } from '@/lib/api/platform';
import { useAuth } from './useAuth';

const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

export const platformKeys = {
  apartments: () => ['platform', 'apartments'] as const,
};

/** Platform yoneticisi: tum apartmanlarin dizini (apartman ici veri yok). */
export function usePlatformApartments() {
  const { user } = useAuth();
  return useQuery({
    queryKey: platformKeys.apartments(),
    queryFn: ({ signal }) => platformApi.apartments(signal),
    enabled: user?.role === 'platform_admin',
    retry,
  });
}
