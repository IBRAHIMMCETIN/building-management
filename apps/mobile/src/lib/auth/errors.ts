import { AuthRequiredError, NetworkError } from '@bm/shared/api/errors';
import { AuthFlowError } from '@bm/shared/auth/errors';

/*
 * Oturumu dusurme karari: yalnizca kimlik saglayicisinin GERCEK reddi (yenileme token'i gecersiz /
 * iptal, kullanici yok vb.) oturumu kapatir. Ag kesintisi, zaman asimi veya gecici servis hatasinda
 * oturum korunur; istek ag hatasiyla doner ve baglanti gelince yeniden denenir (mobilde tunel, asansor,
 * metro gibi kisa kesintiler olagan).
 */

/** Amplify'in token'lari silip yeniden giris istedigi hata adlari (TokenOrchestrator.isAuthenticationError). */
export const AUTH_REJECTION_NAMES = [
  'NotAuthorizedException',
  'TokenRevokedException',
  'UserNotFoundException',
  'PasswordResetRequiredException',
  'UserNotConfirmedException',
  'RefreshTokenReuseException',
] as const;

const nameOf = (err: unknown) => (typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : '');

/** Sunucuya hic ulasilamadi (yanit yok): ag yok, zaman asimi, DNS. */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  const name = nameOf(err);
  if (name === 'NetworkError' || name === 'TimeoutError') return true;
  return err instanceof TypeError && /network|fetch|internet|offline/i.test(err.message);
}

/** Kimlik saglayicisinin kesin reddi: yeniden giris gerekir. */
export function isAuthRejection(err: unknown): boolean {
  if (err instanceof AuthRequiredError) return true;
  const name = err instanceof AuthFlowError ? err.code : nameOf(err);
  return AUTH_REJECTION_NAMES.some((n) => name.startsWith(n));
}
