import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthClaims, Authenticator, Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { CoreError, type CoreService, type EntityStatusFilter } from './service.js';
import type { TableKeys } from './types.js';
import { ValidationError, assertId, asObject, optEnum } from './validation.js';

type Env = { Variables: { claims: AuthClaims } };

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

/** Istemciye ic DynamoDB anahtarlarini (PK/SK) gostermeyiz. */
function publicView<T extends object>(item: T): Omit<T, 'PK' | 'SK'> {
  const { PK: _pk, SK: _sk, ...rest } = item as T & Partial<TableKeys>;
  return rest as Omit<T, 'PK' | 'SK'>;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('Gecersiz JSON govdesi');
  }
}

function requireRole(roles: readonly Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!roles.includes(c.get('claims').role)) {
      return c.json({ error: 'forbidden', message: 'Bu islem icin yetkiniz yok' }, 403);
    }
    await next();
  };
}

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

function handleError(err: Error, c: Context) {
  if (err instanceof ValidationError) {
    return c.json({ error: 'validation_error', message: err.message, field: err.field }, 400);
  }
  if (err instanceof CoreError) {
    return c.json({ error: err.code, message: err.message }, err.httpStatus);
  }
  if (err instanceof DataAccessError) {
    if (err.httpStatus >= 500) console.error(err);
    return c.json({ error: err.code, message: err.message }, err.httpStatus as ContentfulStatusCode);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
}

export function coreRoutes({ authenticate, service }: CoreRoutesDeps) {
  const r = new Hono<Env>();

  r.onError(handleError);

  r.use('*', async (c, next) => {
    const claims = await authenticate(c);
    if (!claims) return c.json({ error: 'unauthorized' }, 401);
    c.set('claims', claims);
    await next();
  });

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
