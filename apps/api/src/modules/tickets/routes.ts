import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { TicketContext, TicketService } from './service.js';

/** Yonetim / gorevli / guvenlik / denetci. Sakinler `/api/portal/tickets` (O1-2) kullanir. */
const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'security_guard', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'security_guard'];
const STAFF_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff'];
const MANAGE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type TicketRoutesDeps = { authenticate: Authenticator; service: TicketService };

/**
 * `/api/tickets` - Faz 3 (O1) ariza / talep yonetimi.
 *
 *   GET   /                      ?status=&assignee=me|none|<id>&category=&priority=&unitId=&blockId=&overdue=&q=&from=&to=&cursor=&limit=
 *   GET   /board                 durum sutunlari + SLA ozeti (yonetim, gorevli, denetci)
 *   GET   /assignees             aktif bina gorevlileri
 *   POST  /                      { idempotencyKey, title, description, category, priority?, location }
 *   GET   /:id                   talep + zaman cizelgesi
 *   PATCH /:id                   { version, title?, description?, category?, priority?, location? }   (yonetim)
 *   POST  /:id/assign            { version, assigneeId | null, note? }
 *   POST  /:id/status            { version, action, note?, rating? }
 *   POST  /:id/comments          { body, visibility? }
 *
 * Ince yetki kararlari (kimin hangi talebi gordugu, hangi gecisi yapabildigi) serviste.
 */
export function ticketRoutes({ authenticate, service }: TicketRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });

  const ctx = (c: Context<Env>): TicketContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => c.json(await service.list(ctx(c), c.req.query())));
  r.get('/board', requireRole([...STAFF_ROLES, 'observer']), async (c) => c.json(await service.board(ctx(c))));
  r.get('/assignees', requireRole([...STAFF_ROLES, 'observer']), async (c) => c.json(await service.assignees(ctx(c))));
  r.post('/', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.create(ctx(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.get(ctx(c), id(c))));
  r.patch('/:id', requireRole(MANAGE_ROLES), async (c) => c.json(await service.update(ctx(c), id(c), await readJson(c))));
  r.post('/:id/assign', requireRole(STAFF_ROLES), async (c) => c.json(await service.assign(ctx(c), id(c), await readJson(c))));
  r.post('/:id/status', requireRole(WRITE_ROLES), async (c) => c.json(await service.transition(ctx(c), id(c), await readJson(c))));
  r.post('/:id/comments', requireRole(WRITE_ROLES), async (c) => c.json(await service.comment(ctx(c), id(c), await readJson(c)), 201));

  return r;
}
