import { Hono } from 'hono';
import type { AuthIdentity, IdentityResolver } from '../../auth/claims.js';
import { handleError } from '../../http/helpers.js';
import { setRequestActor } from '../audit/context.js';
import { accessTokenFrom } from '../mfa/routes.js';
import type { MfaService } from '../mfa/service.js';
import type { PreferencesService } from '../notifications/preferences.js';
import type { MeService } from './service.js';

type MeEnv = { Variables: { identity: AuthIdentity } };

export type MeRoutesDeps = {
  identify: IdentityResolver;
  service: MeService;
  /** Bildirim tercihleri; verilmezse uclar 404 (yalnizca testler / eski cagiranlar). */
  preferences?: PreferencesService;
  /** TOTP kurulumu; verilmezse `/mfa` uclari yok (yalnizca eski testler). */
  mfa?: MfaService;
};

/**
 * `/api/me` - oturum sahibinin kendi bilgileri. Diger modullerden farkli olarak ROL
 * GEREKTIRMEZ: birden fazla apartmani olup henuz secim yapmamis kullanicinin token'inda
 * rol claim'i yoktur, ama secim ekrani icin baglamlarini listeleyebilmelidir.
 * Buradan hicbir apartman verisi donmez; yalnizca kullanicinin kendi yetkileri.
 *
 *   GET /contexts  -> { userId, isPlatformAdmin, active, contexts[] }
 *   GET /notification-preferences -> { email: { enabled, finance?, announcements?, tickets?, gate?,
 *                                     reservations?, polls? } }   (kayit yoksa varsayilan: hepsi acik)
 *   PUT /notification-preferences   { email: { enabled: boolean, <kategori>?: boolean } }
 *                                   (verilmeyen kategoride onceki secim korunur)
 * Tercih kullanicinin kendisine aittir: kimlik JWT'den gelir, govdede kullanici kimligi yoktur.
 *
 * Zorunlu MFA (G2) kurulumu da buradadir; `MFA_REQUIRED` durumundaki kullanici yalnizca bu
 * uclari kullanabilir (merkezi MFA ara katmani `/api/me`'ye uygulanmaz):
 *   GET  /mfa                -> { mode, graceDays, roleRequiresMfa, enabled, status, graceUntil? }
 *   POST /mfa/totp/setup     -> { secretCode, otpauthUri, issuer, account }   (AssociateSoftwareToken)
 *   POST /mfa/totp/verify      { code, deviceName? } -> { enabled: true }
 *                               (VerifySoftwareToken + SetUserMFAPreference; denetim: mfa.totp.enable)
 * Kurulum uclari kullanicinin Cognito access token'ini `X-Cognito-Access-Token` basliginda
 * ister (yoksa Authorization'daki token denenir). Basarili kurulumdan sonra istemci token'i
 * yenilemelidir (`mfa_enabled` claim'i).
 */
export function meRoutes({ identify, service, preferences, mfa }: MeRoutesDeps) {
  const r = new Hono<MeEnv>();
  r.onError(handleError);
  r.use('*', async (c, next) => {
    const identity = await identify(c);
    if (!identity) return c.json({ error: 'unauthorized' }, 401);
    c.set('identity', identity);
    setRequestActor({ userId: identity.userId, role: identity.claims?.role ?? 'user' });
    await next();
  });

  r.get('/contexts', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await service.contexts(c.get('identity')));
  });

  if (preferences) {
    r.get('/notification-preferences', async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await preferences.get(c.get('identity').userId));
    });
    r.put('/notification-preferences', async (c) => {
      const body = await c.req.json().catch(() => undefined);
      return c.json(await preferences.update(c.get('identity').userId, body));
    });
  }

  if (mfa) {
    r.get('/mfa', async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await mfa.status(c.get('identity')));
    });
    r.post('/mfa/totp/setup', async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await mfa.beginSetup(c.get('identity'), accessTokenFrom(c)));
    });
    r.post('/mfa/totp/verify', async (c) => {
      const body = await c.req.json().catch(() => undefined);
      return c.json(await mfa.completeSetup(c.get('identity'), accessTokenFrom(c), body));
    });
  }

  return r;
}
