import { Hono } from 'hono';
import { etag } from 'hono/etag';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, requireRole } from '../../http/helpers.js';
import type { PortfolioService } from './service.js';
import { PORTFOLIO_ROLES } from './types.js';

export type PortfolioRoutesDeps = { authenticate: Authenticator; service: PortfolioService };

/**
 * Yonetim firmasi portfoyu (coklu apartman paneli).
 *
 *   GET /?limit=&cursor=   -> { asOf, period, total, limit, items[], totals, nextCursor? }
 *
 * Yetki: aktif baglamin rolu `apartment_manager` / `management_company` / `observer` olmalidir
 * (merkezi MFA ara katmani bu rollerde uygulanir). Listelenen apartmanlar token'daki tek
 * `apartmentId`'den DEGIL, kullanicinin bugunku yetki kayitlarindan her istekte sunucuda yeniden
 * cikarilir; istemci apartman kimligi gonderemez. Destek oturumu (platform_admin) portfoy acamaz:
 * destek erisimi tek apartmanla sinirlidir.
 *
 * Onbellek: yanit kullaniciya ozeldir (`private`) ve her seferinde dogrulanir (`no-cache` + ETag):
 * tarayici degismeyen yaniti 304 ile yeniden kullanir, rol bitince bir sonraki istekte duser.
 */
export function portfolioRoutes({ authenticate, service }: PortfolioRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (c.get('claims').supportSessionId) {
      return c.json({ error: 'forbidden', message: 'Destek oturumunda yönetim portföyü açılamaz' }, 403);
    }
    await next();
  });
  r.use('*', requireRole(PORTFOLIO_ROLES));

  r.get('/', etag(), async (c) => {
    c.header('cache-control', 'private, no-cache');
    c.header('vary', 'authorization');
    return c.json(await service.list({ userId: c.get('claims').userId }, { limit: c.req.query('limit'), cursor: c.req.query('cursor') }));
  });

  return r;
}
