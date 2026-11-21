import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { bearerToken } from '../../auth/authenticators.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { MFA_RESET_ROLES, type MfaService } from './service.js';

/** Kurulum uclarinda kullanicinin Cognito access token'i (LITE'ta API'ye ID token gider). */
export const ACCESS_TOKEN_HEADER = 'x-cognito-access-token';

/** Baslik yoksa Authorization'daki token denenir (ESSENTIALS: API'ye zaten access token gider). */
export function accessTokenFrom(c: Context): string | undefined {
  return c.req.header(ACCESS_TOKEN_HEADER)?.trim() || bearerToken(c);
}

/**
 * `/api/mfa` - yonetici islemleri (rol gerekir; cagiranin kendisi de MFA politikasina tabidir).
 *
 *   POST /users/:userId/reset   { reason (10-500) }
 *     Cihaz kaybinda kullanicinin TOTP'sini kapatir ve tum oturumlarini dusurur.
 *     - platform_admin: herkes (denetim kaydi PLATFORM zincirine).
 *     - apartment_manager / management_company: yalnizca aktif apartmanda yetkisi olan,
 *       baska apartmanda yonetici/denetci olmayan, platform_admin olmayan kullanicilar
 *       (denetim kaydi apartman zincirine). Kendi MFA'sini sifirlayamaz.
 *     Destek oturumu (salt okunur) ile yapilamaz.
 */
export function mfaAdminRoutes({ authenticate, service }: { authenticate: Authenticator; service: MfaService }) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(MFA_RESET_ROLES));
  r.post('/users/:userId/reset', async (c) =>
    c.json(await service.reset(c.get('claims'), c.req.param('userId'), await readJson(c))),
  );
  return r;
}
