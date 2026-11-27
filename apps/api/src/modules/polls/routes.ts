import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { PollContext, PollPortalContext, PollService } from './service.js';

/** Duyurularla ayni rol listeleri (announcements/routes.ts). */
const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type PollRoutesDeps = { authenticate: Authenticator; service: PollService };

function requireApartment(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  };
}

/**
 * `/api/polls` - Y1 yonetici anket / oylama yonetimi (sakinler `/api/portal/polls` kullanir).
 *
 *   GET   /                   ?status=draft|scheduled|open|closed|cancelled|all
 *   POST  /                   { title, description?, options[2-10], audience?, weighting?, secret?,
 *                               resultsVisibleBeforeClose?, opensAt?, closesAt } -> taslak
 *   GET   /:id
 *   PATCH /:id                { version, ... } (yalnizca taslak)
 *   POST  /:id/publish        { version } -> yayinda + POLL_PUBLISHED + denetim `poll.publish`
 *   POST  /:id/close          { version, reason } -> erken kapatma + denetim `poll.close`
 *   POST  /:id/cancel         { version } -> taslak iptal + denetim `poll.cancel`
 *   GET   /:id/results        secenek sayilari, arsa payi toplamlari, katilim, kazanan
 *   GET   /:id/participation  bolum bazinda katilim (gizli oylamada secim YOK)
 *
 * Tenant izolasyonu: `apartmentId` YALNIZCA JWT claim'inden. `observer` salt okunur.
 */
export function pollRoutes({ authenticate, service }: PollRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireApartment());

  const ctx = (c: Context<Env>): PollContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => c.json({ items: await service.list(ctx(c), c.req.query('status')) }));
  r.post('/', requireRole(WRITE_ROLES), async (c) => c.json(await service.create(ctx(c), await readJson(c)), 201));
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.get(ctx(c), id(c))));
  r.patch('/:id', requireRole(WRITE_ROLES), async (c) => c.json(await service.update(ctx(c), id(c), await readJson(c))));
  r.post('/:id/publish', requireRole(WRITE_ROLES), async (c) => c.json(await service.publish(ctx(c), id(c), await readJson(c))));
  r.post('/:id/close', requireRole(WRITE_ROLES), async (c) => c.json(await service.close(ctx(c), id(c), await readJson(c))));
  r.post('/:id/cancel', requireRole(WRITE_ROLES), async (c) => c.json(await service.cancel(ctx(c), id(c), await readJson(c))));
  r.get('/:id/results', requireRole(READ_ROLES), async (c) => c.json(await service.results(ctx(c), id(c))));
  r.get('/:id/participation', requireRole(READ_ROLES), async (c) => c.json(await service.participation(ctx(c), id(c))));

  return r;
}

/**
 * `/api/portal/polls` - Y1 sakin portali (yalnizca `resident`).
 *
 *   GET  /              ?unitId=   dairemin gorebildigi oylamalar (acik once), oy hakki ve kendi oyum
 *   GET  /:id           ?unitId=   ayrinti + sonuc (bittiyse veya acik oylamada ara sonuc aciksa)
 *   POST /:id/vote      ?unitId=   { optionId } bolumun oyu (sonraki oy oncekinin yerine gecer)
 *
 * Daire `?unitId=` ile secilir ve kullanicinin AKTIF uyelikleriyle eslestirilir (portal kurali).
 */
export function pollPortalRoutes({ authenticate, service }: PollRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['resident']));
  r.use('*', requireApartment());
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const ctx = (c: Context<Env>): PollPortalContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };
  const unitId = (c: Context<Env>) => c.req.query('unitId');
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', async (c) => c.json(await service.portalList(ctx(c), unitId(c))));
  r.get('/:id', async (c) => c.json(await service.portalDetail(ctx(c), id(c), unitId(c))));
  r.post('/:id/vote', async (c) => c.json(await service.vote(ctx(c), id(c), unitId(c), await readJson(c))));

  return r;
}
