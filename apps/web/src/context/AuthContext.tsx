import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useMemo, useSyncExternalStore } from 'react';
import { FullPageSpinner } from '@/components/ui';
import { authAdapter } from '@/lib/auth';
import { needsMfaSetup } from '@/lib/auth/mfa';
import type { ActiveContext, AuthSession, SessionClaims, SignInStep } from '@/lib/auth/session';
import { sessionManager } from '@/lib/auth/sessionManager';

export type AuthContextValue = {
  session: AuthSession | null;
  user: SessionClaims | null;
  isAuthenticated: boolean;
  /** Oturum var ama aktif apartman/rol secilmemis (token'da rol claim'i yok). */
  needsContext: boolean;
  /** Rol zorunlu MFA kapsaminda ve TOTP kurulmamis: yalnizca kurulum ekrani acilir. */
  mfaSetupRequired: boolean;
  /** Token'i yeniler (MFA kurulumundan sonra `mfa_enabled` claim'i icin). */
  refreshSession: () => Promise<AuthSession>;
  signIn: (input: { email: string; password: string }) => Promise<SignInStep>;
  confirmNewPassword: (newPassword: string) => Promise<SignInStep>;
  confirmTotp: (code: string) => Promise<SignInStep>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ destination?: string }>;
  confirmPasswordReset: (input: { email: string; code: string; newPassword: string }) => Promise<void>;
  setActiveContext: (context: ActiveContext) => Promise<AuthSession>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(sessionManager.subscribe, sessionManager.getState);
  const session = state.session;

  const value = useMemo<AuthContextValue>(() => {
    // Kullanici/baglam degisince onceki tenant'in onbellegi yeni oturuma sizmasin.
    const resetCache = <T,>(step: T) => {
      queryClient.clear();
      return step;
    };
    return {
      session,
      user: session?.claims ?? null,
      isAuthenticated: session !== null,
      needsContext: session !== null && !session.claims.role,
      mfaSetupRequired: needsMfaSetup(session?.claims, state.mfaRequired),
      refreshSession: () => sessionManager.refresh(),
      signIn: (input) => sessionManager.signIn(input).then(resetCache),
      confirmNewPassword: (pw) => sessionManager.confirmNewPassword(pw).then(resetCache),
      confirmTotp: (code) => sessionManager.confirmTotp(code).then(resetCache),
      signOut: () => sessionManager.signOut().then(() => queryClient.clear()),
      requestPasswordReset: (email) => authAdapter.requestPasswordReset(email),
      confirmPasswordReset: (input) => authAdapter.confirmPasswordReset(input),
      setActiveContext: (ctx) => sessionManager.setActiveContext(ctx).then(resetCache),
    };
  }, [session, state.mfaRequired, queryClient]);

  // Saklanan oturum geri yuklenmeden guard'lar calismasin (yanlis /login yonlendirmesi olur).
  if (state.status === 'initializing') return <FullPageSpinner />;

  return <AuthContext value={value}>{children}</AuthContext>;
}
