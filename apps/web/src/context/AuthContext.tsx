import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { FullPageSpinner } from '@/components/ui';
import { authAdapter } from '@/lib/auth';
import { needsMfaSetup } from '@/lib/auth/mfa';
import type { ActiveContext, AuthSession, SessionClaims, SignInStep } from '@/lib/auth/session';
import { type SupportMode, sessionManager } from '@/lib/auth/sessionManager';

export type AuthContextValue = {
  session: AuthSession | null;
  /**
   * Arayuzun esas aldigi kullanici. Destek modunda platform yoneticisi, oturumun apartmaninda
   * DENETCI (`observer`) olarak gorunur; API de istegi ayni sekilde (salt okunur) ele alir.
   */
  user: SessionClaims | null;
  /** Platform yoneticisinin aktif destek oturumu (yoksa undefined). */
  support?: SupportMode;
  /** Destek oturumu acildiktan sonra modu baslatir (onbellek temizlenir). */
  startSupport: (mode: Omit<SupportMode, 'sub'>) => void;
  /** Destek modundan cikar (API'de oturumu bitirme cagrisi ayrica yapilir). */
  leaveSupport: () => void;
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

/**
 * Apartman / rol degisiminde onbellek: apartmana bagli her sey ve bekleyen mutasyonlar silinir; yalnizca
 * ayni kullanicinin portfoyu (`['portfolio', sub]`, apartmandan bagimsiz, sunucu her istekte yetkiyi
 * yeniden dogrular) kalir. Boylece portfoyden bir apartmana gecip geri donmek tum sayfalari yeniden yuklemez.
 */
export function clearForContextSwitch(queryClient: QueryClient, sub: string | undefined): void {
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ predicate: (q) => !(sub && q.queryKey[0] === 'portfolio' && q.queryKey[1] === sub) });
}

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
    const support = state.support;
    const claims = session?.claims ?? null;
    const user: SessionClaims | null =
      claims && support ? { ...claims, role: 'observer', apartmentId: support.apartmentId, organizationId: undefined } : claims;
    return {
      session,
      user,
      ...(support ? { support } : {}),
      startSupport: (mode) => {
        sessionManager.startSupport(mode);
        queryClient.clear();
      },
      leaveSupport: () => {
        sessionManager.endSupport('ended');
        queryClient.clear();
      },
      isAuthenticated: session !== null,
      needsContext: session !== null && !user?.role,
      mfaSetupRequired: needsMfaSetup(session?.claims, state.mfaRequired),
      refreshSession: () => sessionManager.refresh(),
      signIn: (input) => sessionManager.signIn(input).then(resetCache),
      confirmNewPassword: (pw) => sessionManager.confirmNewPassword(pw).then(resetCache),
      confirmTotp: (code) => sessionManager.confirmTotp(code).then(resetCache),
      signOut: () => sessionManager.signOut().then(() => queryClient.clear()),
      requestPasswordReset: (email) => authAdapter.requestPasswordReset(email),
      confirmPasswordReset: (input) => authAdapter.confirmPasswordReset(input),
      // Basarisiz secimde de temizlenir: oturum yeni (dogrulanamayan) token'la degismis olabilir, onceki
      // apartmanin verisi kalmasin. Kullaniciya ozel portfoy onbellegi korunur (apartmandan bagimsiz).
      setActiveContext: (ctx) => {
        const sub = session?.claims.sub;
        return sessionManager.setActiveContext(ctx).then(
          (next) => {
            clearForContextSwitch(queryClient, sub);
            return next;
          },
          (err: unknown) => {
            clearForContextSwitch(queryClient, sub);
            throw err;
          },
        );
      },
    };
  }, [session, state.mfaRequired, state.support, queryClient]);

  // Destek modu sunucu tarafinda (401) veya sure dolumuyla kapanirsa apartman verisi onbellekte kalmasin.
  useEffect(() => {
    if (!state.support) queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'platform' });
  }, [state.support, queryClient]);

  // Saklanan oturum geri yuklenmeden guard'lar calismasin (yanlis /login yonlendirmesi olur).
  if (state.status === 'initializing') return <FullPageSpinner />;

  return <AuthContext value={value}>{children}</AuthContext>;
}
