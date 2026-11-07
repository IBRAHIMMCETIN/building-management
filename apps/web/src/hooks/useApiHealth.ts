import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '@/lib/api/health';

export const healthQueryKey = ['health'] as const;

export function useApiHealth() {
  return useQuery({
    queryKey: healthQueryKey,
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 60_000,
  });
}
