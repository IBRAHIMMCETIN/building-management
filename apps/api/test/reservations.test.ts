/**
 * Ortak alan rezervasyonu: alan tanimi, dilim dogrulamasi (acilis saatleri, izgara, sure), kosullu
 * yazimla cakisma (es zamanli dahil), daire basina aktif siniri, rezervasyon penceresi, onay akisi,
 * iptal suresi, Finans uzerinden ucret tahakkuku + ters kayit, KVKK (sakin baska daireyi gormez),
 * kiraci izolasyonu, roller ve DynamoDB yazim bicimi.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Block, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { FinanceError, type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { ReservationError } from '../src/modules/reservations/errors.js';
import { createReservationRepository } from '../src/modules/reservations/repository.js';
import { type ReservationContext, type ReservationFinance, createReservationService } from '../src/modules/reservations/service.js';
import { bookingTimeError, istanbulInstant, istanbulMinutes, lockSlotsOf, slotGrid, weekdayOf } from '../src/modules/reservations/time.js';
import type { Booking } from '../src/modules/reservations/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeReservationRepo } from './fakes/reservationRepo.js';

const APT = 'apt-1';
/** Cuma 27.11.2026 10:00 (Istanbul). */
const T0 = '2026-11-27T07:00:00.000Z';
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, open: '09:00', close: '22:00' }));

const audit = { createdAt: T0, createdBy: 'seed', updatedAt: T0, updatedBy: 'seed', version: 1 };
const unit = (id: string, blockId: string, apt = APT) =>
  ({ PK: `APT#${apt}`, SK: `UNIT#${id}`, entityType: 'UNIT', unitId: id, siteId: apt, blockId, number: id.toUpperCase(), type: 'flat', grossAreaTenthsM2: 1000, exemptions: [], status: 'active', ...audit }) as unknown as Unit;
const member = (userId: string, unitId: string, relation: 'owner' | 'tenant', apt = APT) =>
  ({ userId, unitId, apartmentId: apt, relation, residesInUnit: true, status: 'active', startDate: '2026-01-01' }) as unknown as UnitMembership;

const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  firm: { apartmentId: APT, userId: 'firm', role: 'management_company' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
  staff: { apartmentId: APT, userId: 'staff', role: 'building_staff' },
  a: { apartmentId: APT, userId: 'res-a', role: 'resident' },
  a2: { apartmentId: APT, userId: 'res-a2', role: 'resident' },
  b: { apartmentId: APT, userId: 'res-b', role: 'resident' },
  other: { apartmentId: 'apt-2', userId: 'mgr-2', role: 'apartment_manager' },
} satisfies Record<string, ReservationContext>;

function world(opts: { finance?: (f: ReservationFinance) => ReservationFinance } = {}) {
  let now = new Date(T0);
  const fin = createFakeFinanceRepo(APT);
  // Rezervasyon ve finans ayni tabloyu paylasir (onay + tahakkuk atomik).
  const fake = createFakeReservationRepo(fin.docs as unknown as Map<string, Record<string, unknown> & { PK: string; SK: string }>);
  const units = [unit('u1', 'b1'), unit('u2', 'b2'), unit('u3', 'b1')];
  const blocks = [
    { blockId: 'b1', name: 'A Blok', status: 'active' },
    { blockId: 'b2', name: 'B Blok', status: 'active' },
  ] as unknown as Block[];
  const memberships = [member('res-a', 'u1', 'tenant'), member('res-a2', 'u1', 'owner'), member('res-b', 'u2', 'owner'), member('res-b', 'u3', 'owner')];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits' | 'getBlock'> = {
    getUnit: async (apt, id) => units.find((u) => u.unitId === id && u.siteId === apt),
    listUnits: async (apt) => units.filter((u) => u.siteId === apt),
    getBlock: async (_a, id) => blocks.find((b) => b.blockId === id),
  };
  let n = 0;
  const realFinance = createFinanceService({ repository: fin.repo, core, now: () => now, newId: () => `fin-${String(++n).padStart(4, '0')}` });
  const finance = opts.finance ? opts.finance(realFinance) : realFinance;
  const service = createReservationService({
    repo: fake.repo,
    core,
    memberships: { listMemberships: async (apt, userId) => memberships.filter((m) => m.userId === userId && m.apartmentId === apt) },
    finance,
    now: () => now,
    newId: () => `id${String(++n).padStart(10, '0')}`,
  });
  let k = 0;
  const facility = async (extra: Record<string, unknown> = {}) =>
    (
      await service.createFacility(ctxs.mgr, {
        idempotencyKey: `fac-key-${++k}`,
        name: 'Toplantı Salonu',
        capacity: 20,
        openingHours: ALL_WEEK,
        slotMinutes: 60,
        maxBookingMinutes: 180,
        advanceDays: 14,
        maxActivePerUnit: 2,
        requiresApproval: false,
        cancelNoticeHours: 24,
        feeKurus: 0,
        ...extra,
      })
    ).facility;
  const book = (ctx: ReservationContext, facilityId: string, extra: Record<string, unknown> = {}) =>
    service.book(ctx, { idempotencyKey: `bk-${++k}`, facilityId, unitId: ctx === ctxs.b ? 'u2' : 'u1', date: '2026-11-29', start: '10:00', minutes: 60, ...extra });
  const stored = (id: string) => structuredClone(fin.docs.get(`APT#${APT}|RBOOK#${id}`)) as unknown as Booking;
  const fctx: FinanceContext = { apartmentId: APT, userId: 'mgr' };
  return { fake, fin, service, finance: realFinance, fctx, facility, book, stored, setNow: (iso: string) => (now = new Date(iso)) };
}

const reasonOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

// ---------------------------------------------------------------------------
// Saf saat yardimcilari
// ---------------------------------------------------------------------------

describe('saat yardimcilari (Europe/Istanbul)', () => {
  it('duvar saati <-> UTC, hafta gunu, gun sonu 24:00', () => {
    expect(istanbulInstant('2026-11-29', 600)).toBe('2026-11-29T07:00:00.000Z');
    expect(istanbulInstant('2026-11-29', 1440)).toBe('2026-11-29T21:00:00.000Z');
    expect(istanbulMinutes('2026-11-29T07:30:00.000Z')).toBe(630);
    expect(istanbulMinutes('2026-11-29T21:00:00.000Z')).toBe(0);
    expect(weekdayOf('2026-11-27')).toBe(5);
    expect(weekdayOf('2026-11-29')).toBe(7);
  });

  it('izgara ve sure kurallari; kilit dilimleri 30 dakikalik', () => {
    const f = { openingHours: [{ day: 7 as const, open: '09:00', close: '12:30' }], slotMinutes: 60 as const, maxBookingMinutes: 120 };
    expect(slotGrid(f, '2026-11-29').map((s) => s.start)).toEqual([540, 600, 660]);
    expect(slotGrid(f, '2026-11-30')).toEqual([]);
    expect(bookingTimeError(f, '2026-11-29', 540, 120)).toBeUndefined();
    expect(bookingTimeError(f, '2026-11-30', 540, 60)).toMatch(/kapalı/);
    expect(bookingTimeError(f, '2026-11-29', 480, 60)).toMatch(/açılış saatleri/);
    expect(bookingTimeError(f, '2026-11-29', 720, 60)).toMatch(/açılış saatleri/);
    expect(bookingTimeError(f, '2026-11-29', 570, 60)).toMatch(/dilimlere/);
    expect(bookingTimeError(f, '2026-11-29', 540, 90)).toMatch(/katı/);
    expect(bookingTimeError(f, '2026-11-29', 540, 180)).toMatch(/En fazla 120/);
    expect(lockSlotsOf('2026-11-29T07:00:00.000Z', '2026-11-29T08:00:00.000Z')).toEqual(['2026-11-29T07:00:00.000Z', '2026-11-29T07:30:00.000Z']);
  });
});

// ---------------------------------------------------------------------------
// Alan tanimi
// ---------------------------------------------------------------------------

