import { type Context, Hono } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, requireRole } from '../../http/helpers.js';
import { PORTAL_ROLES, type PortalContext, type PortalService } from './service.js';

export type PortalRoutesDeps = { authenticate: Authenticator; service: PortalService };

/**
 * Sakin portali: `/api/portal/*` (salt okunur).
 *   GET /my-unit, /my-summary, /my-statement?from&to, /my-dues, /my-receipts, /announcements
 *   (hepsi opsiyonel `?unitId=`; birden fazla dairesi olan sakin icin zorunlu)
 *
 *  - Rol: yalnizca `resident` (JWT `role` claim'i). Yonetici/denetci kendi modullerini kullanir.
 *  - Apartman: yalnizca JWT `apartmentId` claim'i; URL/govdeden apartman kabul edilmez.
 *  - Daire: `?unitId=` opsiyoneldir ve servis katmaninda kullanicinin AKTIF uyelikleriyle
 *    eslestirilir; eslesmezse 403. Tek dairesi olan sakin parametre gondermez.
 *  - Kisisel finansal veri: yanitlar onbelleklenmez (`Cache-Control: no-store`).
 */
export function portalRoutes({ authenticate, service }: PortalRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);

  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(PORTAL_ROLES));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const ctx = (c: Context<Env>): PortalContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };
  const unitId = (c: Context<Env>) => c.req.query('unitId');

  r.get('/my-unit', async (c) => c.json(await service.getMyUnit(ctx(c), unitId(c))));

  r.get('/my-summary', async (c) => c.json(await service.getMySummary(ctx(c), unitId(c))));

  r.get('/my-dues', async (c) => c.json(await service.getMyDues(ctx(c), unitId(c))));

  r.get('/my-statement', async (c) =>
    c.json(
      await service.getMyStatement(ctx(c), {
        unitId: unitId(c),
        from: c.req.query('from'),
        to: c.req.query('to'),
      }),
    ),
  );

  r.get('/my-receipts', async (c) => c.json(await service.getMyReceipts(ctx(c), unitId(c))));

  r.get('/announcements', async (c) => c.json(await service.getAnnouncements(ctx(c), unitId(c))));

  return r;
}
