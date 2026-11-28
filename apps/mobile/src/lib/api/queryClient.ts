import { ApiError, AuthRequiredError } from '@bm/shared/api/errors';
import { QueryClient } from '@tanstack/react-query';

/** 4xx (ve oturum) hatalari tekrar denenmez; ag/5xx hatalari 2 kez denenir (web ile ayni). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof AuthRequiredError) return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Cevrimdisi (onlineManager, NetInfo): sorgular bekler ve baglanti gelince kendiliginden yenilenir;
      // ekrandaki veri silinmez.
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Finansal yazimlar otomatik tekrarlanmaz.
        retry: false,
        // Cevrimdisiyken yazim sessizce kuyrukta beklemez (sonra kendiliginden gitmez): API istemcisi
        // hemen `OfflineError` ("Çevrimdışısınız: işlem gönderilmedi...") ile reddeder.
        networkMode: 'always',
      },
    },
  });
}