describe('ortak alan tanimi', () => {
  it('yonetici olusturur (idempotent, denetimli); sakin, denetci ve gorevli olusturamaz', async () => {
    const w = world();
    const body = { idempotencyKey: 'same-fac', name: 'Havuz', capacity: 30, openingHours: ALL_WEEK, slotMinutes: 120, maxBookingMinutes: 240 };
    const a = await w.service.createFacility(ctxs.mgr, body);
    expect(a).toMatchObject({ replayed: false, facility: { name: 'Havuz', status: 'active', advanceDays: 30, maxActivePerUnit: 1, requiresApproval: false, cancelNoticeHours: 24, feeKurus: 0, version: 1 } });
    expect(await w.service.createFacility(ctxs.mgr, body)).toMatchObject({ replayed: true, facility: { facilityId: a.facility.facilityId } });
    await expect(w.service.createFacility(ctxs.mgr, { ...body, name: 'Başka' })).rejects.toMatchObject({ code: 'conflict' });
    expect(w.fake.audits.map((x) => x.action)).toEqual(['reservation.facility_create']);
    for (const ctx of [ctxs.a, ctxs.observer]) await expect(w.service.createFacility(ctx, { ...body, idempotencyKey: 'x1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.listFacilities(ctxs.staff)).rejects.toBeInstanceOf(ReservationError);
    expect((await w.service.listFacilities(ctxs.observer)).items).toHaveLength(1);
  });

  it('dogrulama: saatler :00/:30, kapanis > acilis, dilim uzunlugu, en uzun sure, blok, ucret', async () => {
    const w = world();
    const make = (extra: Record<string, unknown>) =>
      w.service.createFacility(ctxs.mgr, { idempotencyKey: `v-${Math.random().toString(36).slice(2, 10)}`, name: 'Salon', capacity: 10, openingHours: ALL_WEEK, slotMinutes: 60, ...extra });
    await expect(make({ openingHours: [{ day: 1, open: '09:15', close: '12:00' }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ openingHours: [{ day: 1, open: '12:00', close: '09:00' }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ openingHours: [{ day: 1, open: '09:00', close: '10:00' }, { day: 1, open: '11:00', close: '12:00' }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ openingHours: [{ day: 8, open: '09:00', close: '10:00' }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ slotMinutes: 45 })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ maxBookingMinutes: 90 })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ maxBookingMinutes: 1440 })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ blockIds: ['b9'] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(make({ feeKurus: 12.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ feeKurus: 5000, incomeAccountId: 'income-late-fee' })).rejects.toBeInstanceOf(ValidationError);
    expect((await make({ openingHours: [{ day: 6, open: '10:00', close: '24:00' }], blockIds: ['b2', 'b1', 'b2'], feeKurus: 5000 })).facility).toMatchObject({ blockIds: ['b1', 'b2'], feeKurus: 5000 });
    // Finans yoksa ucretli alan tanimlanamaz (yalnizca ucretsiz).
    const noFinance = createReservationService({ repo: w.fake.repo, core: { getUnit: async () => undefined, getBlock: async () => undefined }, memberships: { listMemberships: async () => [] }, finance: undefined, now: () => new Date(T0) });
    await expect(noFinance.createFacility(ctxs.mgr, { idempotencyKey: 'nf-1', name: 'Salon', capacity: 5, openingHours: ALL_WEEK, slotMinutes: 60, feeKurus: 100 })).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('guncelleme surumlu ve denetimli; pasife alinan alan sakine gorunmez ve rezerve edilemez', async () => {
    const w = world();
    const f = await w.facility();
    await expect(w.service.updateFacility(ctxs.mgr, f.facilityId, { version: 9, name: 'Yeni' })).rejects.toMatchObject({ code: 'conflict' });
    const u = (await w.service.updateFacility(ctxs.mgr, f.facilityId, { version: 1, name: 'Çok Amaçlı Salon', capacity: 40 })).facility;
    expect(u).toMatchObject({ name: 'Çok Amaçlı Salon', capacity: 40, slotMinutes: 60, version: 2 });
    const off = (await w.service.updateFacility(ctxs.mgr, f.facilityId, { version: 2, status: 'inactive' })).facility;
    expect(off.status).toBe('inactive');
    expect(w.fake.audits.map((x) => x.action)).toEqual(['reservation.facility_create', 'reservation.facility_update', 'reservation.facility_deactivate']);
    expect(w.fake.audits[1]?.details).toMatchObject({ fields: ['name', 'capacity'] });
    expect((await w.service.portalFacilities(ctxs.a)).items).toEqual([]);
    await expect(w.book(ctxs.a, f.facilityId)).rejects.toMatchObject({ code: 'not_found' });
    // Silinmez: yonetim listesinde pasif olarak kalir.
    expect((await w.service.listFacilities(ctxs.mgr)).items[0]).toMatchObject({ status: 'inactive' });
  });

  it('blok kisiti: yalnizca o blogun daireleri gorur ve rezerve eder', async () => {
    const w = world();
    const f = await w.facility({ blockIds: ['b2'] });
    expect((await w.service.portalFacilities(ctxs.a)).items).toEqual([]);
    const forB = await w.service.portalFacilities(ctxs.b);
    expect(forB.items.map((i) => ({ id: i.facilityId, unitIds: i.unitIds }))).toEqual([{ id: f.facilityId, unitIds: ['u2'] }]);
    expect(forB.items[0]).not.toHaveProperty('createdBy');
    expect(forB.units.map((u) => u.label)).toEqual(['A Blok · U3', 'B Blok · U2']);
    await expect(w.book(ctxs.a, f.facilityId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.book(ctxs.b, f.facilityId, { unitId: 'u3' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.book(ctxs.b, f.facilityId)).booking.status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// Rezervasyon kurallari
// ---------------------------------------------------------------------------

describe('rezervasyon: dilim dogrulamasi ve pencere', () => {
  it('acilis saati, izgara, sure, gecmis saat, rezervasyon penceresi, kisi sayisi, uyelik', async () => {
    const w = world();
    const f = await w.facility({ openingHours: [5, 6, 7].map((day) => ({ day, open: '09:00', close: '22:00' })) });
    const code = (extra: Record<string, unknown>, ctx: ReservationContext = ctxs.a) => reasonOf(w.book(ctx, f.facilityId, extra));
    expect(await code({ date: '2026-11-30' })).toBe('unprocessable'); // pazartesi kapali
    expect(await code({ start: '08:00' })).toBe('unprocessable');
    expect(await code({ start: '21:30' })).toBe('unprocessable');
    expect(await code({ start: '10:30' })).toBe('unprocessable');
    expect(await code({ minutes: 90 })).toBe('unprocessable');
    expect(await code({ minutes: 240 })).toBe('unprocessable');
    expect(await code({ date: '2026-11-27', start: '09:00' })).toBe('unprocessable'); // gecmis
    expect(await code({ date: '2026-12-12' })).toBe('unprocessable'); // 15 gun sonra (pencere 14)
    expect(await code({ partySize: 21 })).toBe('error');
    expect(await code({ unitId: 'u2' })).toBe('forbidden');
    expect(await code({ start: '25:00' })).toBe('error');
    // Pencerenin son gunu ve bugun ileri saat gecerli.
    expect(await code({ date: '2026-12-11' })).toBe('ok');
    expect(await code({ date: '2026-11-27', start: '11:00', minutes: 180 })).toBe('ok');
  });

  it('olusturma: kilitler, indeksler, denetim; idempotent tekrar ayni rezervasyon', async () => {
    const w = world();
    const f = await w.facility();
    const body = { idempotencyKey: 'same-booking', facilityId: f.facilityId, unitId: 'u1', date: '2026-11-29', start: '10:00', minutes: 120, partySize: 6, note: 'Doğum günü' };
    const r = await w.service.book(ctxs.a, body);
    expect(r).toMatchObject({ replayed: false, booking: { status: 'confirmed', startTime: '10:00', endTime: '12:00', minutes: 120, start: '2026-11-29T07:00:00.000Z', partySize: 6, mine: true, canCancel: true } });
    const keys = [...w.fin.docs.keys()];
    expect(keys.filter((x) => x.includes('|RSLOT#'))).toHaveLength(4);
    expect(keys.filter((x) => x.includes('|RBFAC#') || x.includes('|RBUNIT#'))).toHaveLength(2);
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'reservation.book', details: { unitId: 'u1', start: '10:00', minutes: 120, status: 'confirmed' } });
    expect(await w.service.book(ctxs.a, body)).toMatchObject({ replayed: true, booking: { bookingId: r.booking.bookingId } });
    await expect(w.service.book(ctxs.a, { ...body, minutes: 60 })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('cakisma: dilim kilidi (kosullu yazim)', () => {
  it('ayni ya da kesisen dilim ikinci daireye kapali; bitisik dilim serbest', async () => {
    const w = world();
    const f = await w.facility();
    await w.book(ctxs.a, f.facilityId, { start: '10:00', minutes: 120 });
    expect(await reasonOf(w.book(ctxs.b, f.facilityId, { start: '10:00' }))).toBe('slot_taken');
    expect(await reasonOf(w.book(ctxs.b, f.facilityId, { start: '11:00' }))).toBe('slot_taken');
    expect(await reasonOf(w.book(ctxs.b, f.facilityId, { start: '09:00', minutes: 120 }))).toBe('slot_taken');
    expect(await reasonOf(w.book(ctxs.b, f.facilityId, { start: '12:00' }))).toBe('ok');
    // Baska alanin ayni saati etkilenmez.
    const g = await w.facility({ name: 'Tenis Kortu' });
    expect(await reasonOf(w.book(ctxs.b, g.facilityId, { start: '10:00' }))).toBe('ok');
  });

  it('es zamanli iki istek: on kontroller ikisinde de gecer, kosullu yazim yalnizca birini kabul eder', async () => {
    const w = world();
    const f = await w.facility();
    // A'nin kontrolleri bitti, yazimindan hemen once B ayni dilimi aldi.
    w.fake.beforeNextWrite(async () => {
      await w.book(ctxs.b, f.facilityId, { start: '10:00' });
    });
    await expect(w.book(ctxs.a, f.facilityId, { start: '10:00' })).rejects.toMatchObject({ code: 'slot_taken' });
    const held = [...w.fin.docs.values()].filter((d) => d.entityType === 'RESERVATION_SLOT' && d.state === 'held');
    expect(held.map((s) => s.unitId)).toEqual(['u2', 'u2']);
    expect([...w.fin.docs.values()].filter((d) => d.entityType === 'RESERVATION_BOOKING')).toHaveLength(1);
  });

  it('iptal edilen rezervasyonun dilimleri yeniden rezerve edilebilir (silme yok, released)', async () => {
    const w = world();
    const f = await w.facility();
    const { booking } = await w.book(ctxs.a, f.facilityId);
    await w.service.cancel(ctxs.a, booking.bookingId, { version: booking.version });
    expect([...w.fin.docs.values()].filter((d) => d.entityType === 'RESERVATION_SLOT').map((s) => s.state)).toEqual(['released', 'released']);
    expect((await w.book(ctxs.b, f.facilityId)).booking.status).toBe('confirmed');
  });
});

describe('daire basina aktif rezervasyon siniri', () => {
  it('sinir dolunca reddedilir; ayni dairenin diger uyesi de sayilir; iptal ve bitis yer acar', async () => {
    const w = world();
    const f = await w.facility({ maxActivePerUnit: 2 });
    const first = (await w.book(ctxs.a, f.facilityId, { start: '10:00' })).booking;
    await w.book(ctxs.a2, f.facilityId, { start: '12:00' });
    expect(await reasonOf(w.book(ctxs.a, f.facilityId, { start: '14:00' }))).toBe('unprocessable');
    // Baska daire etkilenmez.
    expect(await reasonOf(w.book(ctxs.b, f.facilityId, { start: '14:00' }))).toBe('ok');
    await w.service.cancel(ctxs.a, first.bookingId, { version: first.version });
    expect(await reasonOf(w.book(ctxs.a, f.facilityId, { start: '16:00' }))).toBe('ok');
    // Rezervasyonlar bitince aktif sayilmaz.
    w.setNow('2026-11-29T15:00:00.000Z');
    expect(await reasonOf(w.book(ctxs.a, f.facilityId, { start: '19:00' }))).toBe('ok');
  });

  it('es zamanli istekler sinir asamaz: daire sayaci catisirsa yeniden sayilir', async () => {
    const w = world();
    const f = await w.facility({ maxActivePerUnit: 1 });
    w.fake.beforeNextWrite(async () => {
      await w.book(ctxs.a2, f.facilityId, { start: '15:00' });
    });
    await expect(w.book(ctxs.a, f.facilityId, { start: '10:00' })).rejects.toMatchObject({ code: 'unprocessable' });
    expect([...w.fin.docs.values()].filter((d) => d.entityType === 'RESERVATION_BOOKING').map((b) => b.createdBy)).toEqual(['res-a2']);
  });
});

describe('onay akisi', () => {
  it('onay gerektiren alan: pending -> onay (denetim) | ret (gerekce, dilimler serbest)', async () => {
    const w = world();
    const f = await w.facility({ requiresApproval: true });
    const p1 = (await w.book(ctxs.a, f.facilityId, { start: '10:00' })).booking;
    expect(p1.status).toBe('pending');
    // Bekleyen rezervasyon da dilimi tutar.
    expect(await reasonOf(w.book(ctxs.b, f.facilityId, { start: '10:00' }))).toBe('slot_taken');
    const queue = await w.service.pending(ctxs.observer);
    expect(queue.items.map((b) => b.bookingId)).toEqual([p1.bookingId]);
    await expect(w.service.approve(ctxs.observer, p1.bookingId, { version: 1 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.approve(ctxs.mgr, p1.bookingId, { version: 7 })).rejects.toMatchObject({ code: 'conflict' });
    const ok = (await w.service.approve(ctxs.mgr, p1.bookingId, { version: 1, note: 'İyi eğlenceler' })).booking;
    expect(ok).toMatchObject({ status: 'confirmed', decidedBy: 'mgr', decisionNote: 'İyi eğlenceler', version: 2 });
    await expect(w.service.approve(ctxs.mgr, p1.bookingId, { version: 2 })).rejects.toMatchObject({ code: 'invalid_state' });

    const p2 = (await w.book(ctxs.b, f.facilityId, { start: '13:00' })).booking;
    await expect(w.service.reject(ctxs.mgr, p2.bookingId, { version: 1, reason: 'x' })).rejects.toBeInstanceOf(ValidationError);
    expect((await w.service.reject(ctxs.firm, p2.bookingId, { version: 1, reason: 'Bakım çalışması var' })).booking.status).toBe('rejected');
    expect((await w.service.myBookings(ctxs.b)).history[0]).toMatchObject({ status: 'rejected', decisionNote: 'Bakım çalışması var' });
    expect(await reasonOf(w.book(ctxs.a2, f.facilityId, { start: '13:00' }))).toBe('ok');
    expect(w.fake.audits.map((a) => a.action)).toEqual(['reservation.facility_create', 'reservation.book', 'reservation.approve', 'reservation.book', 'reservation.reject', 'reservation.book']);
    expect(w.fake.audits[4]).toMatchObject({ reason: 'Bakım çalışması var' });
  });

  it('baslangici gecmis bekleyen rezervasyon onaylanamaz ve kuyrukta gorunmez', async () => {
    const w = world();
    const f = await w.facility({ requiresApproval: true });
    const p = (await w.book(ctxs.a, f.facilityId, { start: '10:00' })).booking;
    w.setNow('2026-11-29T07:30:00.000Z');
    expect((await w.service.pending(ctxs.mgr)).items).toEqual([]);
    await expect(w.service.approve(ctxs.mgr, p.bookingId, { version: 1 })).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await w.service.getBooking(ctxs.mgr, p.bookingId)).booking).toMatchObject({ expired: true, canApprove: false });
  });
});

describe('iptal', () => {
  it('sakin: iptal suresi dolmadan; yonetici: gerekceyle her zaman; baska daire 404; denetci yapamaz', async () => {
    const w = world();
    const f = await w.facility({ cancelNoticeHours: 24 });
    // Yarin 09:00 -> 23 saat kala: sakin iptal edemez.
    const soon = (await w.book(ctxs.a, f.facilityId, { date: '2026-11-28', start: '09:00' })).booking;
    expect(soon.canCancel).toBe(false);
    await expect(w.service.cancel(ctxs.a, soon.bookingId, { version: 1 })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.service.cancel(ctxs.b, soon.bookingId, { version: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.cancel(ctxs.observer, soon.bookingId, { version: 1, reason: 'Gerekçe' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.cancel(ctxs.mgr, soon.bookingId, { version: 1 })).rejects.toBeInstanceOf(ValidationError);
    const byMgr = (await w.service.cancel(ctxs.mgr, soon.bookingId, { version: 1, reason: 'Elektrik kesintisi' })).booking;
    expect(byMgr).toMatchObject({ status: 'cancelled', cancelKind: 'manager', cancelReason: 'Elektrik kesintisi' });
    expect((await w.service.myBookings(ctxs.a)).history[0]).toMatchObject({ status: 'cancelled', cancelKind: 'manager', cancelReason: 'Elektrik kesintisi' });
    // 2 gun sonrasi: sakin iptal eder (ayni dairenin diger uyesi de).
    const later = (await w.book(ctxs.a, f.facilityId, { date: '2026-11-29', start: '18:00' })).booking;
    expect((await w.service.cancel(ctxs.a2, later.bookingId, { version: 1 })).booking).toMatchObject({ status: 'cancelled', cancelKind: 'resident', mine: false });
    await expect(w.service.cancel(ctxs.a, later.bookingId, { version: 2 })).rejects.toMatchObject({ code: 'invalid_state' });
    expect(w.fake.audits.filter((a) => a.action === 'reservation.cancel').map((a) => a.reason ?? null)).toEqual(['Elektrik kesintisi', null]);
  });
});

describe('ucret: Finans tahakkuku ve ters kayit', () => {
  it('onaysiz ucretli alan: oturan carisine tahakkuk ile atomik onay; iptalde ters kayit', async () => {
    const w = world();
    const f = await w.facility({ feeKurus: 15_000 });
    const r = await w.book(ctxs.a, f.facilityId, { start: '10:00' });
    expect(r.booking).toMatchObject({ status: 'confirmed', fee: { amount: 15_000, status: 'charged' } });
    expect(r.booking.fee).not.toHaveProperty('transactionId');
    const stored = w.stored(r.booking.bookingId);
    const tx = w.fin.transactions.get(`${APT}|${stored.fee.transactionId}`);
    expect(tx).toMatchObject({ kind: 'dues_charge', reference: `RSV:${r.booking.bookingId}`, dueDate: '2026-11-29', totalAmount: 15_000 });
    expect(tx?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: 'recv-u1-occupant', side: 'debit', amount: 15_000, liableParty: 'occupant' }), expect.objectContaining({ accountId: 'income-dues', side: 'credit' })]));
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(15_000);
    // Defter denetim kaydi rezervasyon ayrintisini tasir.
    expect(w.fin.batches.at(-1)?.audit?.details).toMatchObject({ reservation: { action: 'reservation.auto_confirm', bookingId: r.booking.bookingId } });

    const c = await w.service.cancel(ctxs.a, r.booking.bookingId, { version: r.booking.version });
    expect(c.booking).toMatchObject({ status: 'cancelled', fee: { status: 'reversed' } });
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
    expect(await w.finance.isReversed(w.fctx, stored.fee.transactionId as string)).toBe(true);
    expect(w.fin.trialBalance()).toBe(0);
  });

  it('onayli ucretli alan: bekleyende tahakkuk yok; onayda tahakkuk; retde hic yok; gelir hesabi secilebilir', async () => {
    const w = world();
    const income = await w.finance.createAccount(w.fctx, { type: 'income', name: 'Ortak Alan Gelirleri' });
    const f = await w.facility({ feeKurus: 20_000, requiresApproval: true, incomeAccountId: income.accountId });
    const p = (await w.book(ctxs.a, f.facilityId, { start: '10:00' })).booking;
    expect(p.fee).toEqual({ amount: 20_000, status: 'pending' });
    expect(w.fin.transactions.size).toBe(0);
    const ok = (await w.service.approve(ctxs.mgr, p.bookingId, { version: 1 })).booking;
    expect(ok).toMatchObject({ status: 'confirmed', fee: { status: 'charged', incomeAccountId: income.accountId } });
    expect(w.fin.balanceOf(income.accountId)).toBe(-20_000);
    expect(w.fin.batches.at(-1)?.audit?.details).toMatchObject({ reservation: { action: 'reservation.approve' } });

    const q = (await w.book(ctxs.b, f.facilityId, { start: '13:00' })).booking;
    expect((await w.service.reject(ctxs.mgr, q.bookingId, { version: 1, reason: 'Uygun değil' })).booking.fee.status).toBe('void');
    expect(w.fin.transactions.size).toBe(1);
  });

  it('tahakkuk yapilamazsa rezervasyon yonetici onayina duser; ters kayit yapilamazsa yeniden denenir', async () => {
    let failCharge = true;
    let failReverse = true;
    const w = world({
      finance: (real) => ({
        ...real,
        chargeUnit: async (...args: Parameters<ReservationFinance['chargeUnit']>) => {
          if (failCharge) {
            failCharge = false;
            throw new FinanceError('unprocessable', 'Bagimsiz bolum aktif degil');
          }
          return real.chargeUnit(...args);
        },
        reverseTransaction: async (...args: Parameters<ReservationFinance['reverseTransaction']>) => {
          if (failReverse) {
            failReverse = false;
            throw new FinanceError('unprocessable', 'Bu kalem bir yapılandırma planına bağlı');
          }
          return real.reverseTransaction(...args);
        },
      }),
    });
    const f = await w.facility({ feeKurus: 10_000 });
    const r = await w.book(ctxs.a, f.facilityId, { start: '10:00' });
    expect(r).toMatchObject({ booking: { status: 'pending', fee: { status: 'pending' } }, warning: expect.stringMatching(/yönetici onayına/) });
    const queued = (await w.service.pending(ctxs.mgr)).items[0];
    expect(queued).toMatchObject({ bookingId: r.booking.bookingId, autoConfirm: false, fee: { error: expect.stringMatching(/tahakkuk edilemedi/) } });
    const ok = (await w.service.approve(ctxs.mgr, r.booking.bookingId, { version: queued?.version })).booking;
    expect(ok).toMatchObject({ status: 'confirmed', fee: { status: 'charged' } });
    expect(ok.fee).not.toHaveProperty('error');

    const c1 = (await w.service.cancel(ctxs.mgr, ok.bookingId, { version: ok.version, reason: 'Havuz bakımda' })).booking;
    expect(c1).toMatchObject({ status: 'cancelled', fee: { status: 'reversal_pending', error: expect.stringMatching(/ters kayıt/) }, canRetryReversal: true });
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(10_000);
    await expect(w.service.cancel(ctxs.a, ok.bookingId, { version: c1.version })).rejects.toMatchObject({ code: 'invalid_state' });
    const c2 = (await w.service.cancel(ctxs.mgr, ok.bookingId, { version: c1.version, reason: 'Havuz bakımda' })).booking;
    expect(c2.fee.status).toBe('reversed');
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
  });
});

describe('KVKK ve kiraci izolasyonu', () => {
  it('sakin baska dairenin dilimini yalnizca dolu gorur; listesinde baska daire yok', async () => {
    const w = world();
    const f = await w.facility();
    await w.book(ctxs.a, f.facilityId, { start: '10:00', minutes: 120 });
    await w.book(ctxs.b, f.facilityId, { start: '14:00' });
    const forB = await w.service.availability(ctxs.b, f.facilityId, '2026-11-29');
    const state = Object.fromEntries(forB.slots.map((s) => [s.start, s.state]));
    expect(state).toMatchObject({ '09:00': 'free', '10:00': 'busy', '11:00': 'busy', '12:00': 'free', '14:00': 'mine' });
    expect(JSON.stringify(forB)).not.toMatch(/u1|res-a|bookingId/);
    expect(forB).toMatchObject({ open: true, bookable: true, window: { open: '09:00', close: '22:00' }, lastBookableDate: '2026-12-11' });
    const forA = await w.service.availability(ctxs.a, f.facilityId, '2026-11-29');
    expect(forA.slots.find((s) => s.start === '10:00')?.state).toBe('mine');
    expect((await w.service.availability(ctxs.a, f.facilityId, '2026-11-27')).slots.find((s) => s.start === '09:00')?.state).toBe('past');
    const mine = await w.service.myBookings(ctxs.b);
    expect(mine.upcoming.map((b) => b.unitId)).toEqual(['u2']);
    expect(mine.upcoming[0]).not.toHaveProperty('createdBy');
    // Yonetim tum daireleri gorur.
    expect((await w.service.listBookings(ctxs.mgr, { from: '2026-11-29', to: '2026-11-29' })).items.map((b) => b.unitId)).toEqual(['u1', 'u2']);
    await expect(w.service.availability(ctxs.mgr, f.facilityId, '2026-11-29')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('baska apartmanin yoneticisi kaydi goremez ve degistiremez', async () => {
    const w = world();
    const f = await w.facility();
    const { booking } = await w.book(ctxs.a, f.facilityId);
    await expect(w.service.getBooking(ctxs.other, booking.bookingId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.cancel(ctxs.other, booking.bookingId, { version: 1, reason: 'Deneme' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.updateFacility(ctxs.other, f.facilityId, { version: 1, name: 'X Salon' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.listFacilities(ctxs.other)).items).toEqual([]);
    expect((await w.service.listBookings(ctxs.other, { facilityId: f.facilityId, from: '2026-11-29', to: '2026-11-29' })).items).toEqual([]);
  });

  it('takvim araligi sinirli ve dogrulanir', async () => {
    const w = world();
    await expect(w.service.listBookings(ctxs.mgr, { from: '2026-11-01', to: '2027-01-15' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.listBookings(ctxs.mgr, { from: '2026-11-10', to: '2026-11-01' })).rejects.toBeInstanceOf(ValidationError);
    expect(await w.service.listBookings(ctxs.mgr)).toMatchObject({ from: '2026-11-27', to: '2026-12-03', items: [] });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe('API uclari', () => {
  function api() {
    const w = world();
    const app = createApp({
      version: 'test',
      reservationService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, ctx: ReservationContext | { userId: string; role: string; apartmentId?: string }, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify(ctx), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    return { w, call };
  }
  const facilityBody = { idempotencyKey: 'api-fac-1', name: 'Spor Salonu', capacity: 8, openingHours: ALL_WEEK, slotMinutes: 60, maxBookingMinutes: 120, advanceDays: 7, maxActivePerUnit: 1 };

  it('roller: yonetici yazar, denetci okur, sakin yonetim uclarina giremez; olusturma 201, tekrar 200', async () => {
    const { call } = api();
    expect((await call('POST', '/api/reservations/facilities', ctxs.observer, facilityBody)).status).toBe(403);
    const created = await call('POST', '/api/reservations/facilities', ctxs.mgr, facilityBody);
    expect(created).toMatchObject({ status: 201, json: { facility: { name: 'Spor Salonu' } } });
    expect((await call('POST', '/api/reservations/facilities', ctxs.mgr, facilityBody)).status).toBe(200);
    expect((await call('GET', '/api/reservations/facilities', ctxs.observer)).json.items).toHaveLength(1);
    for (const ctx of [ctxs.a, ctxs.staff]) expect((await call('GET', '/api/reservations/facilities', ctx)).status).toBe(403);
    expect((await call('GET', '/api/portal/reservations/facilities', ctxs.mgr)).status).toBe(403);
    expect((await call('GET', '/api/reservations/facilities', { userId: 'mgr', role: 'apartment_manager' })).status).toBe(403);
    const id = created.json.facility.facilityId as string;
    expect((await call('PATCH', `/api/reservations/facilities/${id}`, ctxs.mgr, { version: 1, status: 'inactive' })).json.facility.status).toBe('inactive');
    expect((await call('PATCH', `/api/reservations/facilities/${id}`, ctxs.mgr, { version: 1, status: 'active' })).json).toMatchObject({ error: 'conflict' });
  });

  it('sakin akisi: alanlar, musaitlik, rezervasyon (201/200), dolu dilim 409, iptal', async () => {
    const { call } = api();
    const fac = (await call('POST', '/api/reservations/facilities', ctxs.mgr, facilityBody)).json.facility;
    const list = await call('GET', '/api/portal/reservations/facilities', ctxs.a);
    expect(list.json).toMatchObject({ units: [{ unitId: 'u1', label: 'A Blok · U1' }], items: [{ facilityId: fac.facilityId }] });
    expect(list.json.items[0]).not.toHaveProperty('incomeAccountId');
    const day = await call('GET', `/api/portal/reservations/facilities/${fac.facilityId}/availability?date=2026-11-29`, ctxs.a);
    expect(day.json.slots).toHaveLength(13);
    expect((await call('GET', `/api/portal/reservations/facilities/${fac.facilityId}/availability?date=bad`, ctxs.a)).status).toBe(400);
    const body = { idempotencyKey: 'api-bk-1', facilityId: fac.facilityId, unitId: 'u1', date: '2026-11-29', start: '18:00', minutes: 60 };
    const created = await call('POST', '/api/portal/reservations/bookings', ctxs.a, body);
    expect(created).toMatchObject({ status: 201, json: { booking: { status: 'confirmed', startTime: '18:00' } } });
    expect((await call('POST', '/api/portal/reservations/bookings', ctxs.a, body)).status).toBe(200);
    const taken = await call('POST', '/api/portal/reservations/bookings', ctxs.b, { ...body, idempotencyKey: 'api-bk-2', unitId: 'u2' });
    expect(taken).toMatchObject({ status: 409, json: { error: 'slot_taken' } });
    expect((await call('GET', '/api/portal/reservations/bookings', ctxs.a)).json.upcoming).toHaveLength(1);
    expect((await call('GET', '/api/reservations/bookings?from=2026-11-29&to=2026-11-29', ctxs.observer)).json.items).toHaveLength(1);
    expect((await call('GET', '/api/reservations/bookings/pending', ctxs.observer)).json).toMatchObject({ total: 0 });
    const id = created.json.booking.bookingId as string;
    expect((await call('POST', `/api/reservations/bookings/${id}/cancel`, ctxs.observer, { version: 1, reason: 'Deneme' })).status).toBe(403);
    expect((await call('POST', `/api/portal/reservations/bookings/${id}/cancel`, ctxs.a, { version: 1 })).json.booking.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// DynamoDB deposu
// ---------------------------------------------------------------------------

describe('rezervasyon deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });
  const pk = `APT#${APT}`;
  const booking = { PK: pk, SK: 'RBOOK#b1', entityType: 'RESERVATION_BOOKING', apartmentId: APT, bookingId: 'b1', version: 1 } as unknown as Booking;
  const slot = (s: string) => ({ PK: pk, SK: `RSLOT#f1#${s}`, entityType: 'RESERVATION_SLOT' as const, apartmentId: APT, facilityId: 'f1', slotStart: s, state: 'held' as const, bookingId: 'b1', unitId: 'u1', at: T0 });

  it('yeni rezervasyon: dilim kosulu, daire sayaci, indeks tek islemde; Delete yok; kosul hatasi nedenine gore', async () => {
    const repo = createReservationRepository();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    await repo.write(APT, {
      at: T0,
      booking: { item: booking, expectedVersion: 0 },
      hold: [slot('2026-11-29T07:00:00.000Z')],
      guard: { facilityId: 'f1', unitId: 'u1', expected: 3 },
      indexes: [{ PK: pk, SK: 'RBUNIT#u1#2026-11-29T07:00:00.000Z#b1', entityType: 'RESERVATION_INDEX', apartmentId: APT, bookingId: 'b1', facilityId: 'f1', unitId: 'u1', start: '2026-11-29T07:00:00.000Z' }],
    });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Put', 'Put', 'Update', 'Put']);
    expect(items[1]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK) OR #state = :released', Item: { state: 'held' } });
    expect(items[2]?.Update).toMatchObject({ ConditionExpression: '#seq = :expected', ExpressionAttributeValues: { ':next': 4, ':expected': 3 } });

    ddb.on(TransactWriteCommand).callsFake((input: { TransactItems: unknown[] }) => {
      throw new TransactionCanceledException({ message: 'iptal', $metadata: {}, CancellationReasons: input.TransactItems.map((_, i) => ({ Code: i === 1 ? 'ConditionalCheckFailed' : 'None' })) });
    });
    await expect(repo.write(APT, { at: T0, booking: { item: booking, expectedVersion: 0 }, hold: [slot('2026-11-29T07:00:00.000Z')] })).rejects.toMatchObject({ reason: 'slot' });
    await expect(repo.write('apt-2', { at: T0, booking: { item: booking, expectedVersion: 0 } })).rejects.toThrow(/Kiraci/);
  });

  it('iptal: dilim yalnizca ayni rezervasyon tutuyorsa serbest kalir (Put, silme yok)', async () => {
    const repo = createReservationRepository();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    await repo.write(APT, { at: T0, booking: { item: { ...booking, version: 2 } as Booking, expectedVersion: 1 }, release: [slot('2026-11-29T07:00:00.000Z')] });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]?.Put).toMatchObject({ ConditionExpression: 'attribute_exists(PK) AND #version = :expected', ExpressionAttributeValues: { ':expected': 1 } });
    expect(items[1]?.Put).toMatchObject({ ConditionExpression: '#state = :held AND #booking = :booking', Item: { state: 'released' }, ExpressionAttributeValues: { ':booking': 'b1' } });
  });

  it('aralik sorgusu SK BETWEEN ile ve yalnizca tutulan dilimler', async () => {
    const repo = createReservationRepository();
    ddb.on(QueryCommand).resolves({ Items: [slot('2026-11-29T07:00:00.000Z'), { ...slot('2026-11-29T07:30:00.000Z'), state: 'released' }, slot('2026-11-29T21:00:00.000Z')] });
    const held = await repo.listHeldSlots(APT, 'f1', '2026-11-28T21:00:00.000Z', '2026-11-29T21:00:00.000Z');
    expect(held.map((s) => s.slotStart)).toEqual(['2026-11-29T07:00:00.000Z']);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({ KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to', ExpressionAttributeValues: { ':pk': pk, ':from': 'RSLOT#f1#2026-11-28T21:00:00.000Z' } });
  });
});
