import { type Role, isRole } from '../roles';

/** API'ye gonderilecek token turu (web: VITE_COGNITO_TOKEN_USE, mobil: EXPO_PUBLIC_COGNITO_TOKEN_USE). */
export type TokenUse = 'id' | 'access';

/**
 * ID token claim'leri. `role`/`apartmentId`, Pre Token Generation Lambda'sinin aktif
 * baglam icin ekledigi claim'lerdir. Birden fazla apartmani olup henuz secim yapmamis
 * kullanicida `role` YOKTUR: arayuz bu durumda baglam secim ekranina yonlendirir.
 */
export type SessionClaims = {
  sub: string;
  email?: string;
  role?: Role;
  apartmentId?: string;
  organizationId?: string;
  /**
   * Zorunlu MFA (G2) durumu: Pre Token Lambda yalnizca kapsamdaki rollerde
   * (`platform_admin`, `management_company`, `apartment_manager`, `observer`) ve mod `off`
   * degilken ekler. Yoksa MFA bu oturum icin konu degildir.
   */
  mfa?: SessionMfa;
  /** Saniye cinsinden (JWT `exp`). */
  exp: number;
};

export type SessionMfa = {
  enabled: boolean;
  /** Kurulum yapilmadan yonetim ekranlari acilmaz (API 403 MFA_REQUIRED). */
  required: boolean;
  /** `warn` modunda kullanici bazli gecis suresinin bitisi (ISO). */
  graceUntil?: string;
};

export type AuthSession = {
  idToken: string;
  accessToken: string;
  claims: SessionClaims;
};

export type ActiveContext = { apartmentId: string; role: Exclude<Role, 'platform_admin'> };

/** Cok adimli giris: Cognito challenge'lari arayuze bu adimlarla yansir. */
export type SignInStep =
  | { type: 'done'; session: AuthSession }
  /** Gecici sifreyle ilk giris (seed:admin / davet): yeni sifre belirlenmeli. */
  | { type: 'newPasswordRequired' }
  /** TOTP (authenticator uygulamasi) MFA kodu. */
  | { type: 'totpRequired' }
  /** Yonetici sifreyi sifirlamis: kodla yeni sifre belirlenmeli. */
  | { type: 'resetPasswordRequired' };

/**
 * Kimlik saglayici soyutlamasi. Cognito (Amplify, SRP) ve yerel mock ayni arayuzu
 * uygular; AuthContext, sessionManager ve apiClient hangisinin bagli oldugunu bilmez.
 */
export interface AuthAdapter {
  /** Sayfa yuklenince saklanan oturumu geri yukler (gerekirse yeniler). */
  restore(): Promise<AuthSession | null>;
  signIn(input: { email: string; password: string }): Promise<SignInStep>;
  confirmNewPassword(newPassword: string): Promise<SignInStep>;
  confirmTotp(code: string): Promise<SignInStep>;
  /** Yeni ID/access token alir. Basarisizsa AuthRequiredError firlatir. */
  refresh(current: AuthSession): Promise<AuthSession>;
  signOut(current: AuthSession | null): Promise<void>;
  /** Sifirlama kodunu gonderir; maskelenmis teslim adresini dondurur. */
  requestPasswordReset(email: string): Promise<{ destination?: string }>;
  confirmPasswordReset(input: { email: string; code: string; newPassword: string }): Promise<void>;
  /**
   * `custom:active_apartment` / `custom:active_role` tercihini yazar ve token'i yeniler.
   * Pre Token Lambda tercihi yetkilere karsi DOGRULAR; donen oturumun claim'leri esas alinir.
   */
  setActiveContext(current: AuthSession, context: ActiveContext): Promise<AuthSession>;
}

/**
 * API'ye gonderilecek token. Terraform `VITE_COGNITO_TOKEN_USE`:
 *  - 'id'     (LITE / Pre Token V1): claim'ler yalnizca ID token'da -> ID token gonderilir.
 *  - 'access' (ESSENTIALS / V2): access token.
 */
export function apiTokenFor(session: AuthSession, tokenUse: TokenUse): string {
  return tokenUse === 'id' ? session.idToken : session.accessToken;
}

/** Token suresi `skewSeconds` icinde doluyorsa true (saat kaymasina karsi pay). */
export function isExpiring(session: AuthSession, skewSeconds = 60): boolean {
  return session.claims.exp * 1000 - Date.now() <= skewSeconds * 1000;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const nonEmpty = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** Cognito claim'leri metindir ("true"); mock token'da boolean olabilir. */
const flag = (v: unknown) => v === true || v === 'true';

function decodeMfa(raw: Record<string, unknown>): SessionMfa | undefined {
  if (raw.mfa_enabled === undefined && raw.mfa_required === undefined && raw.mfa_grace_until === undefined) return undefined;
  const graceUntil = nonEmpty(raw.mfa_grace_until);
  return { enabled: flag(raw.mfa_enabled), required: flag(raw.mfa_required), ...(graceUntil ? { graceUntil } : {}) };
}

/**
 * Token payload'ini IMZA DOGRULAMADAN okur. Yalnizca arayuzu sekillendirmek icindir;
 * yetki karari her zaman API'de (JWT authorizer + claim kontrolu) verilir.
 * Desteklenen bicimler: standart JWT ve yerel `mock.<base64url(JSON)>`.
 */
export function decodeClaims(token: string): SessionClaims | null {
  try {
    const payload = token.startsWith('mock.') ? token.slice(5) : token.split('.')[1];
    if (!payload) return null;
    const raw = JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
    if (typeof raw.sub !== 'string' || typeof raw.exp !== 'number') return null;

    // Gecersiz/bilinmeyen rol degeri rol yokmus gibi ele alinir (API de 401 doner).
    const role = isRole(raw.role) ? raw.role : undefined;
    const mfa = role ? decodeMfa(raw) : undefined;
    return {
      sub: raw.sub,
      email: nonEmpty(raw.email),
      role,
      apartmentId: role ? nonEmpty(raw.apartmentId) : undefined,
      organizationId: role ? nonEmpty(raw.organizationId) : undefined,
      ...(mfa ? { mfa } : {}),
      exp: raw.exp,
    };
  } catch {
    return null;
  }
}
