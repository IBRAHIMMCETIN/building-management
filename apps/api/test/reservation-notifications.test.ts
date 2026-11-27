/**
 * Rezervasyon bildirimleri: yonetimin onayi, reddi ve iptali rezervasyonu yapana bildirilir. Olay
 * karari yazan islemle AYNI atomik yazimdadir (ucretli onayda Finans tahakkukuyla ayni batch);
 * gerekce / not payload'da yoktur, worker rezervasyon kaydindan okur (ucret iadesinin guncel durumu
 * dahil). Sakinin kendi iptali ve otomatik onay olay uretmez; tasinan sakine bildirim gitmez.
 */
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Block, Unit } from '../src/modules/core/types.js';
import { createFinanceService } from '../src/modules/finance/service.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { type ReservationContext, type ReservationFinance, createReservationService } from '../src/modules/reservations/service.js';
import { type Notification, type SqsEvent, createNotificationWorker } from '../src/workers/notification-worker.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeReservationRepo } from './fakes/reservationRepo.js';

const APT = 'apt-1';
/** Cuma 27.11.2026 10:00 (Istanbul). */
const T0 = '2026-11-27T07:00:00.000Z';
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, open: '09:00', close: '22:00' }));
const audit = { createdAt: T0, createdBy: 'seed', updatedAt: T0, updatedBy: 'seed', version: 1 };
const unit = (id: string, blockId: string) =>
  ({ PK: `APT#${APT}`, SK: `UNIT#${id}`, entityType: 'UNIT', unitId: id, siteId: APT, blockId, number: id.toUpperCase(), type: 'flat', grossAreaTenthsM2: 1000, exemptions: [], status: 'active', ...audit }) as unknown as Unit;
const member = (userId: string, unitId: string, relation: 'owner' | 'tenant', extra: Partial<UnitMembership> = {}) =>
  ({ userId, unitId, apartmentId: APT, relation, residesInUnit: true, status: 'active', startDate: '2026-01-01', ...extra }) as unknown as UnitMembership;

const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  a: { apartmentId: APT, userId: 'res-a', role: 'resident' },
  a2: { apartmentId: APT, userId: 'res-a2', role: 'resident' },
} satisfies Record<string, ReservationContext>;

function world(opts: { finance?: (f: ReservationFinance) => ReservationFinance } = {}) {
  const now = new Date(T0);
  const fin = createFakeFinanceRepo(APT);
  const fake = createFakeReservationRepo(fin.docs as unknown as Map<string, Record<string, unknown> & { PK: string; SK: string }>);
  const units = [unit('u1', 'b1'), unit('u2', 'b1')];
  const blocks = [{ blockId: 'b1', name: 'A Blok', status: 'active' }] as unknown as Block[];
  const memberships = [member('res-a', 'u1', 'tenant'), member('res-a2', 'u1', 'owner', { residesInUnit: false })];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits' | 'getBlock'> = {
    getUnit: async (apt, id) => units.find((u) => u.unitId === id && u.siteId === apt),
    listUnits: async (apt) => units.filter((u) => u.siteId === apt),
    getBlock: async (_a, id) => blocks.find((b) => b.blockId === id),
  };
  let n = 0;
  const realFinance = createFinanceService({ repository: fin.repo, core, now: () => now, newId: () => `fin-${String(++n).padStart(4, '0')}` });
  const service = createReservationService({
    repo: fake.repo,
    core,
    memberships: { listMemberships: async (apt, userId) => memberships.filter((m) => m.userId === userId && m.apartmentId === apt) },
    ownership: { billingOf: async () => 'joint' },
    finance: opts.finance ? opts.finance(realFinance) : realFinance,
    now: () => now,
    newId: () => `id${String(++n).padStart(10, '0')}`,
  });
  let k = 0;
  const facility = async (extra: Record<string, unknown> = {}) =>
    (
      await service.createFacility(ctxs.mgr, {
        idempotencyKey: `fac-${++k}`,
        name: 'Toplantı Salonu',
        capacity: 20,
        openingHours: ALL_WEEK,
        slotMinutes: 60,
        maxBookingMinutes: 180,
        advanceDays: 14,
        maxActivePerUnit: 3,
        requiresApproval: true,
        cancelNoticeHours: 24,
        feeKurus: 0,
        ...extra,
      })
    ).facility;
  const book = async (ctx: ReservationContext, facilityId: string, start = '10:00') =>
    (await service.book(ctx, { idempotencyKey: `bk-${++k}`, facilityId, unitId: 'u1', date: '2026-11-29', start, minutes: 60 })).booking;
  /** Rezervasyon (fake.outbox) ve Finans (fin.outbox) yazimlarindaki olaylar. */
  const events = (): DomainEvent[] => [...fake.outbox, ...fin.events()].filter((e) => e.type.startsWith('RESERVATION_'));

  const sent: Notification[] = [];
  const processed = new Set<string>();
  const notify = (members: UnitMembership[] = memberships) =>
    createNotificationWorker({
      memberships: { list: async (apt) => members.filter((m) => m.apartmentId === apt) },
      core: { listUnits: async () => [] as Unit[] },
      roles: { list: async () => [] as ApartmentRole[] },
      gate: { get: async () => undefined },
      reservations: fake.repo,
      notifier: { channel: 'test', send: async (x) => void sent.push(x) },
      isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
      markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
      now: () => now,
      log: { info: () => {}, error: () => {} },
    });
  const sqs = (list: DomainEvent[]): SqsEvent => ({ Records: list.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) });
  return { fake, fin, service, facility, book, events, notify, sqs, sent, memberships };
}

