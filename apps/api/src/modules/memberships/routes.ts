import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { MembershipContext, MembershipService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type MembershipRoutesDeps = { authenticate: Authenticator; service: MembershipService };

/**
 * `/api/memberships` - daire uyelikleri (malik/kiraci atama, giris-cikis tarihleri).
 * Apartman YALNIZCA JWT `apartmentId` claim'inden gelir; URL'de apartman kimligi yoktur.
 *
 *   GET    /                       ?unitId=&userId=&status=active|inactive|all&current=true
 *   POST   /                       { userId, unitId, relation, residesInUnit?, ownershipShare?, startDate, endDate? }
 *   GET    /:userId/:unitId
 *   PATCH  /:userId/:unitId        { version, startDate?, endDate? (null = temizle), residesInUnit?, ownershipShare? }
 *   DELETE /:userId/:unitId        -> iptal (status: inactive), kayit silinmez
 */
export function membershipRoutes({ authenticate, service }: MembershipRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
  });

  const ctx = (c: Context<Env>): MembershipContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };
  const ids = (c: Context<Env>) => [c.req.param('userId') ?? '', c.req.param('unitId') ?? ''] as const;

  r.get('/', requireRole(READ_ROLES), async (c) => {
    const items = await service.list(ctx(c), {
      unitId: c.req.query('unitId'),
      userId: c.req.query('userId'),
      status: c.req.query('status'),
      current: c.req.query('current'),
    });
    return c.json({ items: items.map(publicView) });
  });

  r.post('/', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.create(ctx(c), await readJson(c))), 201),
  );

  r.get('/:userId/:unitId', requireRole(READ_ROLES), async (c) =>
    c.json(publicView(await service.get(ctx(c), ...ids(c)))),
  );

  r.patch('/:userId/:unitId', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.update(ctx(c), ...ids(c), await readJson(c)))),
  );

  r.delete('/:userId/:unitId', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.deactivate(ctx(c), ...ids(c)))),
  );

  return r;
}
