import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import {
  type Env,
  authenticateWith,
  handleError,
  publicView,
  readJson,
  requireRole,
} from '../../http/helpers.js';
import type { CoreService, EntityStatusFilter } from './service.js';
import { ValidationError, assertId, asObject, optEnum } from './validation.js';

export type CoreRoutesDeps = {
  authenticate: Authenticator;
  service: CoreService;
};

// Veri okuma: yonetici, yonetim firmasi, denetci, bina gorevlisi.
// platform_admin apartman verisini okuyamaz (erisim audit log ile birlikte eklenecek).
const READ_ROLES: readonly Role[] = [
  'apartment_manager',
  'management_company',
  'observer',
  'building_staff',
];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];
const SITE_CREATE_ROLES: readonly Role[] = ['platform_admin', 'management_company'];

const STATUS_FILTERS = ['active', 'inactive', 'all'] as const;

/**
 * Tenant izolasyonu: URL'deki siteId yalnizca JWT'deki apartmentId ile
 * eslesiyorsa devam eder. Tum servis cagrilari claim'deki degeri kullanir.
 */
const siteGuard: MiddlewareHandler<Env> = async (c, next) => {
  const { apartmentId } = c.get('claims');
  if (!apartmentId || c.req.param('siteId') !== apartmentId) {
    return c.json({ error: 'forbidden', message: 'Bu apartmana erisim yetkiniz yok' }, 403);
  }
  await next();
};

function statusFilter(c: Context): EntityStatusFilter {
  const raw = c.req.query('status');
  return raw === undefined ? 'active' : optEnum({ status: raw }, 'status', STATUS_FILTERS) ?? 'active';
}

export function coreRoutes({ authenticate, service }: CoreRoutesDeps) {
  const r = new Hono<Env>();

  r.onError(handleError);

  r.use('*', authenticateWith(authenticate));

  r.use('/:siteId', siteGuard);
  r.use('/:siteId/*', siteGuard);

  const actor = (c: Context<Env>) => c.get('claims').userId;
  // Tenant daima claim'den gelir (siteGuard URL ile eslestigini zaten dogruladi).
  const apt = (c: Context<Env>) => c.get('claims').apartmentId as string;

  // ----- Site -----

  r.get('/', requireRole(READ_ROLES), async (c) => {
    const apartmentId = c.get('claims').apartmentId;
    if (!apartmentId) return c.json({ items: [] });
    return c.json({ items: [publicView(await service.getSite(apartmentId))] });
  });

  r.post('/', requireRole(SITE_CREATE_ROLES), async (c) => {
    const claims = c.get('claims');
    const body = asObject(await readJson(c));
    const tenantId =
      claims.role === 'platform_admin' && typeof body.tenantId === 'string'
        ? body.tenantId
        : claims.organizationId;
    if (!tenantId) {
      throw new ValidationError(
        'tenantId belirlenemedi (organizationId claim veya platform_admin icin govdede tenantId gerekli)',
        'tenantId',
      );
    }
    const site = await service.createSite(claims.userId, tenantId, body);
    return c.json(publicView(site), 201);
  });

  r.get('/:siteId', requireRole(READ_ROLES), async (c) =>
    c.json(publicView(await service.getSite(apt(c)))),
  );

  r.patch('/:siteId', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.updateSite(actor(c), apt(c), await readJson(c)))),
  );

  // ----- Bloklar -----

  r.get('/:siteId/blocks', requireRole(READ_ROLES), async (c) => {
    const blocks = await service.listBlocks(apt(c), statusFilter(c));
    return c.json({ items: blocks.map(publicView) });
  });

  r.post('/:siteId/blocks', requireRole(WRITE_ROLES), async (c) => {
    const block = await service.createBlock(actor(c), apt(c), await readJson(c));
    return c.json(publicView(block), 201);
  });

  r.get('/:siteId/blocks/:blockId', requireRole(READ_ROLES), async (c) =>
    c.json(publicView(await service.getBlock(apt(c), assertId(c.req.param('blockId'), 'blockId')))),
  );

  r.patch('/:siteId/blocks/:blockId', requireRole(WRITE_ROLES), async (c) => {
    const blockId = assertId(c.req.param('blockId'), 'blockId');
    return c.json(
      publicView(await service.updateBlock(actor(c), apt(c), blockId, await readJson(c))),
    );
  });

  // Silme yok: blok pasife alinir.
  r.delete('/:siteId/blocks/:blockId', requireRole(WRITE_ROLES), async (c) => {
    const blockId = assertId(c.req.param('blockId'), 'blockId');
    return c.json(publicView(await service.deactivateBlock(actor(c), apt(c), blockId)));
  });

  // ----- Bagimsiz bolumler -----

  r.get('/:siteId/units', requireRole(READ_ROLES), async (c) => {
    const { items, summary } = await service.listUnits(apt(c), {
      blockId: c.req.query('blockId'),
      status: statusFilter(c),
    });
    return c.json({ items: items.map(publicView), summary });
  });

  r.post('/:siteId/units', requireRole(WRITE_ROLES), async (c) => {
    const unit = await service.createUnit(actor(c), apt(c), await readJson(c));
    return c.json(publicView(unit), 201);
  });

  r.get('/:siteId/units/:unitId', requireRole(READ_ROLES), async (c) =>
    c.json(publicView(await service.getUnit(apt(c), assertId(c.req.param('unitId'), 'unitId')))),
  );

  r.patch('/:siteId/units/:unitId', requireRole(WRITE_ROLES), async (c) => {
    const unitId = assertId(c.req.param('unitId'), 'unitId');
    return c.json(
      publicView(await service.updateUnit(actor(c), apt(c), unitId, await readJson(c))),
    );
  });

  // Silme yok: bagimsiz bolum pasife alinir.
  r.delete('/:siteId/units/:unitId', requireRole(WRITE_ROLES), async (c) => {
    const unitId = assertId(c.req.param('unitId'), 'unitId');
    return c.json(publicView(await service.deactivateUnit(actor(c), apt(c), unitId)));
  });

  return r;
}
