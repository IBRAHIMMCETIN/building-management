import { type Role, isRole } from '../roles';
import type { MeContexts, SelectableContext } from './contextsSchema';
import type { ActiveContext } from './session';

/*
 * YALNIZCA yerel gelistirme (API: AUTH_MODE=mock). Imza yoktur. Gercek Cognito
 * akislarini arayuzde denemek icin senaryolar (web ve mobil mock adapter'lari ayni kurallar):
 *   <rol>@dev.local          -> o rolde tek baglam (ornek: resident@dev.local)
 *   diger e-postalar         -> daire sakini (davet edilen kisi ayni e-postayla girer)
 *   multi@dev.local          -> 2 apartman / 3 rol, giriste baglam secimi istenir
 *   platform_admin@dev.local -> apartmansiz platform rolu
 *   sifre "Gecici" + 5 rakam -> ilk giris yeni sifre (NEW_PASSWORD_REQUIRED); mock davetin
 *                              urettigi gecici sifre de bu bicimdedir (ornek: Gecici12345)
 *   e-postada "+mfa"         -> TOTP adimi (kod: 123456)
 *   sifirlama kodu           -> 123456
 * Oturum saklama (localStorage / guvenli depo) adapter'lardadir:
 * apps/web/src/lib/auth/mockAdapter.ts, apps/mobile/src/lib/auth/mockAdapter.ts.
 */

export const TTL_SECONDS = 60 * 60;
export const MOCK_CODE = '123456';
export const MOCK_TEMP_PASSWORD = 'Gecici12345';
/** Gecici sifre bicimi (ilk giriste yeni sifre istenir). */
export const MOCK_TEMP_PASSWORD_PATTERN = /^Gecici\d{5}$/;

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

export function encodeMockToken(claims: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  const base64 = btoa(String.fromCharCode(...bytes));
  return 'mock.' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pre Token Lambda'nin secim kurallarinin sadelestirilmis taklidi. */
export function selectMockContext(email: string, preferred?: ActiveContext): SelectableContext | undefined {
  const { contexts } = mockContextsFor(email);
  if (preferred) {
    return contexts.find((c) => c.apartmentId === preferred.apartmentId && c.role === preferred.role);
  }
  const apartments = new Set(contexts.map((c) => c.apartmentId));
  return apartments.size === 1 ? contexts[0] : undefined;
}

/** Mock token'i (imzasiz) uretir: rol/apartman claim'leri senaryodan ve tercihten gelir. */
export function issueMockToken(email: string, preferred?: ActiveContext): string {
  const { isPlatformAdmin } = mockContextsFor(email);
  const selected = isPlatformAdmin ? undefined : selectMockContext(email, preferred);
  return encodeMockToken({
    sub: mockUserId(email),
    email,
    ...(isPlatformAdmin ? { role: 'platform_admin' } : {}),
    ...(selected ? { role: selected.role, apartmentId: selected.apartmentId } : {}),
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  });
}

/** Sifirlama kodunun gonderildigi maskeli adres ("r***@dev.local"). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
