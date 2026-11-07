import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { fetchContexts } from '@/lib/auth/contexts';
import type { ActiveContext } from '@/lib/auth/session';
import { homePathForRole } from '@/types/roles';
import { useAuth } from './useAuth';

export const contextsQueryKey = (userId: string | undefined) => ['me', 'contexts', userId] as const;

/** Kullanicinin secebilecegi apartman/rol baglamlari. */
export function useContexts() {
  const { session } = useAuth();
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

/** Aktif baglami degistirir (nitelik yaz + token yenile) ve rolun paneline gider. */
export function useSwitchContext() {
  const { setActiveContext } = useAuth();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (context: ActiveContext) => setActiveContext(context),
    onSuccess: (session) => {
      if (session.claims.role) navigate(homePathForRole(session.claims.role), { replace: true });
    },
  });
}
