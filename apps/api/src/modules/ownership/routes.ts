import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { OwnershipContext, OwnershipService } from './service.js';
import { type SiteFeatureReader, requireFeature } from '../features/guard.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type OwnershipRoutesDeps = {
  authenticate: Authenticator;
  service: OwnershipService;
  /**
   * Adim 1: `admin.sharedOwnership` kapaliysa bolunmus cari modu (PUT billing) ve mulk/hisse devri
   * uclari 403 feature_disabled. Sicil okuma / duzeltme ve sorun listesi acik kalir. Verilmezse kontrol yok.
   */
  features?: SiteFeatureReader;
};

/**
 * Finans 2.1 - Hisseli mulkiyet ve mulk/hisse devri (`/api/ownership`).
 *
 *   GET  /units/:unitId?date=                 guncel pay tablosu, faturalama modu, temsilci, gecmis
 *   PUT  /units/:unitId/register              elle sicil (ilk kayit / duzeltme; cari hareketi yok)
 *   PUT  /units/:unitId/billing               { mode: joint|split, reason, version }
 *   PUT  /units/:unitId/representative        { userId|null, version }
 *   POST /units/:unitId/transfers/preview     devir onizlemesi (yazmaz)
 *   POST /units/:unitId/transfers             devir (tek atomik yazim, idempotent)
 *   GET  /units/:unitId/transfers             dairenin devirleri
 *   GET  /transfers/:transferId
 *   POST /transfers/:transferId/reverse       { reason }
 *   GET  /issues                              hisse tamligi / sicil tutarliligi sorunlari
 *   POST /backfill                            uyeliklerden ilk sicil gecisi
 *   GET  /voting-roll?date=                   oy listesi hazirligi
 *
 * Tenant izolasyonu: `apartmentId` YALNIZCA JWT claim'inden gelir. `observer` salt okunur.
 */
export function ownershipRoutes({ authenticate, service, features }: OwnershipRoutesDeps) {
  const r = new Hono<Env>();
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
  });
  r.onError(handleError);

  const ctx = (c: Context<Env>): OwnershipContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };

  const sharedGate = requireFeature(features, 'admin.sharedOwnership');
  r.use('/units/:unitId/billing', sharedGate);
  r.use('/units/:unitId/transfers', sharedGate);
  r.use('/units/:unitId/transfers/*', sharedGate);
  r.use('/transfers/*', sharedGate);

  r.get('/issues', requireRole(READ_ROLES), async (c) => c.json(await service.issues(ctx(c))));
  r.get('/voting-roll', requireRole(READ_ROLES), async (c) => c.json(await service.votingRoll(ctx(c), { date: c.req.query('date') })));
  r.post('/backfill', requireRole(WRITE_ROLES), async (c) => c.json(await service.backfill(ctx(c))));

  r.get('/units/:unitId', requireRole(READ_ROLES), async (c) =>
    c.json(await service.getUnitOwnership(ctx(c), c.req.param('unitId'), { date: c.req.query('date') })),
  );
  r.put('/units/:unitId/register', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.setRegister(ctx(c), c.req.param('unitId'), await readJson(c))),
  );
  r.put('/units/:unitId/billing', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.setBilling(ctx(c), c.req.param('unitId'), await readJson(c))),
  );
  r.put('/units/:unitId/representative', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.setRepresentative(ctx(c), c.req.param('unitId'), await readJson(c))),
  );
  r.post('/units/:unitId/transfers/preview', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.previewTransfer(ctx(c), c.req.param('unitId'), await readJson(c))),
  );
  r.post('/units/:unitId/transfers', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.createTransfer(ctx(c), c.req.param('unitId'), await readJson(c));
    return c.json({ replayed: result.replayed, transfer: publicView(result.transfer), warnings: result.warnings }, result.replayed ? 200 : 201);
  });
  r.get('/units/:unitId/transfers', requireRole(READ_ROLES), async (c) =>
    c.json({ items: (await service.listTransfers(ctx(c), c.req.param('unitId'))).map(publicView) }),
  );
  r.get('/transfers/:transferId', requireRole(READ_ROLES), async (c) =>
    c.json(publicView(await service.getTransfer(ctx(c), c.req.param('transferId')))),
  );
  r.post('/transfers/:transferId/reverse', requireRole(WRITE_ROLES), async (c) =>
    c.json(publicView(await service.reverseTransfer(ctx(c), c.req.param('transferId'), await readJson(c)))),
  );

  return r;
}
