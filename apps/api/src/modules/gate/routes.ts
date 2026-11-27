import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, readJson, requireRole } from '../../http/helpers.js';
import { handleGateError } from './errors.js';
import type { GateContext, GateService } from './service.js';

/** Yonetim (tam), guvenlik gorevlisi (kapi islemleri). Denetci ve bina gorevlisi bu modulu gormez (KVKK: en az erisim). */
const MANAGE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];
const DESK_ROLES: readonly Role[] = [...MANAGE_ROLES, 'security_guard'];

export type GateRoutesDeps = { authenticate: Authenticator; service: GateService };

function gateContext(c: Context<Env>): GateContext {
  const claims = c.get('claims');
  return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
}

function base(authenticate: Authenticator, roles: readonly Role[]) {
  const r = new Hono<Env>();
  r.onError(handleGateError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(roles));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });
  return r;
}

/**
 * `/api/gate` - guvenlik kapisi (yonetim + guvenlik gorevlisi).
 *
 *   GET   /units?q=                       bolum secici (yalnizca etiket)
 *   GET   /plates?q=                      plaka sorgusu: tam veya sondan >= 3 karakter, en fazla 10 sonuc
 *   GET   /vehicles?unitId=&status=&q=    (yonetim) tum araclar
 *   POST  /vehicles                       (yonetim) { unitId, plate, note? }
 *   PATCH /vehicles/:id                   (yonetim) { version, status?, note? }
 *   GET   /passes?status=active|past&unitId=   (yonetim) misafir gecisleri
 *   POST  /passes/verify                  { token } | { code }  -> gecis + karar
 *   POST  /passes/:id/entry|exit          { idempotencyKey }
 *   POST  /passes/:id/revoke              (yonetim) { version }
 *   GET   /couriers?status=open           son kurye kayitlari
 *   POST  /couriers                       { idempotencyKey, unitId, company?, note? }
 *   POST  /couriers/:id/entry|exit        { idempotencyKey }
 *   POST  /couriers/:id/cancel            { version }
 *   POST  /log                            { idempotencyKey, direction, visitorName, unitId?, plate?, note? }
 *   GET   /log?from=&to=&kind=&unitId=&cursor=&limit=   (gorevli: yalnizca dun + bugun)
 */
export function gateRoutes({ authenticate, service }: GateRoutesDeps) {
  const r = base(authenticate, DESK_ROLES);
  const id = (c: Context<Env>) => c.req.param('id') ?? '';
  const manage = requireRole(MANAGE_ROLES);

  r.get('/units', async (c) => c.json(await service.listUnits(gateContext(c), c.req.query('q'))));
  r.get('/plates', async (c) => c.json(await service.lookupPlate(gateContext(c), c.req.query('q'))));

  r.get('/vehicles', manage, async (c) => c.json(await service.listVehicles(gateContext(c), c.req.query())));
  r.post('/vehicles', manage, async (c) => c.json(await service.createVehicle(gateContext(c), await readJson(c)), 201));
  r.patch('/vehicles/:id', manage, async (c) => c.json(await service.updateVehicle(gateContext(c), id(c), await readJson(c))));

  r.get('/passes', manage, async (c) => c.json(await service.listPasses(gateContext(c), c.req.query())));
  r.post('/passes/verify', async (c) => c.json(await service.verifyPass(gateContext(c), await readJson(c))));
  r.post('/passes/:id/entry', async (c) => c.json(await service.passEntry(gateContext(c), id(c), await readJson(c))));
  r.post('/passes/:id/exit', async (c) => c.json(await service.passExit(gateContext(c), id(c), await readJson(c))));
  r.post('/passes/:id/revoke', manage, async (c) => c.json(await service.revokePass(gateContext(c), id(c), await readJson(c))));

  r.get('/couriers', async (c) => c.json(await service.listCouriers(gateContext(c), c.req.query())));
  r.post('/couriers', async (c) => {
    const result = await service.createCourier(gateContext(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post('/couriers/:id/entry', async (c) => c.json(await service.courierEntry(gateContext(c), id(c), await readJson(c))));
  r.post('/couriers/:id/exit', async (c) => c.json(await service.courierExit(gateContext(c), id(c), await readJson(c))));
  r.post('/couriers/:id/cancel', async (c) => c.json(await service.cancelCourier(gateContext(c), id(c), await readJson(c))));

  r.post('/log', async (c) => {
    const result = await service.recordManual(gateContext(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.get('/log', async (c) => c.json(await service.listLog(gateContext(c), c.req.query())));

  return r;
}

/**
 * `/api/portal/gate` - sakin: oturdugu bolumlerin araclari, misafir gecisleri, kuryeleri ve kapi
 * kayitlari. Daireler JWT + guncel uyelik kayitlarindan cozulur.
 *
 *   GET   /                       { units, limits }
 *   GET   /vehicles               POST /vehicles { unitId, plate, note? }   PATCH /vehicles/:id { version, status?, note? }
 *   GET   /passes?status=         POST /passes { idempotencyKey, unitId, guestName, validFrom, validUntil?, entryMode, plate?, note? }
 *   POST  /passes/:id/revoke      { version }
 *   POST  /passes/:id/rotate      { version }  -> yeni QR jetonu + kisa kod (yalnizca bu yanitta; eskiler gecersiz)
 *   GET   /couriers               POST /couriers/:id/respond { version, decision: approve|decline, note? }
 *   GET   /log?unitId=&from=&to=&cursor=
 */
export function gatePortalRoutes({ authenticate, service }: GateRoutesDeps) {
  const r = base(authenticate, ['resident']);
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', async (c) => c.json(await service.portalOverview(gateContext(c))));
  r.get('/vehicles', async (c) => c.json(await service.listVehicles(gateContext(c), c.req.query())));
  r.post('/vehicles', async (c) => c.json(await service.createVehicle(gateContext(c), await readJson(c)), 201));
  r.patch('/vehicles/:id', async (c) => c.json(await service.updateVehicle(gateContext(c), id(c), await readJson(c))));
  r.get('/passes', async (c) => c.json(await service.listPasses(gateContext(c), c.req.query())));
  r.post('/passes', async (c) => {
    const result = await service.createPass(gateContext(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post('/passes/:id/revoke', async (c) => c.json(await service.revokePass(gateContext(c), id(c), await readJson(c))));
  r.post('/passes/:id/rotate', async (c) => c.json(await service.rotatePass(gateContext(c), id(c), await readJson(c))));
  r.get('/couriers', async (c) => c.json(await service.listCouriers(gateContext(c), c.req.query())));
  r.post('/couriers/:id/respond', async (c) => c.json(await service.respondCourier(gateContext(c), id(c), await readJson(c))));
  r.get('/log', async (c) => c.json(await service.listLog(gateContext(c), c.req.query())));

  return r;
}
