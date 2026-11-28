import type { ActiveContext, AuthSession, SessionClaims, SignInStep } from '@bm/shared/auth/session';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, use, useMemo, useSyncExternalStore } from 'react';
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

/** Apartman / rol degisiminde onceki apartmanin onbellegi ve bekleyen mutasyonlar silinir (web ile ayni). */
export function clearForContextSwitch(queryClient: QueryClient): void {
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

  const value = useMemo<AuthContextValue>(() => {
    // Kullanici/baglam degisince onceki kiracinin onbellegi yeni oturuma sizmasin.
    const resetCache = <T,>(step: T) => {
      queryClient.clear();
      return step;
    };
    const user = session?.claims ?? null;
    return {
      session,
      user,
      isAuthenticated: session !== null,
      needsContext: session !== null && !user?.role,
      signIn: (input) => manager.signIn(input).then(resetCache),
      confirmNewPassword: (pw) => manager.confirmNewPassword(pw).then(resetCache),
      confirmTotp: (code) => manager.confirmTotp(code).then(resetCache),
      signOut: () => manager.signOut().then(() => queryClient.clear()),
      requestPasswordReset: (email) => manager.requestPasswordReset(email),
      confirmPasswordReset: (input) => manager.confirmPasswordReset(input),
      setActiveContext: (ctx) =>
        manager.setActiveContext(ctx).then(
          (next) => {
            clearForContextSwitch(queryClient);
            return next;
          },
          (err: unknown) => {
            clearForContextSwitch(queryClient);
            throw err;
          },
        ),
      consumeExpiredNotice: () => manager.consumeExpiredNotice(),
    };
  }, [session, manager, queryClient]);

  if (state.status === 'initializing') return <>{fallback}</>;
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth, AuthProvider icinde kullanilmalidir');
  return ctx;
}
