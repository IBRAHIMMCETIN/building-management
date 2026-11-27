import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreatePassInput, type CreateVehicleInput, type GateLogFilter, type ManualEntryInput, type UpdateVehicleInput, gateDeskApi, gatePortalApi } from '@/lib/api/gate';
import { GATE_MANAGE_ROLES, GATE_ROLES, type Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { portalKeys } from './usePortal';
import { unitKeys } from './useUnits';

/** Kurye ekranlari bu aralikla yenilenir (anlik bildirim kanali yok). */
export const COURIER_POLL_MS = 15_000;

/** API rol listeleriyle ayni (gate/routes.ts). */
export function useGatePermissions() {
  const { user } = useAuth();
  const role = user?.role;
  const has = (roles: readonly Role[]) => !!role && roles.includes(role);
  return { canUseDesk: has(GATE_ROLES), canManage: has(GATE_MANAGE_ROLES), isGuard: role === 'security_guard' };
}

export const gateKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'gate'] as const,
  units: (apt: string, q: string) => [...gateKeys.all(apt), 'units', q] as const,
  plate: (apt: string, q: string) => [...gateKeys.all(apt), 'plate', q] as const,
  vehicles: (apt: string) => [...gateKeys.all(apt), 'vehicles'] as const,
  passes: (apt: string, status: string) => [...gateKeys.all(apt), 'passes', status] as const,
  couriers: (apt: string, status: string) => [...gateKeys.all(apt), 'couriers', status] as const,
  log: (apt: string, f: GateLogFilter) => [...gateKeys.all(apt), 'log', f] as const,
};

function useDesk() {
  const { user } = useAuth();
  const { canUseDesk, canManage } = useGatePermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canUseDesk, manage: !!user?.apartmentId && canManage };
}

function useInvalidateDesk() {
  const { apt } = useDesk();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: gateKeys.all(apt) });
}

export function useGateUnits(q: string) {
  const { apt, enabled } = useDesk();
  return useQuery({ queryKey: gateKeys.units(apt, q), queryFn: ({ signal }) => gateDeskApi.units(q, signal).then((r) => r.items), enabled, staleTime: 5 * 60_000 });
}

/** Yonetici: bolumde oturan uyeler (arac sahibi secimi). */
export function useUnitResidents(unitId: string) {
  const { apt, manage } = useDesk();
  return useQuery({ queryKey: [...gateKeys.all(apt), 'unit-residents', unitId] as const, queryFn: ({ signal }) => gateDeskApi.unitResidents(unitId, signal).then((r) => r.items), enabled: manage && !!unitId });
}

/** Plaka sorgusu: yalnizca gonderildiginde (her tus vurusunda degil). */
export function usePlateLookup(q: string | undefined) {
  const { apt, enabled } = useDesk();
  return useQuery({ queryKey: gateKeys.plate(apt, q ?? ''), queryFn: ({ signal }) => gateDeskApi.lookupPlate(q ?? '', signal), enabled: enabled && !!q, staleTime: 30_000, retry: false });
}

export function useAllVehicles() {
  const { apt, manage } = useDesk();
  return useQuery({ queryKey: gateKeys.vehicles(apt), queryFn: ({ signal }) => gateDeskApi.vehicles(signal), enabled: manage });
}

export function useManagerPasses(status: string) {
  const { apt, manage } = useDesk();
  return useQuery({ queryKey: gateKeys.passes(apt, status), queryFn: ({ signal }) => gateDeskApi.passes(status, signal).then((r) => r.items), enabled: manage });
}

export function useDeskCouriers(status: 'open' | 'all') {
  const { apt, enabled } = useDesk();
  return useQuery({ queryKey: gateKeys.couriers(apt, status), queryFn: ({ signal }) => gateDeskApi.couriers(status, signal), enabled, refetchInterval: COURIER_POLL_MS });
}

