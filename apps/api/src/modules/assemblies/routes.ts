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
 *   POST  /:id/cancel                         { version, reason } (cagri gonderildiyse ASSEMBLY_CANCELLED)
 *   POST  /:id/reschedule                     { version, reason, scheduledAt?, location?, onlineUrl? } cagrisi
 *                                             gonderilmis toplantinin ertelenmesi / yer degisikligi (ASSEMBLY_RESCHEDULED)
 *   GET   /:id/attendance-sheet               hazirun cetveli PDF (5 dk imzali link)
 *   GET   /:id/minutes                        toplanti tutanagi PDF (kesinlesmediyse taslak)
 *   GET   /:id/service                        ?filter=unserved  yasal cagri teslim takibi (malik basina, m.29 uyarilari)
 *   POST  /:id/service/:ownerId               { version (ilk kayitta 0), method, sentOn, referenceNo?, status?, statusOn?, note? }
 *   PATCH /:id/service/:ownerId/:seq          { version, status: delivered|returned, statusOn, note? } | { version, void: true, reason }
 *
 *   Yazili riza (toplanti disinda; KMK m.19/2, README "Hukuki yorum"):
 *   GET   /consents                           talepler
 *   POST  /consents                           { title, description?, decisionKind, majority? } (oy listesi bugun dondurulur)
 *   GET   /consents/:cid                      talep + bolum bazinda gecerli kayit + sonuc
 *   PUT   /consents/:cid/units/:unitId        { choice: consent|object, signedOn, method, methodNote?, signerUserId?,
 *                                               document?: { uploadId, fileName }, correctionReason? }  degismez kayit
 *   POST  /consents/:cid/close                { version }  sonucu kesinlestir
 *   POST  /consents/:cid/cancel               { version, reason }
 *   GET   /consents/:cid/pdf                  sonuc tutanagi PDF (5 dk imzali link)
 *   GET   /consents/:cid/units/:unitId/document  ?seq=  riza belgesi (5 dk imzali link)
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

  // Yazili riza (`/:id`'den once).
  const cid = (c: Context<Env>) => c.req.param('cid') ?? '';
  const unit = (c: Context<Env>) => c.req.param('unitId') ?? '';
  r.get('/consents', requireRole(READ_ROLES), async (c) => c.json(await service.listConsents(ctx(c))));
  r.post('/consents', requireRole(WRITE_ROLES), async (c) => c.json(await service.createConsent(ctx(c), await readJson(c)), 201));
  r.get('/consents/:cid', requireRole(READ_ROLES), async (c) => c.json(await service.consentDetail(ctx(c), cid(c))));
  r.put('/consents/:cid/units/:unitId', requireRole(WRITE_ROLES), async (c) => c.json(await service.recordConsent(ctx(c), cid(c), unit(c), await readJson(c))));
  r.post('/consents/:cid/close', requireRole(WRITE_ROLES), async (c) => c.json(await service.closeConsent(ctx(c), cid(c), await readJson(c))));
  r.post('/consents/:cid/cancel', requireRole(WRITE_ROLES), async (c) => c.json(await service.cancelConsent(ctx(c), cid(c), await readJson(c))));
  r.get('/consents/:cid/pdf', requireRole(READ_ROLES), async (c) => c.json(await service.consentPdf(ctx(c), cid(c))));
  r.get('/consents/:cid/units/:unitId/document', requireRole(READ_ROLES), async (c) => c.json(await service.consentDocument(ctx(c), cid(c), unit(c), c.req.query('seq'))));

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
  r.post('/:id/reschedule', requireRole(WRITE_ROLES), async (c) => c.json(await service.reschedule(ctx(c), id(c), await readJson(c))));
  r.get('/:id/attendance-sheet', requireRole(READ_ROLES), async (c) => c.json(await service.attendanceSheet(ctx(c), id(c))));
  r.get('/:id/minutes', requireRole(READ_ROLES), async (c) => c.json(await service.minutesPdf(ctx(c), id(c))));
  r.get('/:id/service', requireRole(READ_ROLES), async (c) => c.json(await service.serviceReport(ctx(c), id(c), { filter: c.req.query('filter') })));
  r.post('/:id/service/:ownerId', requireRole(WRITE_ROLES), async (c) => c.json(await service.addServiceAttempt(ctx(c), id(c), c.req.param('ownerId') ?? '', await readJson(c)), 201));
  r.patch('/:id/service/:ownerId/:seq', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.updateServiceAttempt(ctx(c), id(c), c.req.param('ownerId') ?? '', c.req.param('seq') ?? '', await readJson(c))),
  );

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
