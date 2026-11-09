import { useAuth } from './useAuth';
import { useContexts } from './useContexts';

/** Ust barda gosterilecek aktif apartman adi (yuklenmemisse kimlik). */
export function useActiveApartmentName(): string | undefined {
  const { user } = useAuth();
  const { data } = useContexts();
  if (!user?.apartmentId) return undefined;
  return data?.contexts.find((c) => c.apartmentId === user.apartmentId)?.apartmentName;
}
