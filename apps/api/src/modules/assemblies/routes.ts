import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { AssemblyContext, AssemblyPortalContext, AssemblyService } from './service.js';

/** Duyuru ve oylamalarla ayni rol listeleri. */
const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type AssemblyRoutesDeps = { authenticate: Authenticator; service: AssemblyService };

function requireApartment(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  };
}

/**
 * `/api/assemblies` - Y1-3 kat malikleri kurulu (genel kurul) hazirligi ve devami.
 *
 *   GET   /                                   toplantilar (en yeni once)
 *   POST  /                                   { kind, scheduledAt, location?, onlineUrl?, firstMeetingId?,
 *                                               secondMeetingPlan?, agenda[{ title, description?, decisionKind?, majority? }] }
 *   GET   /decision-book                      karar defteri PDF (tum kararlar; 5 dk imzali link)
 *   GET   /:id                                toplanti + yeter sayi + oy listesi / katilim + kararlar + cagri denetimi
 *   PATCH /:id                                { version, ... } (oy listesi dondurulmadan once)
 *   POST  /:id/call                           { version, resend?, reason? } cagri e-postasi (ASSEMBLY_CALLED)
 *   PUT   /:id/attendance/:unitId             { mode: present|proxy|absent, attendeeUserId?, proxyUserId? | proxyName? }
 *   POST  /:id/quorum                         { version } yeter sayiyi tutanaga gecir
 *   POST  /:id/agenda/:itemId/tally           { version, yes, no, abstain } | { version, votes: { unitId: yes|no|abstain } },
 *                                             correctionReason? (kayitli karari duzeltme: yeni kayit)
 *   PUT   /:id/minutes                        { version, chair?, clerks?, voteCounters?, notes?, generalNotes? }
 *   POST  /:id/finalize                       { version } tutanagi kesinlestir (held)
 *   POST  /:id/cancel                         { version, reason }
 *   GET   /:id/attendance-sheet               hazirun cetveli PDF (5 dk imzali link)
 *   GET   /:id/minutes                        toplanti tutanagi PDF (kesinlesmediyse taslak)
 *
 * Tenant izolasyonu: `apartmentId` YALNIZCA JWT claim'inden. `observer` salt okunur.
 */
export function assemblyRoutes({ authenticate, service }: AssemblyRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireApartment());

  const ctx = (c: Context<Env>): AssemblyContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => c.json({ items: await service.list(ctx(c)) }));
  r.post('/', requireRole(WRITE_ROLES), async (c) => c.json(await service.create(ctx(c), await readJson(c)), 201));
  r.get('/decision-book', requireRole(READ_ROLES), async (c) => c.json(await service.decisionBook(ctx(c))));
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.detail(ctx(c), id(c))));
  r.patch('/:id', requireRole(WRITE_ROLES), async (c) => c.json(await service.update(ctx(c), id(c), await readJson(c))));
  r.post('/:id/call', requireRole(WRITE_ROLES), async (c) => c.json(await service.sendCall(ctx(c), id(c), await readJson(c))));
  r.put('/:id/attendance/:unitId', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.setAttendance(ctx(c), id(c), c.req.param('unitId') ?? '', await readJson(c))),
  );
  r.post('/:id/quorum', requireRole(WRITE_ROLES), async (c) => c.json(await service.recordQuorum(ctx(c), id(c), await readJson(c))));
  r.post('/:id/agenda/:itemId/tally', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.recordTally(ctx(c), id(c), c.req.param('itemId') ?? '', await readJson(c))),
  );
  r.put('/:id/minutes', requireRole(WRITE_ROLES), async (c) => c.json(await service.saveMinutes(ctx(c), id(c), await readJson(c))));
  r.post('/:id/finalize', requireRole(WRITE_ROLES), async (c) => c.json(await service.finalize(ctx(c), id(c), await readJson(c))));
  r.post('/:id/cancel', requireRole(WRITE_ROLES), async (c) => c.json(await service.cancel(ctx(c), id(c), await readJson(c))));
  r.get('/:id/attendance-sheet', requireRole(READ_ROLES), async (c) => c.json(await service.attendanceSheet(ctx(c), id(c))));
  r.get('/:id/minutes', requireRole(READ_ROLES), async (c) => c.json(await service.minutesPdf(ctx(c), id(c))));

  return r;
}

/**
 * `/api/portal/assemblies` - sakin portali, yalnizca bugun apartmanda aktif MALIK uyeligi olan
 * `resident` (kiraci 403: KMK'da kiraciya kurul hakki tanimlanmaz).
 *
 *   GET /              cagrisi gonderilmis veya tutanagi kesinlesmis toplantilar
 *   GET /:id           tarih, yer / baglanti, gundem, cagri tarihi; kesinlesmisse yeter sayi ozeti ve kararlar
 *   GET /:id/minutes   kesinlesmis tutanak PDF (5 dk imzali link)
 *
 * KVKK: baska maliklerin adi, bolum bazinda katilim ve oy hicbir yanitta yok (yalnizca toplamlar).
 */
export function assemblyPortalRoutes({ authenticate, service }: AssemblyRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['resident']));
  r.use('*', requireApartment());
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const ctx = (c: Context<Env>): AssemblyPortalContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', async (c) => c.json(await service.portalList(ctx(c))));
  r.get('/:id', async (c) => c.json(await service.portalDetail(ctx(c), id(c))));
  r.get('/:id/minutes', async (c) => c.json(await service.portalMinutes(ctx(c), id(c))));

  return r;
}
