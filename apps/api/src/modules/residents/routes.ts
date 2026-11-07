import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { type ResidentsContext, ResidentsError, type ResidentsService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type ResidentsRoutesDeps = { authenticate: Authenticator; service: ResidentsService };

/**
 * `/api/residents` - apartmanin kisileri (ad/e-posta) ve sakin daveti.
 * Apartman YALNIZCA JWT `apartmentId` claim'inden gelir.
 *
 *   GET  /         -> { items: [{ userId, fullName, email }] }  (observer: e-posta maskeli)
 *   POST /invite   { unitId, email, fullName, relation, startDate?, residesInUnit?, ownershipShare?, endDate? }
 *                  -> 201 { person, membership, invitation: 'sent' | 'existing_user' }
 */
export function residentRoutes({ authenticate, service }: ResidentsRoutesDeps) {
  const r = new Hono<Env>();
  r.onError((err, c) =>
    err instanceof ResidentsError
      ? c.json({ error: err.code, message: err.message }, err.httpStatus)
      : handleError(err, c),
  );
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
  });

  const ctx = (c: Context<Env>): ResidentsContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
  };

  r.get('/', requireRole(READ_ROLES), async (c) => c.json({ items: await service.list(ctx(c)) }));

  r.post('/invite', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.invite(ctx(c), await readJson(c)), 201),
  );

  return r;
}
