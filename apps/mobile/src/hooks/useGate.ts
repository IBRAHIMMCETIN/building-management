import type { CreatePassInput, CreateVehicleInput, UpdateVehicleInput } from '@bm/shared/api/portalGate';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthProvider';
import { portalGateApi } from '@/lib/api/portalGate';
import { useServices } from '@/services';
import { portalKeys } from './usePortal';

/*
 * Sakin "Ziyaretçi" (web: hooks/useGate.ts sakin bolumu). Bekleyen kurye onayi ekran acikken 15 sn'de
 * bir yenilenir (arka planda durur) ve uygulama one gelince hemen tazelenir (focusManager AppState'e
 * bagli + PortalForegroundRefresh). Kurye kaydinda oturan sakinlere bildirim de gider; yenileme yedektir.
 */

export const COURIER_POLL_MS = 15_000;

export const gateKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'gate'] as const,
  overview: (apt: string, user: string) => [...gateKeys.all(apt, user), 'overview'] as const,
  vehicles: (apt: string, user: string) => [...gateKeys.all(apt, user), 'vehicles'] as const,
  passes: (apt: string, user: string) => [...gateKeys.all(apt, user), 'passes'] as const,
  couriers: (apt: string, user: string) => [...gateKeys.all(apt, user), 'couriers'] as const,
  log: (apt: string, user: string, unitId: string) => [...gateKeys.all(apt, user), 'log', unitId] as const,
};

function useScope() {
  const { user } = useAuth();
  const { api } = useServices();
  const apt = user?.apartmentId ?? '';
  return { api, apt, userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!apt };
}

export function useMyGate() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: gateKeys.overview(apt, userId), queryFn: ({ signal }) => portalGateApi.overview(api, signal), enabled, staleTime: 5 * 60_000 });
}

export function useMyVehicles() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: gateKeys.vehicles(apt, userId), queryFn: ({ signal }) => portalGateApi.vehicles(api, signal), enabled });
}

export function useMyPasses() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: gateKeys.passes(apt, userId), queryFn: ({ signal }) => portalGateApi.passes(api, signal).then((r) => r.items), enabled });
}

export function useMyCouriers() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: gateKeys.couriers(apt, userId),
    queryFn: ({ signal }) => portalGateApi.couriers(api, signal).then((r) => r.items),
    enabled,
    refetchInterval: COURIER_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/** Dairenin son 7 gunluk kapi kayitlari: "Daha fazla yükle" ile sayfali. */
export function useGateLog(unitId: string) {
  const { api, apt, userId, enabled } = useScope();
  return useInfiniteQuery({
    queryKey: gateKeys.log(apt, userId, unitId),
    queryFn: ({ signal, pageParam }) => portalGateApi.log(api, { unitId, cursor: pageParam }, signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useMyGateActions() {
  const { api, apt, userId } = useScope();
  const qc = useQueryClient();
  const opts = { onSettled: () => qc.invalidateQueries({ queryKey: gateKeys.all(apt, userId) }) };
  return {
    createPass: useMutation({ mutationFn: (v: CreatePassInput) => portalGateApi.createPass(api, v), ...opts }),
    revokePass: useMutation({ mutationFn: (v: { id: string; version: number }) => portalGateApi.revokePass(api, v.id, v.version), ...opts }),
    rotatePass: useMutation({ mutationFn: (v: { id: string; version: number }) => portalGateApi.rotatePass(api, v.id, v.version), ...opts }),
    respondCourier: useMutation({
      mutationFn: (v: { id: string; version: number; decision: 'approve' | 'decline' }) => portalGateApi.respondCourier(api, v.id, { version: v.version, decision: v.decision }),
      ...opts,
    }),
    createVehicle: useMutation({ mutationFn: (v: CreateVehicleInput) => portalGateApi.createVehicle(api, v), ...opts }),
    updateVehicle: useMutation({ mutationFn: (v: { id: string; input: UpdateVehicleInput }) => portalGateApi.updateVehicle(api, v.id, v.input), ...opts }),
  };
}