/** Kapi gunlugu: "daha fazla yukle" ile sayfali. */
export function useGateLog(f: GateLogFilter, opts: { portal?: boolean } = {}) {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  const portal = !!opts.portal;
  const { canUseDesk } = useGatePermissions();
  const enabled = !!apt && (portal ? user?.role === 'resident' : canUseDesk);
  return useInfiniteQuery({
    queryKey: portal ? [...portalKeys.all(apt, user?.sub ?? ''), 'gate', 'log', f] : gateKeys.log(apt, f),
    queryFn: ({ signal, pageParam }) => (portal ? gatePortalApi : gateDeskApi).log({ ...f, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useDeskActions() {
  const invalidate = useInvalidateDesk();
  const opts = { onSettled: invalidate };
  return {
    verify: useMutation({ mutationFn: gateDeskApi.verifyPass }),
    passEntry: useMutation({ mutationFn: (v: { id: string; key: string }) => gateDeskApi.passEntry(v.id, v.key), ...opts }),
    passExit: useMutation({ mutationFn: (v: { id: string; key: string }) => gateDeskApi.passExit(v.id, v.key), ...opts }),
    revokePass: useMutation({ mutationFn: (v: { id: string; version: number }) => gateDeskApi.revokePass(v.id, v.version), ...opts }),
    createCourier: useMutation({ mutationFn: gateDeskApi.createCourier, ...opts }),
    courierEntry: useMutation({ mutationFn: (v: { id: string; key: string }) => gateDeskApi.courierEntry(v.id, v.key), ...opts }),
    courierExit: useMutation({ mutationFn: (v: { id: string; key: string }) => gateDeskApi.courierExit(v.id, v.key), ...opts }),
    cancelCourier: useMutation({ mutationFn: (v: { id: string; version: number }) => gateDeskApi.cancelCourier(v.id, v.version), ...opts }),
    manualEntry: useMutation({ mutationFn: (v: ManualEntryInput) => gateDeskApi.manualEntry(v), ...opts }),
    createVehicle: useMutation({ mutationFn: (v: CreateVehicleInput) => gateDeskApi.createVehicle(v), ...opts }),
    updateVehicle: useMutation({ mutationFn: (v: { id: string; input: UpdateVehicleInput }) => gateDeskApi.updateVehicle(v.id, v.input), ...opts }),
  };
}

// ---------------------------------------------------------------------------
// Sakin portali
// ---------------------------------------------------------------------------

function usePortalScope() {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  const userId = user?.sub ?? '';
  return { key: [...portalKeys.all(apt, userId), 'gate'] as const, enabled: user?.role === 'resident' && !!apt };
}

export function useMyGate() {
  const { key, enabled } = usePortalScope();
  return useQuery({ queryKey: [...key, 'overview'], queryFn: ({ signal }) => gatePortalApi.overview(signal), enabled, staleTime: 5 * 60_000 });
}

export function useMyVehicles() {
  const { key, enabled } = usePortalScope();
  return useQuery({ queryKey: [...key, 'vehicles'], queryFn: ({ signal }) => gatePortalApi.vehicles(signal), enabled });
}

export function useMyPasses() {
  const { key, enabled } = usePortalScope();
  return useQuery({ queryKey: [...key, 'passes'], queryFn: ({ signal }) => gatePortalApi.passes(signal).then((r) => r.items), enabled });
}

/**
 * Bekleyen kurye onayi: sayfa acikken 15 sn'de bir yenilenir. Kurye kaydinda oturan sakinlere
 * e-posta da gider (`GATE_COURIER_ARRIVED`); yenileme e-posta kapali / gecikmeli ise yedektir.
 */
export function useMyCouriers() {
  const { key, enabled } = usePortalScope();
  return useQuery({ queryKey: [...key, 'couriers'], queryFn: ({ signal }) => gatePortalApi.couriers(signal).then((r) => r.items), enabled, refetchInterval: COURIER_POLL_MS });
}

export function useMyGateActions() {
  const { key } = usePortalScope();
  const qc = useQueryClient();
  const opts = { onSettled: () => qc.invalidateQueries({ queryKey: key }) };
  return {
    createPass: useMutation({ mutationFn: (v: CreatePassInput) => gatePortalApi.createPass(v), ...opts }),
    revokePass: useMutation({ mutationFn: (v: { id: string; version: number }) => gatePortalApi.revokePass(v.id, v.version), ...opts }),
    rotatePass: useMutation({ mutationFn: (v: { id: string; version: number }) => gatePortalApi.rotatePass(v.id, v.version), ...opts }),
    respondCourier: useMutation({ mutationFn: (v: { id: string; version: number; decision: 'approve' | 'decline' }) => gatePortalApi.respondCourier(v.id, { version: v.version, decision: v.decision }), ...opts }),
    createVehicle: useMutation({ mutationFn: (v: CreateVehicleInput) => gatePortalApi.createVehicle(v), ...opts }),
    updateVehicle: useMutation({ mutationFn: (v: { id: string; input: UpdateVehicleInput }) => gatePortalApi.updateVehicle(v.id, v.input), ...opts }),
  };
}
