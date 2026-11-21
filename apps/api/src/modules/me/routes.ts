import { Hono } from 'hono';
import type { AuthIdentity, IdentityResolver } from '../../auth/claims.js';
import { handleError } from '../../http/helpers.js';
import type { PreferencesService } from '../notifications/preferences.js';
import type { MeService } from './service.js';

type MeEnv = { Variables: { identity: AuthIdentity } };

export type MeRoutesDeps = {
  identify: IdentityResolver;
  service: MeService;
  /** Bildirim tercihleri; verilmezse uclar 404 (yalnizca testler / eski cagiranlar). */
  preferences?: PreferencesService;
};

/**
 * `/api/me` - oturum sahibinin kendi bilgileri. Diger modullerden farkli olarak ROL
 * GEREKTIRMEZ: birden fazla apartmani olup henuz secim yapmamis kullanicinin token'inda
 * rol claim'i yoktur, ama secim ekrani icin baglamlarini listeleyebilmelidir.
 * Buradan hicbir apartman verisi donmez; yalnizca kullanicinin kendi yetkileri.
 *
 *   GET /contexts  -> { userId, isPlatformAdmin, active, contexts[] }
 *   GET /notification-preferences -> { email: { enabled } }   (kayit yoksa varsayilan: acik)
 *   PUT /notification-preferences   { email: { enabled: boolean } }
 * Tercih kullanicinin kendisine aittir: kimlik JWT'den gelir, govdede kullanici kimligi yoktur.
 */
export function meRoutes({ identify, service, preferences }: MeRoutesDeps) {
  const r = new Hono<MeEnv>();
  r.onError(handleError);
  r.use('*', async (c, next) => {
    const identity = await identify(c);
    if (!identity) return c.json({ error: 'unauthorized' }, 401);
    c.set('identity', identity);
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

  return r;
}
