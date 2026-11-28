import { AuthRequiredError } from '@/lib/api/errors';
import { MOCK_CODE, issueMockToken } from '@bm/shared/auth/mockScenarios';
import { AuthFlowError } from './errors';
import { type ActiveContext, type AuthAdapter, type AuthSession, type SignInStep, decodeClaims } from './session';

/*
 * YALNIZCA yerel gelistirme (API: AUTH_MODE=mock). Imza yoktur. Senaryolar (rol e-postalari,
 * multi@dev.local, gecici sifre "Gecici" + 5 rakam, "+mfa", kod 123456) web ve mobilde ortaktir:
 * packages/shared/src/auth/mockScenarios.ts. Burada yalnizca tarayici saklamasi (localStorage).
 */
export { MOCK_CODE, MOCK_TEMP_PASSWORD, mockContextsFor, mockUserId } from '@bm/shared/auth/mockScenarios';

const STORAGE_KEY = 'bm.mock-session';
/** Ilk giriste sifresini belirlemis e-postalar (Cognito'da FORCE_CHANGE_PASSWORD biter). */
const PASSWORD_SET_KEY = 'bm.mock-password-set';

function passwordSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PASSWORD_SET_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markPasswordSet(email: string) {
  try {
    localStorage.setItem(PASSWORD_SET_KEY, JSON.stringify([...passwordSet().add(email)]));
  } catch {
    // depolama yoksa yalnizca bu oturum
  }
}

function issue(email: string, preferred?: ActiveContext): AuthSession {
  const token = issueMockToken(email, preferred);
  const claims = decodeClaims(token);
  if (!claims) throw new Error('Mock token üretilemedi');
  const session = { idToken: token, accessToken: token, claims };
  persist({ email, preferred });
  return session;
}

type Persisted = { email: string; preferred?: ActiveContext };

function persist(data: Persisted | null) {
  try {
    if (data) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Gizli mod: yalnizca bellekte.
  }
}

function readPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

let pending: { email: string; step: 'newPassword' | 'totp' } | null = null;
const preferences = new Map<string, ActiveContext>();

// Ag gecikmesi hissi (yukleniyor durumlari gorunsun); testlerde beklenmez.
const delay = () => new Promise((r) => setTimeout(r, import.meta.env.MODE === 'test' ? 0 : 300));

export const mockAuthAdapter: AuthAdapter = {
  async restore() {
    const data = readPersisted();
    if (!data) return null;
    if (data.preferred) preferences.set(data.email, data.preferred);
    return issue(data.email, data.preferred);
  },

  async signIn({ email, password }) {
    await delay();
    // Gercek Cognito'da sifre belirlendikten sonra gecici sifre gecersizdir; mock'ta tekrar
    // "ilk giris" sayilmamali, aksi halde oturum dustugunde kullanici dongude kalir.
    if (/^Gecici\d{5}$/.test(password) && !passwordSet().has(email)) {
      pending = { email, step: 'newPassword' };
      return { type: 'newPasswordRequired' };
    }
    if (email.includes('+mfa')) {
      pending = { email, step: 'totp' };
      return { type: 'totpRequired' };
    }
    return { type: 'done', session: issue(email, preferences.get(email)) };
  },

  async confirmNewPassword() {
    await delay();
    if (pending?.step !== 'newPassword') throw new AuthFlowError('SignInException', 'Giriş oturumu zaman aşımına uğradı.');
    const { email } = pending;
    markPasswordSet(email);
    if (email.includes('+mfa')) {
      pending = { email, step: 'totp' };
      return { type: 'totpRequired' } satisfies SignInStep;
    }
    pending = null;
    return { type: 'done', session: issue(email) };
  },

  async confirmTotp(code) {
    await delay();
    if (pending?.step !== 'totp') throw new AuthFlowError('SignInException', 'Giriş oturumu zaman aşımına uğradı.');
    if (code !== MOCK_CODE) throw new AuthFlowError('CodeMismatchException', 'Kod hatalı. Lütfen kontrol edip tekrar deneyin.');
    const { email } = pending;
    pending = null;
    return { type: 'done', session: issue(email) };
  },

  async refresh(current) {
    if (!current.claims.email) throw new AuthRequiredError();
    return issue(current.claims.email, preferences.get(current.claims.email));
  },

  async signOut() {
    persist(null);
  },

  async requestPasswordReset(email) {
    await delay();
    const [local = '', domain = ''] = email.split('@');
    return { destination: `${local.slice(0, 1)}***@${domain}` };
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
