import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { MaintenanceContext, MaintenanceService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'observer'];
const STAFF_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff'];
const MANAGE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type MaintenanceRoutesDeps = { authenticate: Authenticator; service: MaintenanceService };

/**
 * `/api/maintenance` - Faz 3 (O1-3) periyodik bakim.
 *
 *   GET   /presets
 *   GET   /templates                ?status=active|archived|all
 *   POST  /templates                { preset?, name, category, schedule{every,unit,startDate}, checklist?, asset?, blockIds?,
 *                                     defaultAssigneeId?, supplierAccountId?, expenseAccountId?, expectedCost?, legalNote?, leadDays? }
 *   GET   /templates/:id            sablon + penceredeki gorevler
 *   PUT   /templates/:id            { version, ...kismi }
 *   POST  /templates/:id/archive    { version }
 *   GET   /tasks                    ?from=&to=&status=open|...&assignee=me|none|<id>&templateId=&overdue=true
 *   GET   /calendar                 ?month=YYYY-MM
 *   GET   /tasks/:id
 *   POST  /tasks/:id/assign         { version, assigneeId | null }
 *   POST  /tasks/:id/start          { version }
 *   POST  /tasks/:id/complete       { version, checklistResults[{id, ok, note?}], note?, photos? }
 *   POST  /tasks/:id/skip           { version, reason }
 *   POST  /tasks/:id/ticket         { idempotencyKey, title?, description?, priority?, photos? }
 *   POST  /photos/upload-url        { contentType, size }
 *   GET   /tasks/:id/photos/:photoId
 */
export function maintenanceRoutes({ authenticate, service }: MaintenanceRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });
  const ctx = (c: Context<Env>): MaintenanceContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/presets', requireRole(READ_ROLES), (c) => c.json(service.presets(ctx(c))));
  r.get('/templates', requireRole(READ_ROLES), async (c) => c.json(await service.listTemplates(ctx(c), { status: c.req.query('status') })));
  r.post('/templates', requireRole(MANAGE_ROLES), async (c) => c.json(await service.createTemplate(ctx(c), await readJson(c)), 201));
  r.get('/templates/:id', requireRole(READ_ROLES), async (c) => c.json(await service.getTemplate(ctx(c), id(c))));
  r.put('/templates/:id', requireRole(MANAGE_ROLES), async (c) => c.json(await service.updateTemplate(ctx(c), id(c), await readJson(c))));
  r.post('/templates/:id/archive', requireRole(MANAGE_ROLES), async (c) => c.json(await service.archiveTemplate(ctx(c), id(c), await readJson(c))));

  r.get('/tasks', requireRole(READ_ROLES), async (c) => c.json(await service.listTasks(ctx(c), c.req.query())));
  r.get('/calendar', requireRole(READ_ROLES), async (c) => c.json(await service.calendar(ctx(c), { month: c.req.query('month') })));
  r.get('/tasks/:id', requireRole(READ_ROLES), async (c) => c.json(await service.getTask(ctx(c), id(c))));
  r.post('/tasks/:id/assign', requireRole(STAFF_ROLES), async (c) => c.json(await service.assignTask(ctx(c), id(c), await readJson(c))));
  r.post('/tasks/:id/start', requireRole(STAFF_ROLES), async (c) => c.json(await service.startTask(ctx(c), id(c), await readJson(c))));
  r.post('/tasks/:id/complete', requireRole(STAFF_ROLES), async (c) => c.json(await service.completeTask(ctx(c), id(c), await readJson(c))));
  r.post('/tasks/:id/skip', requireRole(MANAGE_ROLES), async (c) => c.json(await service.skipTask(ctx(c), id(c), await readJson(c))));
  r.post('/tasks/:id/ticket', requireRole(STAFF_ROLES), async (c) => {
    const result = await service.openTicket(ctx(c), id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post('/photos/upload-url', requireRole(STAFF_ROLES), async (c) => c.json(await service.photoUploadUrl(ctx(c), await readJson(c))));
  r.get('/tasks/:id/photos/:photoId', requireRole(READ_ROLES), async (c) => c.json(await service.photo(ctx(c), id(c), c.req.param('photoId') ?? '')));

  return r;
}
