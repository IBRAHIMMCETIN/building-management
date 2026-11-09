import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { ApartmentRoleContext, ApartmentRoleService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type ApartmentRoleRoutesDeps = { authenticate: Authenticator; service: ApartmentRoleService };

/**
 * `/api/apartment-roles` - yonetici / yonetim firmasi / denetci / personel atamalari.
 *
 *   GET    /                    ?role=&userId=&status=active|inactive|all&current=true
 *   POST   /                    { userId, role, startDate?, endDate?, displayName? }
 *   GET    /:userId/:role
 *   PATCH  /:userId/:role       { version, startDate?, endDate? (null = temizle), displayName? }
 *   DELETE /:userId/:role       -> pasife alir
 */
export function apartmentRoleRoutes({ authenticate, service }: ApartmentRoleRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
  });

  const ctx = (c: Context<Env>): ApartmentRoleContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };
  const ids = (c: Context<Env>) => [c.req.param('userId') ?? '', c.req.param('role') ?? ''] as const;

  r.get('/', requireRole(READ_ROLES), async (c) => {
    const items = await service.list(ctx(c), {
      role: c.req.query('role'),
      userId: c.req.query('userId'),
      status: c.req.query('status'),
      current: c.req.query('current'),
    });
    return c.json({ items: items.map(publicView) });
  });

  r.post('/', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.create(ctx(c), await readJson(c))), 201),
  );

  r.get('/:userId/:role', requireRole(READ_ROLES), async (c) =>
    c.json(publicView(await service.get(ctx(c), ...ids(c)))),
  );

  r.patch('/:userId/:role', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.update(ctx(c), ...ids(c), await readJson(c)))),
  );

  r.delete('/:userId/:role', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.deactivate(ctx(c), ...ids(c)))),
  );

  return r;
}
