import type { Context, Hono } from 'hono';
import type { Role } from '../../auth/claims.js';
import { type Env, readJson, requireRole } from '../../http/helpers.js';
import type { WorkCostContext, WorkCostService } from './service.js';
import type { WorkKind } from './types.js';

/** Masraflari yonetim ve denetci gorur; gorevli ve sakin goremez (rol matrisi). */
const COST_READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const COST_WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

/**
 * O1-4 masraf uclari; talep (`/api/tickets`) ve bakim (`/api/maintenance/tasks`) yonlendiricilerine eklenir.
 *
 *   GET   {base}/:id/costs                         bagli masraflar (iptal durumu okuma aninda), yansitmalar, oneriler
 *   POST  {base}/:id/costs                         { idempotencyKey, mode: 'expense', expenseAccountId?, creditAccountId?, amount, date?,
 *                                                    description?, supplier?, invoiceNumber?, invoiceUpload? }
 *                                                  { idempotencyKey, mode: 'link', expenseId }
 *   POST  {base}/:id/costs/:expenseId/unlink       { reason }   (yalnizca link modu)
 *   POST  {base}/:id/charges                       { idempotencyKey, confirm: true, liableParty: owner|occupant, amount, dueDate,
 *                                                    date?, description? }   (yalnizca talep; daire ici)
 */
export function mountWorkCostRoutes(
  r: Hono<Env>,
  opts: { kind: WorkKind; base: string; service: WorkCostService; ctx: (c: Context<Env>) => WorkCostContext },
) {
  const { kind, base, service, ctx } = opts;
  const id = (c: Context<Env>) => c.req.param('id') ?? '';
  r.get(`${base}/:id/costs`, requireRole(COST_READ_ROLES), async (c) => c.json(await service.costs(ctx(c), kind, id(c))));
  r.post(`${base}/:id/costs`, requireRole(COST_WRITE_ROLES), async (c) => {
    const result = await service.add(ctx(c), kind, id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post(`${base}/:id/costs/:expenseId/unlink`, requireRole(COST_WRITE_ROLES), async (c) =>
    c.json(await service.unlink(ctx(c), kind, id(c), c.req.param('expenseId') ?? '', await readJson(c))),
  );
  if (kind === 'ticket') {
    r.post(`${base}/:id/charges`, requireRole(COST_WRITE_ROLES), async (c) => {
      const result = await service.charge(ctx(c), id(c), await readJson(c));
      return c.json(result, result.replayed ? 200 : 201);
    });
  }
}
