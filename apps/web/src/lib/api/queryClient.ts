import { QueryClient } from '@tanstack/react-query';
import { ApiError, AuthRequiredError } from './errors';

/** 4xx (ve oturum) hatalari tekrar denenmez; ag/5xx hatalari 2 kez denenir. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof AuthRequiredError) return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Finansal yazimlar otomatik tekrarlanmaz; tekrar idempotency key ile bilincli yapilir.
      retry: false,
    },
  },
});
