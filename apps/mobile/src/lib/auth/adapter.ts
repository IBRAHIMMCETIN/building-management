import type { AuthAdapter } from '@bm/shared/auth/session';
import type { AppEnv } from '@/config/env';
import { secureStorage } from '../storage/secureStorage';
import { createMockAuthAdapter } from './mockAdapter';

/**
 * Kimlik saglayici secimi. Cognito adapter'i TEMBEL yuklenir: mock modda (Expo Go dahil)
 * Amplify ve @aws-amplify/react-native native modulu hic calistirilmaz.
 */
export function createAuthAdapter(env: Pick<AppEnv, 'authMode' | 'cognito'>): AuthAdapter {
  if (env.authMode === 'mock') return createMockAuthAdapter({ storage: secureStorage });

  let loading: Promise<AuthAdapter> | null = null;
  const load = () => (loading ??= import('./cognitoAdapter').then((m) => m.createCognitoAuthAdapter(env.cognito)));
  return {
    restore: () => load().then((a) => a.restore()),
    signIn: (input) => load().then((a) => a.signIn(input)),
    confirmNewPassword: (pw) => load().then((a) => a.confirmNewPassword(pw)),
    confirmTotp: (code) => load().then((a) => a.confirmTotp(code)),
    refresh: (current) => load().then((a) => a.refresh(current)),
    signOut: (current) => load().then((a) => a.signOut(current)),
    requestPasswordReset: (email) => load().then((a) => a.requestPasswordReset(email)),
    confirmPasswordReset: (input) => load().then((a) => a.confirmPasswordReset(input)),
    setActiveContext: (current, ctx) => load().then((a) => a.setActiveContext(current, ctx)),
  };
}
