import { AuthRequiredError } from '@/lib/api/errors';
import { type Role, isRole } from '@/types/roles';
import type { MeContexts, SelectableContext } from './contextsSchema';
import { AuthFlowError } from './errors';
import { type ActiveContext, type AuthAdapter, type AuthSession, type SignInStep, decodeClaims } from './session';

/*
 * YALNIZCA yerel gelistirme (API: AUTH_MODE=mock). Imza yoktur. Gercek Cognito
 * akislarini arayuzde denemek icin senaryolar:
 *   <rol>@dev.local          -> o rolde tek baglam (ornek: resident@dev.local)
 *   diger e-postalar         -> daire sakini (davet edilen kisi ayni e-postayla girer)
 *   multi@dev.local          -> 2 apartman / 3 rol, giriste baglam secimi istenir
 *   platform_admin@dev.local -> apartmansiz platform rolu
 *   sifre "Gecici" + 5 rakam -> ilk giris yeni sifre (NEW_PASSWORD_REQUIRED); mock davetin
 *                              urettigi gecici sifre de bu bicimdedir (ornek: Gecici12345)
 *   e-postada "+mfa"         -> TOTP adimi (kod: 123456)
 *   sifirlama kodu           -> 123456
 */

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
const TTL_SECONDS = 60 * 60;
export const MOCK_CODE = '123456';
export const MOCK_TEMP_PASSWORD = 'Gecici12345';

const DEV_APT = { apartmentId: 'apt-dev-1', apartmentName: 'Geliştirme Sitesi' };
const DEV_APT_2 = { apartmentId: 'apt-dev-2', apartmentName: 'Çınar Apartmanı' };

const baseEmail = (email: string) => email.replace(/\+[^@]*/, '');

/** API'deki mockUserId ile ayni kural (apps/api/src/modules/residents/directory.ts). */
export function mockUserId(email: string): string {
  const local = baseEmail(email).split('@')[0] ?? '';
  return `mock-${local.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 59) || 'user'}`;
}

export function mockContextsFor(email: string): Pick<MeContexts, 'isPlatformAdmin' | 'contexts'> {
  const local = baseEmail(email).split('@')[0] ?? '';
  if (local === 'platform_admin') return { isPlatformAdmin: true, contexts: [] };
  if (local === 'multi') {
    return {
      isPlatformAdmin: false,
      contexts: [
        { ...DEV_APT_2, role: 'resident', units: [{ unitId: 'u-12', unitNumber: '12', relation: 'tenant' }] },
        { ...DEV_APT, role: 'apartment_manager' },
        { ...DEV_APT, role: 'resident', units: [{ unitId: 'u-3', unitNumber: '3', relation: 'owner' }] },
      ],
    };
  }
  // Rol adi olmayan e-posta: davet edilmis sakin gibi davranir.
  const role: Exclude<Role, 'platform_admin'> = isRole(local) && local !== 'platform_admin' ? local : 'resident';
  return { isPlatformAdmin: false, contexts: [{ ...DEV_APT, role }] };
}

function encode(claims: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  const base64 = btoa(String.fromCharCode(...bytes));
  return 'mock.' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pre Token Lambda'nin secim kurallarinin sadelestirilmis taklidi. */
function selectContext(email: string, preferred?: ActiveContext): SelectableContext | undefined {
  const { contexts } = mockContextsFor(email);
  if (preferred) {
    return contexts.find((c) => c.apartmentId === preferred.apartmentId && c.role === preferred.role);
  }
  const apartments = new Set(contexts.map((c) => c.apartmentId));
  return apartments.size === 1 ? contexts[0] : undefined;
}

function issue(email: string, preferred?: ActiveContext): AuthSession {
  const { isPlatformAdmin } = mockContextsFor(email);
  const selected = isPlatformAdmin ? undefined : selectContext(email, preferred);
  const token = encode({
    sub: mockUserId(email),
    email,
    ...(isPlatformAdmin ? { role: 'platform_admin' } : {}),
    ...(selected ? { role: selected.role, apartmentId: selected.apartmentId } : {}),
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  });
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
