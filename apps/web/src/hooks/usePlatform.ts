import type { DemoEraseStatus } from '@bm/shared/api/demoRequests';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/errors';
import { platformApi } from '@/lib/api/platform';
import { useAuth } from './useAuth';

const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

export const platformKeys = {
  apartments: () => ['platform', 'apartments'] as const,
  demoRequests: () => ['platform', 'demo-requests'] as const,
};

/** Platform yoneticisi: tanitim sayfasindan gelen demo talepleri (en yeni once, 25'er). */
export function useDemoRequests() {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: platformKeys.demoRequests(),
    queryFn: ({ signal, pageParam }) => platformApi.demoRequests(pageParam || undefined, signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor,
    enabled: user?.role === 'platform_admin',
    retry,
  });
}

/** KVKK silme talebi / spam: basarida liste yeniden yuklenir (kayit listeden duser). */
export function useEraseDemoRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, ...body }: { requestId: string; status: DemoEraseStatus; reason: string }) => platformApi.eraseDemoRequest(requestId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: platformKeys.demoRequests() }),
  });
}

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
