import { z } from 'zod';
import { sessionManager } from '@/lib/auth/sessionManager';
import { apiClient } from './client';

/** GET /api/me/mfa */
export const mfaStatusSchema = z.object({
  mode: z.enum(['off', 'warn', 'enforce']),
  graceDays: z.number(),
  roleRequiresMfa: z.boolean(),
  enabled: z.boolean(),
  status: z.enum(['not_required', 'enabled', 'grace', 'required']),
  graceUntil: z.string().optional(),
});
export type MfaStatus = z.infer<typeof mfaStatusSchema>;

export const mfaSetupSchema = z.object({
  secretCode: z.string().min(16),
  otpauthUri: z.string().startsWith('otpauth://totp/'),
  issuer: z.string(),
  account: z.string(),
});
export type MfaSetup = z.infer<typeof mfaSetupSchema>;

/**
 * Kurulum Cognito'da kullanicinin ACCESS token'i ile yapilir. LITE katmaninda API'ye ID token
 * gittigi icin access token ayri baslikta gonderilir (API sahipligini kontrol eder).
 */
function accessTokenHeader(): Record<string, string> {
  const session = sessionManager.getSession();
  return session ? { 'x-cognito-access-token': session.accessToken } : {};
}

export function fetchMfaStatus(signal?: AbortSignal) {
  return apiClient.get('/api/me/mfa', { schema: mfaStatusSchema, signal });
}

export function beginTotpSetup() {
  return apiClient.post('/api/me/mfa/totp/setup', undefined, { schema: mfaSetupSchema, headers: accessTokenHeader() });
}

export function verifyTotp(input: { code: string; deviceName?: string }) {
  return apiClient.post<{ enabled: true }>('/api/me/mfa/totp/verify', input, { headers: accessTokenHeader() });
}

/** Yonetici: cihaz kaybinda kullanicinin TOTP'sini sifirlar (denetim gunlugune yazilir). */
export function resetUserMfa(userId: string, reason: string) {
  return apiClient.post<{ userId: string; reset: true; signedOut: true }>(
    `/api/mfa/users/${encodeURIComponent(userId)}/reset`,
    { reason },
  );
}