const PERSONAL = ['Toplantı odası tadilatta', 'Ahmet Bey', 'Lütfen'];

describe('rezervasyon olaylari: outbox ayni atomik yazimda', () => {
  it('ucretsiz onay: rezervasyon guncellemesi ve RESERVATION_APPROVED tek yazim; not payloadda yok', async () => {
    const w = world();
    const f = await w.facility();
    const b = await w.book(ctxs.a, f.facilityId);
    expect(w.events()).toEqual([]); // olusturma bildirim uretmez
    await w.service.approve(ctxs.mgr, b.bookingId, { version: b.version, note: 'Lütfen anahtarı Ahmet Bey’den alın' });
    const write = w.fake.writes.find((x) => x.booking?.item.status === 'confirmed');
    expect(write?.outbox?.map((e) => e.eventId)).toEqual([`RESERVATION_APPROVED:${b.bookingId}`]);
    const event = write?.outbox?.[0] as DomainEvent;
    expect(event).toMatchObject({ type: 'RESERVATION_APPROVED', apartmentId: APT, actorId: 'mgr' });
    expect(event.payload).toEqual({
      bookingId: b.bookingId,
      facilityId: f.facilityId,
      facilityName: 'Toplantı Salonu',
      unitId: 'u1',
      bookerId: 'res-a',
      date: '2026-11-29',
      start: '2026-11-29T07:00:00.000Z',
      end: '2026-11-29T08:00:00.000Z',
      feeKurus: 0,
      feeStatus: 'none',
    });
    for (const text of PERSONAL) expect(JSON.stringify(event)).not.toContain(text);
  });

  it('ucretli onay: tahakkuk (DUE_GENERATED), rezervasyon ve RESERVATION_APPROVED ayni Finans batch\'inde', async () => {
    const w = world();
    const f = await w.facility({ feeKurus: 20_000 });
    const b = await w.book(ctxs.a, f.facilityId);
    await w.service.approve(ctxs.mgr, b.bookingId, { version: b.version });
    const batch = w.fin.batches.at(-1);
    expect(batch?.outbox?.map((e) => e.type).sort()).toEqual(['DUE_GENERATED', 'RESERVATION_APPROVED']);
    expect(batch?.replaceRecords?.map((r) => (r.item as { SK: string }).SK)).toEqual([`RBOOK#${b.bookingId}`]);
    expect(w.events()[0]?.payload).toMatchObject({ feeKurus: 20_000, feeStatus: 'charged' });
  });

  it('ret: gerekce kayitta, olayda yok; sakinin kendi iptali ve otomatik onay olay uretmez', async () => {
    const w = world();
    const f = await w.facility();
    const b = await w.book(ctxs.a, f.facilityId);
    await w.service.reject(ctxs.mgr, b.bookingId, { version: b.version, reason: 'Toplantı odası tadilatta' });
    const write = w.fake.writes.find((x) => x.booking?.item.status === 'rejected');
    expect(write?.release?.length).toBeGreaterThan(0);
    expect(write?.outbox?.map((e) => e.eventId)).toEqual([`RESERVATION_REJECTED:${b.bookingId}`]);
    for (const text of PERSONAL) expect(JSON.stringify(write?.outbox)).not.toContain(text);

    const own = await w.book(ctxs.a, f.facilityId, '12:00');
    await w.service.cancel(ctxs.a, own.bookingId, { version: own.version, reason: 'Vazgeçtim' });
    const auto = await w.facility({ requiresApproval: false, feeKurus: 5_000 });
    await w.book(ctxs.a, auto.facilityId, '14:00'); // otomatik onay (tahakkuk)
    expect(w.events().map((e) => e.type)).toEqual(['RESERVATION_REJECTED']);
  });

  it('yonetim iptali: iptal yazimiyla ayni islemde; ucret iadesinin sonucu worker tarafindan kayittan okunur', async () => {
    const w = world();
    const f = await w.facility({ requiresApproval: false, feeKurus: 15_000 });
    const b = await w.book(ctxs.a, f.facilityId);
    const r = await w.service.cancel(ctxs.mgr, b.bookingId, { version: b.version, reason: 'Toplantı odası tadilatta' });
    expect(r.booking.fee.status).toBe('reversed');
    const write = w.fake.writes.find((x) => x.booking?.item.status === 'cancelled' && x.release?.length);
    expect(write?.outbox?.map((e) => e.eventId)).toEqual([`RESERVATION_CANCELLED:${b.bookingId}`]);
    // Yazim aninda iade henuz yapilmamisti.
    expect(write?.outbox?.[0]?.payload).toMatchObject({ feeKurus: 15_000, feeStatus: 'reversal_pending' });

    await w.notify()(w.sqs(w.events()));
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ userId: 'res-a', template: 'reservation_cancelled', data: { feeStatus: 'reversed', feeKurus: 15_000, reason: 'Toplantı odası tadilatta', facilityName: 'Toplantı Salonu' } });
  });
});

