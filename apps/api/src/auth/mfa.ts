import type { Authenticator, Role } from './claims.js';

/**
 * Zorunlu MFA (Guvenlik G2) politikasi. Pre Token Generation Lambda'si ve API ara katmani
 * AYNI saf fonksiyonu (`evaluateMfa`) kullanir; boylece token'daki durum ile API'nin karari
 * birbirinden kopmaz.
 *
 * Modlar (`MFA_ENFORCEMENT_MODE`):
 *  - `off`     : zorunluluk yok (yerel gelistirme varsayilani).
 *  - `warn`    : kapsamdaki rol TOTP kurmamissa kullanici bazli gecis suresi baslar
 *                (`MFA_GRACE_PERIOD_DAYS`, varsayilan 7). Sure icinde uyarilir, sure dolunca
 *                `enforce` gibi davranilir.
 *  - `enforce` : kapsamdaki rol TOTP kurmadan yalnizca MFA kurulum uclarini kullanabilir.
 *
 * Kapsam: `platform_admin`, `management_company`, `apartment_manager`, `observer`.
 * `resident`, `building_staff`, `security_guard` icin MFA istege baglidir.
 */

export const MFA_ROLES = ['platform_admin', 'management_company', 'apartment_manager', 'observer'] as const satisfies readonly Role[];
export const MFA_MODES = ['off', 'warn', 'enforce'] as const;
export type MfaMode = (typeof MFA_MODES)[number];

export type MfaPolicy = { mode: MfaMode; graceDays: number };

export const DEFAULT_GRACE_DAYS = 7;
const MAX_GRACE_DAYS = 90;

/** JWT claim adlari (Pre Token Lambda ekler, istemci gonderse bile bastirilir). */
export const MFA_CLAIMS = {
  enabled: 'mfa_enabled',
  required: 'mfa_required',
  graceUntil: 'mfa_grace_until',
} as const;

/** API'nin standart hata kodu (`403 { error: 'MFA_REQUIRED' }`). */
export const MFA_REQUIRED_CODE = 'MFA_REQUIRED';
/** `warn` donemindeki yanitlarda: `grace; until=<ISO>` */
export const MFA_WARNING_HEADER = 'x-mfa-warning';

export function isMfaRole(role: string | undefined): boolean {
  return !!role && (MFA_ROLES as readonly string[]).includes(role);
}

/**
 * Ortamdan politika. Tanimsiz mod `off` (yerel/test); gecersiz deger sessizce gecmez,
 * baslangicta hata verir (yanlis yazilmis `enforce` korumasiz calismasin).
 */
export function loadMfaPolicy(env: NodeJS.ProcessEnv = process.env): MfaPolicy {
  const rawMode = env.MFA_ENFORCEMENT_MODE?.trim() || 'off';
  if (!(MFA_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(`MFA_ENFORCEMENT_MODE gecersiz: "${rawMode}" (off | warn | enforce)`);
  }
  const rawDays = env.MFA_GRACE_PERIOD_DAYS?.trim();
  const graceDays = rawDays ? Number(rawDays) : DEFAULT_GRACE_DAYS;
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > MAX_GRACE_DAYS) {
    throw new Error(`MFA_GRACE_PERIOD_DAYS gecersiz: "${rawDays}" (0-${MAX_GRACE_DAYS} arasi tam sayi)`);
  }
  return { mode: rawMode as MfaMode, graceDays };
}

export type MfaStatus = 'not_required' | 'enabled' | 'grace' | 'required';

export type MfaInput = {
  role?: string;
  mfaEnabled: boolean;
  /** Kullanici bazli gecis suresinin bitisi (ISO). */
  graceUntil?: string;
  /** Token'da Pre Token Lambda'nin verdigi zorunluluk karari. */
  mfaRequired?: boolean;
};

export type MfaDecision = { status: MfaStatus; graceUntil?: string };

export function evaluateMfa(input: MfaInput, policy: MfaPolicy, now: Date): MfaDecision {
  if (input.mfaEnabled) return { status: 'enabled' };
  if (!isMfaRole(input.role) || policy.mode === 'off') return { status: 'not_required' };
  if (policy.mode === 'enforce' || input.mfaRequired) return { status: 'required' };
  // warn: kullanici bazli sure. Token'da sure yoksa (ornegin mock token) uyari yeterli.
  if (!input.graceUntil) return { status: 'grace' };
  const until = Date.parse(input.graceUntil);
  if (Number.isNaN(until) || now.getTime() > until) return { status: 'required', graceUntil: input.graceUntil };
  return { status: 'grace', graceUntil: input.graceUntil };
}

/** Gecis suresinin bitisi: baslangic + gun. */
export function graceUntilFrom(startedAt: string, graceDays: number): string {
  return new Date(Date.parse(startedAt) + graceDays * 86_400_000).toISOString();
}

/** MFA zorunlu ama kurulmamis: yalnizca kurulum uclari kullanilabilir. */
export class MfaRequiredError extends Error {
  readonly graceUntil?: string;

  constructor(graceUntil?: string) {
    super('Bu rol için iki adımlı doğrulama (TOTP) zorunludur. Lütfen önce doğrulayıcı uygulamanızı kurun.');
    this.name = 'MfaRequiredError';
    this.graceUntil = graceUntil;
  }
}

/**
 * Merkezi MFA ara katmani: rol gerektiren TUM uclarin kimlik dogrulayicisini sarar
 * (`app.ts`). Karar token claim'leri + API'nin kendi politikasiyla verilir:
 *  - `required` -> `MfaRequiredError` (handleError: `403 { error: 'MFA_REQUIRED' }`).
 *  - `grace`    -> yanita `X-MFA-Warning: grace; until=<ISO>` basligi.
 * Rol gerektirmeyen `/api/me/*` (baglam secimi, MFA kurulumu) bu katmandan gecmez.
 */
export function withMfaPolicy(authenticate: Authenticator, policy: MfaPolicy, now: () => Date = () => new Date()): Authenticator {
  return async (c) => {
    const claims = await authenticate(c);
    if (!claims) return null;
    const decision = evaluateMfa(
      {
        role: claims.role,
        mfaEnabled: claims.mfaEnabled === true,
        graceUntil: claims.mfaGraceUntil,
        mfaRequired: claims.mfaRequired,
      },
      policy,
      now(),
    );
    if (decision.status === 'required') throw new MfaRequiredError(decision.graceUntil);
    if (decision.status === 'grace') {
      c.header(MFA_WARNING_HEADER, decision.graceUntil ? `grace; until=${decision.graceUntil}` : 'grace');
    }
    return claims;
  };
}
