import type { ActiveContext, AuthSession, SessionClaims, SignInStep } from '@bm/shared/auth/session';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, use, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useServices } from '@/services';

export type AuthContextValue = {
  session: AuthSession | null;
  user: SessionClaims | null;
  isAuthenticated: boolean;
  /** Oturum var ama aktif apartman/rol secilmemis (token'da rol claim'i yok). */
  needsContext: boolean;
  signIn: (input: { email: string; password: string }) => Promise<SignInStep>;
  confirmNewPassword: (newPassword: string) => Promise<SignInStep>;
  confirmTotp: (code: string) => Promise<SignInStep>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ destination?: string }>;
  confirmPasswordReset: (input: { email: string; code: string; newPassword: string }) => Promise<void>;
  setActiveContext: (context: ActiveContext) => Promise<AuthSession>;
  /** Oturum sunucuda dustuyse (401) giris ekraninda bir kez gosterilir. */
  consumeExpiredNotice: () => 'unauthorized' | null;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Onceki kapsamin (kullanici / apartman / rol) onbellegi: suren istekler iptal, bekleyen mutasyonlar ve
 * tum sorgular silinir. Oturum degismeden ONCE cagrilir (SessionManager.onScopeChange): yeni oturumla
 * acilan ekranlar bos onbellekle baslar, eski kiracinin verisi gorunmez. Sorgu anahtarlari kapsami
 * icerdigi icin acik kalan bilesenler de yeniden cizildiginde yeni sorguya baglanir.
 */
export function clearSessionCache(queryClient: QueryClient): void {
  void queryClient.cancelQueries();
  queryClient.getMutationCache().clear();
  queryClient.removeQueries();
}

/**
 * Oturum durumu (web: apps/web/src/context/AuthContext.tsx). Saklanan oturum geri yuklenene kadar
 * `fallback` gosterilir; yonlendirme kararlari kok yerlesimdeki korumali ekranlardadir.
 */
export function AuthProvider({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { session: manager } = useServices();
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);
  const session = state.session;

  // Giris, cikis, baglam degisimi ve 401 ile dusme: onbellek oturum degismeden once temizlenir.
  useEffect(() => manager.onScopeChange(() => clearSessionCache(queryClient)), [manager, queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const user = session?.claims ?? null;
    return {
      session,
      user,
      isAuthenticated: session !== null,
      needsContext: session !== null && !user?.role,
      signIn: (input) => manager.signIn(input),
      confirmNewPassword: (pw) => manager.confirmNewPassword(pw),
      confirmTotp: (code) => manager.confirmTotp(code),
      signOut: () => manager.signOut(),
      requestPasswordReset: (email) => manager.requestPasswordReset(email),
      confirmPasswordReset: (input) => manager.confirmPasswordReset(input),
      setActiveContext: (ctx) => manager.setActiveContext(ctx),
      consumeExpiredNotice: () => manager.consumeExpiredNotice(),
    };
  }, [session, manager]);

  if (state.status === 'initializing') return <>{fallback}</>;
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth, AuthProvider icinde kullanilmalidir');
  return ctx;
}
