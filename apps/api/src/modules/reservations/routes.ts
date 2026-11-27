import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { ReservationError } from './errors.js';
import type { ReservationContext, ReservationService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type ReservationRoutesDeps = { authenticate: Authenticator; service: ReservationService };

/** Modul hatasi + ortak hata eslemesi (paylasilan `handleError`'a dokunmadan). */
function onError(err: Error, c: Context) {
  if (err instanceof ReservationError) return c.json({ error: err.code, message: err.message }, err.httpStatus);
  return handleError(err, c);
}

function base(authenticate: Authenticator) {
  const r = new Hono<Env>();
  r.onError(onError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });
  return r;
}

const ctxOf = (c: Context<Env>): ReservationContext => {
  const claims = c.get('claims');
  return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
};
const id = (c: Context<Env>) => c.req.param('id') ?? '';

/**
 * `/api/reservations` - ortak alan rezervasyonu yonetimi (yazma: yonetici + yonetim firmasi; okuma:
 * + denetci).
 *
 *   GET   /facilities                    tum alanlar (pasifler dahil)
 *   POST  /facilities                    { idempotencyKey, name, description?, capacity, openingHours[{day,open,close}],
 *                                          slotMinutes, maxBookingMinutes, advanceDays, maxActivePerUnit, requiresApproval,
 *                                          cancelNoticeHours, blockIds?, feeKurus, incomeAccountId? }
 *   PATCH /facilities/:id                { version, ...alanlar, status?: active|inactive }
 *   GET   /bookings                      ?facilityId=&from=&to=&status=   takvim (Istanbul gunleri, en fazla 62 gun)
 *   GET   /bookings/pending              onay bekleyenler
 *   GET   /bookings/:id
 *   POST  /bookings/:id/approve          { version, note? }     (ucretliyse oturan carisine tahakkuk)
 *   POST  /bookings/:id/reject           { version, reason }
 *   POST  /bookings/:id/cancel           { version, reason }    (tahakkuk varsa ters kayit; yarim iade yeniden denenir)
 */
export function reservationRoutes({ authenticate, service }: ReservationRoutesDeps) {
  const r = base(authenticate);
  r.get('/facilities', requireRole(READ_ROLES), async (c) => c.json(await service.listFacilities(ctxOf(c))));
  r.post('/facilities', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.createFacility(ctxOf(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.patch('/facilities/:id', requireRole(WRITE_ROLES), async (c) => c.json(await service.updateFacility(ctxOf(c), id(c), await readJson(c))));
  r.get('/bookings', requireRole(READ_ROLES), async (c) =>
    c.json(await service.listBookings(ctxOf(c), { facilityId: c.req.query('facilityId'), from: c.req.query('from'), to: c.req.query('to'), status: c.req.query('status') })),
  );
  r.get('/bookings/pending', requireRole(READ_ROLES), async (c) => c.json(await service.pending(ctxOf(c))));
  r.get('/bookings/:id', requireRole(READ_ROLES), async (c) => c.json(await service.getBooking(ctxOf(c), id(c))));
  r.post('/bookings/:id/approve', requireRole(WRITE_ROLES), async (c) => c.json(await service.approve(ctxOf(c), id(c), await readJson(c))));
  r.post('/bookings/:id/reject', requireRole(WRITE_ROLES), async (c) => c.json(await service.reject(ctxOf(c), id(c), await readJson(c))));
  r.post('/bookings/:id/cancel', requireRole(WRITE_ROLES), async (c) => c.json(await service.cancel(ctxOf(c), id(c), await readJson(c))));
  return r;
}

/**
 * `/api/portal/reservations` - sakin (yalnizca `resident`). Daireler guncel uyelik kayitlarindan;
 * baska dairelerin rezervasyonlari yalnizca dolu dilim olarak gorunur (ad / daire yok).
 *
 *   GET   /facilities                         acik alanlar (blok kisiti) + dairelerim
 *   GET   /facilities/:id/availability        ?date=YYYY-MM-DD   dilimler: free | busy | mine | past
 *   GET   /bookings                           dairelerimin yaklasan ve gecmis (90 gun) rezervasyonlari
 *   POST  /bookings                           { idempotencyKey, facilityId, unitId, date, start: 'SS:DD', minutes, partySize?, note? }
 *   POST  /bookings/:id/cancel                { version, reason? }   (alanin iptal suresi dolmadan)
 */
export function reservationPortalRoutes({ authenticate, service }: ReservationRoutesDeps) {
  const r = base(authenticate);
  r.use('*', requireRole(['resident']));
  r.get('/facilities', async (c) => c.json(await service.portalFacilities(ctxOf(c))));
  r.get('/facilities/:id/availability', async (c) => c.json(await service.availability(ctxOf(c), id(c), c.req.query('date'))));
  r.get('/bookings', async (c) => c.json(await service.myBookings(ctxOf(c))));
  r.post('/bookings', async (c) => {
    const result = await service.book(ctxOf(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post('/bookings/:id/cancel', async (c) => c.json(await service.cancel(ctxOf(c), id(c), await readJson(c))));
  return r;
}
