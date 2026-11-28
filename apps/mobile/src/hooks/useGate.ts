import type { CreateCourierInput, GateLogFilter, ManualEntryInput } from '@bm/shared/api/gate';
import type { ScanResult } from '@bm/shared/gate/plate';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthProvider';
import { gateEndpoints } from '@/lib/api/gateEndpoints';
import { useServices } from '@/services';

/*
 * Guvenlik gorevlisi kapi sorgulari (web: hooks/useGate.ts masa kismi). Anahtarlar apartman bazli
 * (`['apartment', apt, 'gate', ...]`): baglam degisince onbellek temizlenir, on planda gelen bildirim
 * aktif apartmani tazeler.
 */

/** Kurye listesi bu aralikla yenilenir (gorevliye anlik bildirim yok; sakin onayi burada gorunur). */
export const COURIER_POLL_MS = 15_000;

export const gateKeys = {
  all: (apt: string) => ['apartment', apt, 'gate'] as const,
  units: (apt: string, q: string) => [...gateKeys.all(apt), 'units', q] as const,
  plate: (apt: string, q: string) => [...gateKeys.all(apt), 'plate', q] as const,
  couriers: (apt: string, status: string) => [...gateKeys.all(apt), 'couriers', status] as const,
  log: (apt: string, f: GateLogFilter) => [...gateKeys.all(apt), 'log', f] as const,
};

function useDesk() {
  const { user } = useAuth();
  const { api } = useServices();
  const apt = user?.apartmentId ?? '';
  return { api, apt, enabled: !!apt && user?.role === 'security_guard' };
}

/** Bolum secici (en fazla 50; yalnizca etiket). */
export function useGateUnits(q: string) {
  const { api, apt, enabled } = useDesk();
  return useQuery({ queryKey: gateKeys.units(apt, q), queryFn: ({ signal }) => gateEndpoints.units(api, q, signal).then((r) => r.items), enabled, staleTime: 5 * 60_000 });
}

/** Plaka sorgusu: yalnizca yeterli karakterle (cagiran beklemeli / debounced verir). 429 tekrar denenmez. */
export function usePlateLookup(q: string | undefined) {
  const { api, apt, enabled } = useDesk();
  return useQuery({ queryKey: gateKeys.plate(apt, q ?? ''), queryFn: ({ signal }) => gateEndpoints.lookupPlate(api, q ?? '', signal), enabled: enabled && !!q, staleTime: 30_000, retry: false });
}

/** Kurye listesi; `live` iken (ekran gorunur) 15 sn'de bir yenilenir. */
export function useDeskCouriers(status: 'open' | 'all', live = true) {
  const { api, apt, enabled } = useDesk();
  return useQuery({
    queryKey: gateKeys.couriers(apt, status),
    queryFn: ({ signal }) => gateEndpoints.couriers(api, status, signal),
    enabled,
    refetchInterval: live ? COURIER_POLL_MS : false,
  });
}

/** Kapi kayitlari (gorevli: dun + bugun; API de bunu zorlar), "Daha fazla yükle" ile sayfali. */
export function useGateLog(f: GateLogFilter) {
  const { api, apt, enabled } = useDesk();
  return useInfiniteQuery({
    queryKey: gateKeys.log(apt, f),
    queryFn: ({ signal, pageParam }) => gateEndpoints.log(api, { ...f, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useDeskActions() {
  const { api, apt } = useDesk();
  const qc = useQueryClient();
  const opts = { onSettled: () => qc.invalidateQueries({ queryKey: gateKeys.all(apt) }) };
  return {
    verify: useMutation({ mutationFn: (input: ScanResult) => gateEndpoints.verifyPass(api, input) }),
    passEntry: useMutation({ mutationFn: (v: { id: string; key: string }) => gateEndpoints.passEntry(api, v.id, v.key), ...opts }),
    passExit: useMutation({ mutationFn: (v: { id: string; key: string }) => gateEndpoints.passExit(api, v.id, v.key), ...opts }),
    createCourier: useMutation({ mutationFn: (v: CreateCourierInput) => gateEndpoints.createCourier(api, v), ...opts }),
    courierEntry: useMutation({ mutationFn: (v: { id: string; key: string }) => gateEndpoints.courierEntry(api, v.id, v.key), ...opts }),
    courierExit: useMutation({ mutationFn: (v: { id: string; key: string }) => gateEndpoints.courierExit(api, v.id, v.key), ...opts }),
    cancelCourier: useMutation({ mutationFn: (v: { id: string; version: number }) => gateEndpoints.cancelCourier(api, v.id, v.version), ...opts }),
    manualEntry: useMutation({ mutationFn: (v: ManualEntryInput) => gateEndpoints.manualEntry(api, v), ...opts }),
  };
}
