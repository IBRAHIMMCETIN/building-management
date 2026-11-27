import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { AssemblyContext, AssemblyService } from './service.js';

/** Duyuru ve oylamalarla ayni rol listeleri. */
const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type AssemblyRoutesDeps = { authenticate: Authenticator; service: AssemblyService };

/**
 * `/api/assemblies` - Y1-3 kat malikleri kurulu (genel kurul) hazirligi.
 *
 *   GET   /                                   toplantilar (en yeni once)
 *   POST  /                                   { kind, scheduledAt, location?, onlineUrl?, secondMeeting?, agenda[] }
 *   GET   /:id                                toplanti + KMK m.30 yeter sayi + oy listesi / katilim satirlari
 *   PATCH /:id                                { version, ... } (sayim kaydedilmeden once)
 *   PUT   /:id/attendance/:unitId             { mode: present|proxy|absent, attendeeName?, proxyName? }
 *   POST  /:id/agenda/:itemId/tally           { version, yes, no, abstain } (yeter sayi saglandiysa)
 *   POST  /:id/cancel                         { version, reason }
 *   GET   /:id/attendance-sheet               hazirun cetveli PDF (5 dk imzali link)
 *
 * Tenant izolasyonu: `apartmentId` YALNIZCA JWT claim'inden. `observer` salt okunur.
 */
export function assemblyRoutes({ authenticate, service }: AssemblyRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });

  const ctx = (c: Context<Env>): AssemblyContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => c.json({ items: await service.list(ctx(c)) }));
  r.post('/', requireRole(WRITE_ROLES), async (c) => c.json(await service.create(ctx(c), await readJson(c)), 201));
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.detail(ctx(c), id(c))));
  r.patch('/:id', requireRole(WRITE_ROLES), async (c) => c.json(await service.update(ctx(c), id(c), await readJson(c))));
  r.put('/:id/attendance/:unitId', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.setAttendance(ctx(c), id(c), c.req.param('unitId') ?? '', await readJson(c))),
  );
  r.post('/:id/agenda/:itemId/tally', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.recordTally(ctx(c), id(c), c.req.param('itemId') ?? '', await readJson(c))),
  );
  r.post('/:id/cancel', requireRole(WRITE_ROLES), async (c) => c.json(await service.cancel(ctx(c), id(c), await readJson(c))));
  r.get('/:id/attendance-sheet', requireRole(READ_ROLES), async (c) => c.json(await service.attendanceSheet(ctx(c), id(c))));

  return r;
}