describe('rezervasyon bildirimleri: worker', () => {
  it('yalnizca rezervasyonu yapan (ayni dairenin diger uyesi almaz); not / gerekce kayittan; tekrar teslim tek bildirim', async () => {
    const w = world();
    const f = await w.facility();
    const b1 = await w.book(ctxs.a, f.facilityId);
    const b2 = await w.book(ctxs.a, f.facilityId, '12:00');
    await w.service.approve(ctxs.mgr, b1.bookingId, { version: b1.version, note: 'Anahtar güvenlikte' });
    await w.service.reject(ctxs.mgr, b2.bookingId, { version: b2.version, reason: 'Bakım çalışması' });
    const handler = w.notify();
    expect((await handler(w.sqs(w.events()))).batchItemFailures).toEqual([]);
    await handler(w.sqs(w.events()));
    expect(w.sent.map((n) => [n.userId, n.template])).toEqual([
      ['res-a', 'reservation_approved'],
      ['res-a', 'reservation_rejected'],
    ]);
    expect(w.sent[0]?.data).toMatchObject({ note: 'Anahtar güvenlikte' });
    expect(w.sent[1]?.data).toMatchObject({ reason: 'Bakım çalışması' });
  });

  it('tasinan (uyeligi biten) sakine bildirim gitmez', async () => {
    const w = world();
    const f = await w.facility();
    const b = await w.book(ctxs.a, f.facilityId);
    await w.service.reject(ctxs.mgr, b.bookingId, { version: b.version, reason: 'Uygun değil' });
    const movedOut = w.memberships.map((m) => (m.userId === 'res-a' ? { ...m, status: 'inactive', endDate: '2026-11-26' } : m)) as UnitMembership[];
    await w.notify(movedOut)(w.sqs(w.events()));
    expect(w.sent).toEqual([]);
  });
});

describe('rezervasyon e-posta sablonlari', () => {
  const ctx = { siteName: 'Güneş Sitesi', unitLabel: () => 'A Blok - 5', portalUrl: 'https://site.example/app' };
  const base = { bookingId: 'b1', facilityName: 'Toplantı Salonu', unitId: 'u1', date: '2026-11-29', start: '2026-11-29T07:00:00.000Z', end: '2026-11-29T08:00:00.000Z' };
  const note = (template: Notification['template'], data: Notification['data']): Notification => ({ eventId: 'e', apartmentId: APT, userId: 'u', template, data: { ...base, ...data } });

  it('onay: tarih, Istanbul saati, ucret ve yonetimin notu; portal rezervasyon baglantisi', () => {
    const email = renderEmail(note('reservation_approved', { feeKurus: 20_000, feeStatus: 'charged', note: 'Anahtar güvenlikte' }), ctx);
    expect(email?.subject).toBe('Rezervasyonunuz onaylandı: Toplantı Salonu 29.11.2026 - Güneş Sitesi');
    expect(email?.text).toContain('Saat: 10:00-11:00');
    expect(email?.text).toContain('Ücret: 200,00 TL (hesabınıza tahakkuk edildi)');
    expect(email?.text).toContain('Yönetimin notu: Anahtar güvenlikte');
    expect(email?.text).toContain('https://site.example/app/rezervasyon');
  });

  it('ret gerekcesi; iptalde ucret iadesinin durumu (iade edildi / isleniyor / tahakkuk yok); ucretsizde ucret satiri yok', () => {
    const rejected = renderEmail(note('reservation_rejected', { feeKurus: 0, feeStatus: 'none', reason: 'Bakım <b>çalışması</b>' }), ctx);
    expect(rejected?.text).toContain('Gerekçe: Bakım <b>çalışması</b>');
    expect(rejected?.html).toContain('Bakım &lt;b&gt;çalışması&lt;/b&gt;');
    const reversed = renderEmail(note('reservation_cancelled', { feeKurus: 15_000, feeStatus: 'reversed', reason: 'Tadilat' }), ctx);
    expect(reversed?.text).toContain('Ücret: 150,00 TL iade edildi');
    const pending = renderEmail(note('reservation_cancelled', { feeKurus: 15_000, feeStatus: 'reversal_pending' }), ctx);
    expect(pending?.text).toContain('150,00 TL iadesi yönetim tarafından işleniyor');
    const voided = renderEmail(note('reservation_cancelled', { feeKurus: 15_000, feeStatus: 'void' }), ctx);
    expect(voided?.text).toContain('Ücret tahakkuk edilmemişti');
    const free = renderEmail(note('reservation_cancelled', { feeKurus: 0, feeStatus: 'none' }), ctx);
    expect(free?.text).not.toContain('Ücret');
  });
});
