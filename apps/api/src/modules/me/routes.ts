import { Hono } from 'hono';
import type { AuthIdentity, IdentityResolver } from '../../auth/claims.js';
import { handleError } from '../../http/helpers.js';
import type { MeService } from './service.js';

type MeEnv = { Variables: { identity: AuthIdentity } };

export type MeRoutesDeps = { identify: IdentityResolver; service: MeService };

/**
 * `/api/me` - oturum sahibinin kendi bilgileri. Diger modullerden farkli olarak ROL
 * GEREKTIRMEZ: birden fazla apartmani olup henuz secim yapmamis kullanicinin token'inda
 * rol claim'i yoktur, ama secim ekrani icin baglamlarini listeleyebilmelidir.
 * Buradan hicbir apartman verisi donmez; yalnizca kullanicinin kendi yetkileri.
 *
 *   GET /contexts  -> { userId, isPlatformAdmin, active, contexts[] }
 */
export function meRoutes({ identify, service }: MeRoutesDeps) {
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

  return r;
}
