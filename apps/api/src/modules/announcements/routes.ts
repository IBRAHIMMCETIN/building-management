import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { AnnouncementContext, AnnouncementService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type AnnouncementRoutesDeps = { authenticate: Authenticator; service: AnnouncementService };

/**
 * `/api/announcements` - yonetici duyuru yonetimi (sakinler `/api/portal/announcements` kullanir).
 *
 *   GET   /                  ?status=draft|published|archived|all
 *   POST  /                  { title, body, blockIds?, publishAt?, expiresAt? } -> taslak
 *   GET   /:id
 *   PATCH /:id               { version, ... } (yalnizca taslak)
 *   POST  /:id/approve       { version } -> yayinda + ANNOUNCEMENT_PUBLISHED olayi
 *   POST  /:id/archive       { version }
 */
export function announcementRoutes({ authenticate, service }: AnnouncementRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
  });

  const ctx = (c: Context<Env>): AnnouncementContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => {
    const items = await service.list(ctx(c), c.req.query('status'));
    return c.json({ items: items.map(publicView) });
  });

  r.post('/', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.create(ctx(c), await readJson(c))), 201),
  );

  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(publicView(await service.get(ctx(c), id(c)))));

  r.patch('/:id', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.update(ctx(c), id(c), await readJson(c)))),
  );

  r.post('/:id/approve', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.approve(ctx(c), id(c), await readJson(c)))),
  );

  r.post('/:id/archive', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.archive(ctx(c), id(c), await readJson(c)))),
  );

  return r;
}
