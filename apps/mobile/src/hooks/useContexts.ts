import type { SelectableContext } from '@bm/shared/auth/contextsSchema';
import type { ActiveContext } from '@bm/shared/auth/session';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthProvider';
import { useServices } from '@/services';

export const contextsQueryKey = (userId: string | undefined) => ['me', 'contexts', userId] as const;

/** Kullanicinin secebilecegi apartman/rol baglamlari (web: hooks/useContexts.ts). */
export function useContexts() {
  const { session } = useAuth();
  const { fetchContexts } = useServices();
  return useQuery({
    queryKey: contextsQueryKey(session?.claims.sub),
    queryFn: ({ signal }) => {
      if (!session) throw new Error('Oturum yok');
      return fetchContexts(session, signal);
    },
    enabled: session !== null,
    staleTime: 5 * 60_000,
  });
}

/** Aktif baglami degistirir (nitelik yaz + token yenile). Yonlendirmeyi kok yerlesim yapar. */
export function useSwitchContext() {
  const { setActiveContext } = useAuth();
  return useMutation({ mutationFn: (context: ActiveContext) => setActiveContext(context) });
}

/** Aktif sakin baglaminin daireleri (birden fazlaysa ust cubukta daire secici). */
export function useActiveResidentContext(): SelectableContext | undefined {
  const { user } = useAuth();
  const { data } = useContexts();
  if (!user?.apartmentId || user.role !== 'resident') return undefined;
  return data?.contexts.find((c) => c.apartmentId === user.apartmentId && c.role === 'resident');
}

/** Aktif apartmanda malik uyeligi var mi (Genel Kurul yalnizca maliklere; web: useIsActiveOwner). */
export function useIsActiveOwner(): boolean {
  return Boolean(useActiveResidentContext()?.units?.some((u) => u.relation === 'owner'));
}

/** Aktif apartman adi (baglam listesi yuklenmemisse undefined). */
export function useActiveApartmentName(): string | undefined {
  const { user } = useAuth();
  const { data } = useContexts();
  if (!user?.apartmentId) return undefined;
  return data?.contexts.find((c) => c.apartmentId === user.apartmentId)?.apartmentName;
}
