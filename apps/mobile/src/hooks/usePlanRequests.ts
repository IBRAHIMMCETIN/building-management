import type { CreatePlanRequestInput } from '@bm/shared/api/planRequests';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { planRequestsApi } from '@/lib/api/planRequests';
import { portalKeys, retry, useScope } from './usePortal';

/*
 * Sakin taksit talebi (web: hooks/useRestructure.ts -> usePlanRequestOptions / useMyPlanRequests /
 * useCreatePlanRequest / useWithdrawPlanRequest). Yazim sonrasi sakin sorgularinin tamami yenilenir
 * (borc ozeti ve taksit plani da degisebilir).
 */
export const planRequestKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'plan-requests'] as const,
  options: (apt: string, user: string, unitId?: string) => [...planRequestKeys.all(apt, user), 'options', unitId ?? 'auto'] as const,
  mine: (apt: string, user: string) => [...planRequestKeys.all(apt, user), 'mine'] as const,
};

export function usePlanRequestOptions() {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({ queryKey: planRequestKeys.options(apt, userId, unitId), queryFn: ({ signal }) => planRequestsApi.options(api, unitId, signal), enabled, retry });
}

export function useMyPlanRequests() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: planRequestKeys.mine(apt, userId), queryFn: ({ signal }) => planRequestsApi.mine(api, signal).then((r) => r.items), enabled, retry });
}

export function useCreatePlanRequest() {
  const { api, apt, userId, unitId } = useScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreatePlanRequestInput, 'unitId'>) => planRequestsApi.create(api, { ...input, ...(unitId ? { unitId } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all(apt, userId) }),
  });
}

export function useWithdrawPlanRequest() {
  const { api, apt, userId } = useScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => planRequestsApi.withdraw(api, requestId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all(apt, userId) }),
  });
}
