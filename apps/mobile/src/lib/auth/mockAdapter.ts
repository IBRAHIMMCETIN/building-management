import { AuthRequiredError } from '@bm/shared/api/errors';
import { AuthFlowError } from '@bm/shared/auth/errors';
import { MOCK_CODE, MOCK_TEMP_PASSWORD_PATTERN, issueMockToken, maskEmail } from '@bm/shared/auth/mockScenarios';
import { type ActiveContext, type AuthAdapter, type AuthSession, type SignInStep, decodeClaims } from '@bm/shared/auth/session';
import type { KeyValueStorage } from '../storage/types';

/*
 * YALNIZCA yerel gelistirme (EXPO_PUBLIC_AUTH_MODE=mock; API de AUTH_MODE=mock). Senaryolar web
 * mock adapter'i ile ortaktir (packages/shared/src/auth/mockScenarios.ts):
 *   resident@dev.local, security_guard@dev.local, building_staff@dev.local, apartment_manager@dev.local,
 *   multi@dev.local (baglam secimi), sifre "Gecici" + 5 rakam (yeni sifre), e-postada "+mfa" (TOTP),
 *   kodlar 123456. Web surumunden (apps/web/src/lib/auth/mockAdapter.ts) farki: saklama asenkron depoda.
 */

const STORAGE_KEY = 'bm.mock-session';
const PASSWORD_SET_KEY = 'bm.mock-password-set';

type Persisted = { email: string; preferred?: ActiveContext };

export type MockAdapterOptions = {
  storage: KeyValueStorage;
  /** Ag gecikmesi hissi (yukleniyor durumlari gorunsun); testlerde 0. */
  delayMs?: number;
};

export function createMockAuthAdapter({ storage, delayMs = 300 }: MockAdapterOptions): AuthAdapter {
  let pending: { email: string; step: 'newPassword' | 'totp' } | null = null;
  const preferences = new Map<string, ActiveContext>();
  const delay = () => new Promise((r) => setTimeout(r, delayMs));

  async function passwordSet(): Promise<Set<string>> {
    try {
      return new Set(JSON.parse((await storage.getItem(PASSWORD_SET_KEY)) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  async function markPasswordSet(email: string) {
    try {
      await storage.setItem(PASSWORD_SET_KEY, JSON.stringify([...(await passwordSet()).add(email)]));
    } catch {
      // yalnizca bu oturum
    }
  }

  async function persist(data: Persisted | null) {
    try {
      if (data) await storage.setItem(STORAGE_KEY, JSON.stringify(data));
      else await storage.removeItem(STORAGE_KEY);
    } catch {
      // yalnizca bellekte
    }
  }

  async function issue(email: string, preferred?: ActiveContext): Promise<AuthSession> {
    const token = issueMockToken(email, preferred);
    const claims = decodeClaims(token);
    if (!claims) throw new Error('Mock token üretilemedi');
    await persist({ email, preferred });
    return { idToken: token, accessToken: token, claims };
  }

  return {
    async restore() {
      try {
        const raw = await storage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw) as Persisted;
        if (data.preferred) preferences.set(data.email, data.preferred);
        return await issue(data.email, data.preferred);
      } catch {
        return null;
      }
    },

    async signIn({ email, password }) {
      await delay();
      // Sifre belirlendikten sonra gecici sifre tekrar "ilk giris" sayilmaz (web ile ayni).
      if (MOCK_TEMP_PASSWORD_PATTERN.test(password) && !(await passwordSet()).has(email)) {
        pending = { email, step: 'newPassword' };
        return { type: 'newPasswordRequired' };
      }
      if (email.includes('+mfa')) {
        pending = { email, step: 'totp' };
        return { type: 'totpRequired' };
      }
      return { type: 'done', session: await issue(email, preferences.get(email)) };
    },

    async confirmNewPassword() {
      await delay();
      if (pending?.step !== 'newPassword') throw new AuthFlowError('SignInException', 'Giriş oturumu zaman aşımına uğradı.');
      const { email } = pending;
      await markPasswordSet(email);
      if (email.includes('+mfa')) {
        pending = { email, step: 'totp' };
        return { type: 'totpRequired' } satisfies SignInStep;
      }
      pending = null;
      return { type: 'done', session: await issue(email) };
    },

    async confirmTotp(code) {
      await delay();
      if (pending?.step !== 'totp') throw new AuthFlowError('SignInException', 'Giriş oturumu zaman aşımına uğradı.');
      if (code !== MOCK_CODE) throw new AuthFlowError('CodeMismatchException', 'Kod hatalı. Lütfen kontrol edip tekrar deneyin.');
      const { email } = pending;
      pending = null;
      return { type: 'done', session: await issue(email) };
    },

    async refresh(current) {
      if (!current.claims.email) throw new AuthRequiredError();
      return issue(current.claims.email, preferences.get(current.claims.email));
    },

    async signOut() {
      await persist(null);
    },

    async requestPasswordReset(email) {
      await delay();
      return { destination: maskEmail(email) };
    },

    async confirmPasswordReset({ code }) {
      await delay();
      if (code !== MOCK_CODE) throw new AuthFlowError('CodeMismatchException', 'Kod hatalı. Lütfen kontrol edip tekrar deneyin.');
    },

    async setActiveContext(current, context) {
      await delay();
      const email = current.claims.email;
      if (!email) throw new AuthRequiredError();
      preferences.set(email, context);
      return issue(email, context);
    },
  };
}
