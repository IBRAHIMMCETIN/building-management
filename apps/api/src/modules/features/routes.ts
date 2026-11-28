import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { FeatureService } from './service.js';

const SITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer', 'building_staff', 'security_guard', 'resident'];
const REQUEST_READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const REQUEST_WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type FeatureRoutesDeps = { authenticate: Authenticator; service: FeatureService };

const noStore: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

/**
 * Aktif apartmanin ozellikleri (`/api/site-features`). Apartman YALNIZCA JWT claim'inden gelir.
 *   GET  /            -> { apartmentId, version, profile, inherited, overrides, features, catalog }  (tum apartman rolleri)
 *   GET  /requests    -> { items }   bekleyen "acilmasini istiyorum" talepleri (yonetim + denetci)
 *   POST /requests      { feature, note? } -> 201 { created, request } | 200 (zaten bekliyor)  (yonetici / yonetim firmasi)
 */
export function siteFeatureRoutes({ authenticate, service }: FeatureRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });
  r.use('*', noStore);
  const apt = (c: Context<Env>) => c.get('claims').apartmentId as string;

  r.get('/', requireRole(SITE_ROLES), async (c) => c.json({ ...(await service.view(apt(c))), catalog: service.catalog() }));
  r.get('/requests', requireRole(REQUEST_READ_ROLES), async (c) => c.json({ items: await service.siteRequests(apt(c)) }));
  r.post('/requests', requireRole(REQUEST_WRITE_ROLES), async (c) => {
    const result = await service.requestEnable(c.get('claims').userId, apt(c), await readJson(c));
    return c.json(result, result.created ? 201 : 200);
  });
  return r;
}

/**
 * Platform ekibi (`/api/admin/site-features`, yalnizca `platform_admin`; destek oturumu yazamaz).
 *   GET   /requests                              bekleyen talepler (tum siteler)
 *   POST  /requests/:siteId/:feature/dismiss       { reason }  talebi acmadan kapat
 *   GET   /:siteId                               sitenin ozellik durumu + katalog
 *   PATCH /:siteId                                 { version, reason, profile?, features?: { anahtar: true|false|null } }
 * Her degisiklik degistirilemez denetim zincirine ayni atomik yazimda girer (fail closed).
 */
export function platformFeatureRoutes({ authenticate, service }: FeatureRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['platform_admin']));
  r.use('*', async (c, next) => {
    // Destek oturumu salt okunurdur ve apartman baglamindadir; platform ayari degistiremez.
    if (c.get('claims').supportSessionId) return c.json({ error: 'forbidden', message: 'Destek oturumunda platform ayarlari kullanilamaz' }, 403);
    await next();
  });
  r.use('*', noStore);
  const actor = (c: Context<Env>) => c.get('claims').userId;

  r.get('/requests', async (c) => c.json({ items: await service.listPendingRequests() }));
  r.post('/requests/:siteId/:feature/dismiss', async (c) =>
    c.json(await service.dismissRequest(actor(c), c.req.param('siteId'), c.req.param('feature'), await readJson(c))),
  );
  r.get('/:siteId', async (c) => c.json({ ...(await service.view(c.req.param('siteId'))), catalog: service.catalog() }));
  r.patch('/:siteId', async (c) =>
    c.json({ ...(await service.update(actor(c), c.req.param('siteId'), await readJson(c))), catalog: service.catalog() }),
  );
  return r;
}
