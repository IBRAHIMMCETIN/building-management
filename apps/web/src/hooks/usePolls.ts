import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { ApiError } from '@/lib/api/errors';
import { type CreatePollInput, type PollPhaseFilter, type PortalPoll, type UpdatePollInput, mergeVoteResponse, pollsApi } from '@/lib/api/polls';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { portalKeys } from './usePortal';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (polls/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function usePollPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const pollKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'polls'] as const,
  list: (apt: string, status: PollPhaseFilter) => [...pollKeys.all(apt), 'list', status] as const,
  results: (apt: string, id: string) => [...pollKeys.all(apt), 'results', id] as const,
  participation: (apt: string, id: string) => [...pollKeys.all(apt), 'participation', id] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = usePollPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function usePolls(status: PollPhaseFilter) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: pollKeys.list(apt, status),
    queryFn: ({ signal }) => pollsApi.list(status, signal).then((r) => r.items),
    enabled,
  });
}

/** Sonuc ve katilim canli degisir (acik oylama): pencere odaklaninca tazelenir. */
export function usePollResults(id: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: pollKeys.results(apt, id ?? ''),
    queryFn: ({ signal }) => pollsApi.results(id ?? '', signal),
    enabled: enabled && !!id,
  });
}

export function usePollParticipation(id: string | undefined, active: boolean) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: pollKeys.participation(apt, id ?? ''),
    queryFn: ({ signal }) => pollsApi.participation(id ?? '', signal),
    enabled: enabled && !!id && active,
  });
}

/** Her yazim listeleri etkiler; 409 (surum cakismasi) sonrasi da guncel veri cekilir. */
function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: pollKeys.all(apt) });
}

export function useCreatePoll() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreatePollInput) => pollsApi.create(input), onSettled: invalidate });
}

export function useUpdatePoll() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePollInput }) => pollsApi.update(id, input), onSettled: invalidate });
}

export function usePublishPoll() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => pollsApi.publish(id, version), onSettled: invalidate });
}

export function useClosePoll() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, version, reason }: { id: string; version: number; reason: string }) => pollsApi.close(id, version, reason),
    onSettled: invalidate,
  });
}

export function useCancelPoll() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, version }: { id: string; version: number }) => pollsApi.cancel(id, version), onSettled: invalidate });
}

// ---------------------------------------------------------------------------
// Sakin portali
// ---------------------------------------------------------------------------

/** Daire secimi / uyelik yok gibi "beklenen" 4xx'ler tekrar denenmez (ekran secici gosterir). */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

function usePortalScope() {
  const { user } = useAuth();
  const { unitId } = usePortalUnit();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', unitId, enabled: user?.role === 'resident' && !!user.apartmentId };
}

export const portalPollKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'polls'] as const,
  list: (apt: string, user: string, unitId?: string) => [...portalPollKeys.all(apt, user), 'list', unitId ?? 'auto'] as const,
  detail: (apt: string, user: string, id: string, unitId?: string) => [...portalPollKeys.all(apt, user), 'detail', id, unitId ?? 'auto'] as const,
};

export function useMyPolls() {
  const { apt, userId, unitId, enabled } = usePortalScope();
  return useQuery({
    queryKey: portalPollKeys.list(apt, userId, unitId),
    queryFn: ({ signal }) => pollsApi.portalList(unitId, signal).then((r) => r.items),
    enabled,
    retry,
  });
}

export function useMyPoll(id: string | undefined) {
  const { apt, userId, unitId, enabled } = usePortalScope();
  return useQuery({
    queryKey: portalPollKeys.detail(apt, userId, id ?? '', unitId),
    queryFn: ({ signal }) => pollsApi.portalGet(id ?? '', unitId, signal),
    enabled: enabled && !!id,
    retry,
  });
}

export function useVote(id: string) {
  const { apt, userId, unitId } = usePortalScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (optionId: string) => pollsApi.vote(id, unitId, optionId),
    // Oy yanitinda sonuc yok: onceki sonuc yeniden cekim gelene kadar korunur.
    onSuccess: (poll) => queryClient.setQueryData<PortalPoll>(portalPollKeys.detail(apt, userId, id, unitId), (prev) => mergeVoteResponse(poll, prev)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: portalPollKeys.all(apt, userId) }),
  });
}
