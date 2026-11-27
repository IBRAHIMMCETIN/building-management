import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { PORTFOLIO_ROLES, type PortfolioRole, portfolioApartmentCount, portfolioApi } from '@/lib/api/portfolio';
import { useAuth } from './useAuth';
import { useContexts } from './useContexts';

export const portfolioKeys = { all: (userId: string) => ['portfolio', userId] as const };

/** Istek basina apartman (API varsayilani 12, ust siniri 24; Lambda suresine sigmasi icin). */
export const PORTFOLIO_PAGE_SIZE = 12;

const isPortfolioRole = (role: string | undefined): role is PortfolioRole => !!role && (PORTFOLIO_ROLES as readonly string[]).includes(role);

/**
 * Portfoy menusu / ekrani kime acik: aktif rol portfoy rolu, destek oturumu degil ve kullanicinin
 * en az iki apartmaninda portfoy rolu var (baglam secicisiyle ayni liste). Yetkinin asli API'dedir.
 */
export function usePortfolioAccess() {
  const { user, support } = useAuth();
  const contexts = useContexts();
  const apartments = contexts.data && !contexts.data.isPlatformAdmin ? portfolioApartmentCount(contexts.data.contexts) : 0;
  const roleAllowed = isPortfolioRole(user?.role) && !support;
  return { roleAllowed, apartments, showInNav: roleAllowed && apartments >= 2 };
}

export function usePortfolio() {
  const { user } = useAuth();
  const { roleAllowed } = usePortfolioAccess();
  return useInfiniteQuery({
    queryKey: portfolioKeys.all(user?.sub ?? ''),
    queryFn: ({ pageParam, signal }) => portfolioApi.page({ limit: PORTFOLIO_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor,
    enabled: roleAllowed,
    // Pahali istek (apartman basina bircok okuma): sekmeye donunce yeniden yuklenmez; baglam degisiminde
    // de korunur (`clearForContextSwitch`), apartmandan geri donunce sayfalar yeniden istenmez.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export type OpenTarget = { apartmentId: string; role: PortfolioRole; to: string };

/**
 * Karttan apartman ekranina gecis: mevcut baglam secimi (`setActiveContext`: nitelik yaz + token
 * yenile) kullanilir; hedef zaten aktif baglamsa yalnizca sayfa acilir.
 */
export function useOpenApartment() {
  const { user, setActiveContext } = useAuth();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (t: OpenTarget) => {
      if (user?.apartmentId !== t.apartmentId || user?.role !== t.role) await setActiveContext({ apartmentId: t.apartmentId, role: t.role });
      return t;
    },
    onSuccess: (t) => navigate(t.to),
  });
}
