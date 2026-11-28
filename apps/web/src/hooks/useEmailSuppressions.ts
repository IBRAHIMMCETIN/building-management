import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/errors';
import { emailSuppressionsApi } from '@/lib/api/emailSuppressions';

const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;
const KEY = ['platform', 'email-suppressions'] as const;

/** Platform: e-posta engelleri (sayfali; "Daha fazla göster"). */
export function useEmailSuppressions(status: 'active' | 'all') {
  return useInfiniteQuery({
    queryKey: [...KEY, status] as const,
    queryFn: ({ pageParam, signal }) => emailSuppressionsApi.list(status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    retry,
  });
}

/** E-postayla arama (adres istek govdesinde). */
export function useLookupSuppression() {
  return useMutation({ mutationFn: (email: string) => emailSuppressionsApi.lookup(email) });
}

export function useClearSuppression() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emailHash, reason }: { emailHash: string; reason: string }) => emailSuppressionsApi.clear(emailHash, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
