import { useQuery } from '@tanstack/react-query';
import { assembliesApi } from '@/lib/api/assemblies';
import { useContexts, useIsActiveOwner } from './useContexts';
import { portalKeys, retry, useScope } from './usePortal';

/*
 * Sakin genel kurul (web: hooks/useAssemblies.ts -> useMyAssemblies / useMyAssembly). Yalnizca kat
 * malikine acik: baglam listesi malik olmadigini kesinlestirirse istek hic gonderilmez (API de 403 doner).
 */
export const portalAssemblyKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'assemblies'] as const,
  list: (apt: string, user: string) => [...portalAssemblyKeys.all(apt, user), 'list'] as const,
  detail: (apt: string, user: string, id: string) => [...portalAssemblyKeys.all(apt, user), 'detail', id] as const,
};

/**
 * Malik kapisi: baglam listesi yuklenene kadar beklenir (`waiting`); aktif baglamda malik uyeligi
 * yoksa (kiraci) `notOwner` ve Genel Kurul ekranlari "kat maliklerine açıktır" der. Liste
 * alinamazsa karar API'ye kalir (403 ayni bilgiyi gosterir).
 */
export function useOwnerGate() {
  const contexts = useContexts();
  const isOwner = useIsActiveOwner();
  // Uyelik yeni eklendiyse asagi cekince baglam listesi yenilenir (malik olunca ekran acilir).
  return { notOwner: contexts.isSuccess && !isOwner, waiting: contexts.isPending, refetch: contexts.refetch };
}

export function useMyAssemblies() {
  const { api, apt, userId, enabled } = useScope();
  const gate = useOwnerGate();
  return useQuery({
    queryKey: portalAssemblyKeys.list(apt, userId),
    queryFn: ({ signal }) => assembliesApi.list(api, signal).then((r) => r.items),
    enabled: enabled && !gate.waiting && !gate.notOwner,
    retry,
  });
}

export function useMyAssembly(id: string) {
  const { api, apt, userId, enabled } = useScope();
  const gate = useOwnerGate();
  return useQuery({
    queryKey: portalAssemblyKeys.detail(apt, userId, id),
    queryFn: ({ signal }) => assembliesApi.get(api, id, signal),
    enabled: enabled && !!id && !gate.waiting && !gate.notOwner,
    retry,
  });
}
