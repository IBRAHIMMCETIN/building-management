import { useAuth } from './useAuth';
import { useContexts } from './useContexts';

/**
 * Aktif apartmanda malik uyeligi var mi (sakin menusundeki maliklere ozel ogeler icin)? Baglam
 * listesi yuklenmeden `false`: oge yuklenince gorunur. Yetkinin asil kaynagi API'dir.
 */
export function useIsActiveOwner(): boolean {
  const { user } = useAuth();
  const { data } = useContexts();
  if (!user?.apartmentId || user.role !== 'resident') return false;
  const ctx = data?.contexts.find((c) => c.apartmentId === user.apartmentId && c.role === 'resident');
  return Boolean(ctx?.units?.some((u) => u.relation === 'owner'));
}

/** Ust barda gosterilecek aktif apartman adi (yuklenmemisse kimlik). */
export function useActiveApartmentName(): string | undefined {
  const { user } = useAuth();
  const { data } = useContexts();
  if (!user?.apartmentId) return undefined;
  return data?.contexts.find((c) => c.apartmentId === user.apartmentId)?.apartmentName;
}
