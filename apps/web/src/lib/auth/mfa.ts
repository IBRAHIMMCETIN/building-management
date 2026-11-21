import type { SessionClaims } from './session';

/**
 * Zorunlu MFA (G2) arayuz kurallari. Yetki karari API'dedir (403 MFA_REQUIRED); burasi
 * yalnizca yonlendirme ve uyari metinleri icindir.
 */

/** Token kurulum zorunlu diyor veya API bu oturumda MFA_REQUIRED dondu. */
export function needsMfaSetup(claims: SessionClaims | null | undefined, apiSaysRequired = false): boolean {
  if (!claims?.role) return false;
  if (claims.mfa?.enabled) return false;
  return apiSaysRequired || claims.mfa?.required === true;
}

/** `warn` doneminde kalan tam gun (bugun dahil, en az 0); sure yoksa undefined. */
export function mfaGraceDaysLeft(claims: SessionClaims | null | undefined, now: Date = new Date()): number | undefined {
  const until = claims?.mfa && !claims.mfa.enabled && !claims.mfa.required ? claims.mfa.graceUntil : undefined;
  if (!until) return undefined;
  const ms = Date.parse(until) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Gizli anahtari okunakli 4'lu gruplara boler (manuel giris icin). */
export function formatSecret(secret: string): string {
  return secret.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? '';
}

export const MFA_SETUP_PATH = '/mfa-setup';
