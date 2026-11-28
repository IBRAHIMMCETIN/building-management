import { addClock, addDays, istanbulToday, weekdayOf } from '@bm/shared/reservations/model';
import type { DemoHandler } from '../demoApi';

/*
 * DEMO: ortak alan rezervasyonu (/api/portal/reservations). Iki alan (onayli ucretsiz salon, ucretli
 * kort), her gun ayni saatlerde baska dairelerin dolu dilimleri; rezervasyonlar bellekte. Saatler
 * Istanbul duvar saati (UTC+03:00). Gercek veri DEGILDIR.
 */

type Json = Record<string, unknown>;
type Booking = Json & { bookingId: string; facilityId: string; date: string; startTime: string; endTime: string; status: string; version: number; fee: { amount: number; status: string } };

const P = '/api/portal/reservations';
const UNIT = { unitId: 'u-demo-7', blockId: 'b-a', number: '7', label: 'A Blok · Daire 7' };
const everyDay = (open: string, close: string) => [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, open, close }));
const FACILITIES = [
  {
    facilityId: 'f-salon',
    name: 'Toplantı salonu',
    description: 'Sığınak katındaki salon; 40 kişilik, projeksiyon ve mutfak bölümü var.',
    capacity: 40,
    openingHours: everyDay('09:00', '22:00'),
    slotMinutes: 60,
    maxBookingMinutes: 180,
    advanceDays: 30,
    maxActivePerUnit: 2,
    requiresApproval: true,
    cancelNoticeHours: 24,
    feeKurus: 0,
    status: 'active',
    version: 1,
    unitIds: [UNIT.unitId],
  },
  {
    facilityId: 'f-kort',
    name: 'Tenis kortu',
    capacity: 4,
    openingHours: [...[1, 2, 3, 4, 5].map((day) => ({ day, open: '07:00', close: '21:00' })), { day: 6, open: '08:00', close: '20:00' }],
    slotMinutes: 60,
    maxBookingMinutes: 120,
    advanceDays: 14,
    maxActivePerUnit: 2,
    requiresApproval: false,
    cancelNoticeHours: 6,
    feeKurus: 15000,
    status: 'active',
    version: 1,
    unitIds: [UNIT.unitId],
  },
];
/** Baska dairelerin dolu dilimleri (her gun). */
const BUSY: Record<string, string[]> = { 'f-salon': ['19:00', '20:00'], 'f-kort': ['08:00', '18:00', '19:00'] };

const startAt = (date: string, clock: string) => new Date(`${date}T${clock}:00+03:00`);
const istanbulClock = (now: Date) => new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(11, 16);

export function createReservationsDemo(now0: Date = new Date()): DemoHandler {
  const today0 = istanbulToday(now0);
  const bookings: Booking[] = [];
  let seq = 1;
  const add = (facilityId: string, date: string, startTime: string, minutes: number, status: string, over: Json = {}) => {
    const f = FACILITIES.find((x) => x.facilityId === facilityId) ?? FACILITIES[0];
    const b: Booking = {
      bookingId: `bk-${seq++}`,
      facilityId,
      facilityName: f?.name ?? '',
      unitId: UNIT.unitId,
      date,
      start: startAt(date, startTime).toISOString(),
      end: startAt(date, addClock(startTime, minutes)).toISOString(),
      startTime,
      endTime: addClock(startTime, minutes),
      minutes,
      status,
      expired: false,
      past: false,
      canCancel: false,
      createdAt: now0.toISOString(),
      mine: true,
      cancelDeadline: new Date(startAt(date, startTime).getTime() - (f?.cancelNoticeHours ?? 0) * 3_600_000).toISOString(),
      fee: { amount: f?.feeKurus ?? 0, status: f?.feeKurus ? 'charged' : 'none' },
      version: 1,
      ...over,
    };
    bookings.push(b);
    return b;
  };
  add('f-kort', addDays(today0, 3), '10:00', 60, 'confirmed');
  add('f-salon', addDays(today0, -12), '14:00', 120, 'confirmed');
  add('f-salon', addDays(today0, -30), '18:00', 60, 'rejected', { decisionNote: 'Aynı gün bakım çalışması var.' });

  /** Zamana bagli alanlar her yanitta yeniden hesaplanir (gercek API gibi). */
  const view = (b: Booking, now: Date): Booking => {
    const past = Date.parse(String(b.end)) <= now.getTime();
    const active = b.status === 'pending' || b.status === 'confirmed';
    return { ...b, past, expired: b.status === 'pending' && Date.parse(String(b.start)) <= now.getTime(), canCancel: active && now.getTime() < Date.parse(String(b.cancelDeadline)) };
  };

  function availability(facilityId: string, date: string, now: Date) {
    const f = FACILITIES.find((x) => x.facilityId === facilityId);
    if (!f) return undefined;
    const today = istanbulToday(now);
    const lastBookableDate = addDays(today, f.advanceDays);
    const window = f.openingHours.find((h) => h.day === weekdayOf(date));
    const base = { facilityId, date, bookable: !!window && date >= today && date <= lastBookableDate, lastBookableDate, slotMinutes: f.slotMinutes, maxBookingMinutes: f.maxBookingMinutes };
    if (!window) return { ...base, open: false, slots: [] };
    const mine = bookings.filter((b) => b.facilityId === facilityId && b.date === date && (b.status === 'confirmed' || b.status === 'pending'));
    const slots: Json[] = [];
    for (let s = window.open; s < window.close; s = addClock(s, f.slotMinutes)) {
      const end = addClock(s, f.slotMinutes);
      const isMine = mine.some((b) => b.startTime <= s && s < b.endTime);
      const past = date < today || (date === today && s <= istanbulClock(now));
      const state = past ? 'past' : isMine ? 'mine' : BUSY[facilityId]?.includes(s) ? 'busy' : 'free';
      slots.push({ start: s, end, startAt: startAt(date, s).toISOString(), state });
    }
    return { ...base, open: true, window: { open: window.open, close: window.close }, slots };
  }

  return ({ method, path, body, query, now }) => {
    if (!path.startsWith(P)) return undefined;
    const rest = path.slice(P.length);
    const b = (body ?? {}) as Json;

    if (rest === '/facilities') return { status: 200, body: { units: [UNIT], today: istanbulToday(now), items: FACILITIES } };
    const avail = /^\/facilities\/([^/]+)\/availability$/.exec(rest);
    if (avail) {
      const out = availability(decodeURIComponent(avail[1] ?? ''), query.date ?? '', now);
      return out ? { status: 200, body: out } : { status: 404, body: { error: 'not_found', message: 'Ortak alan bulunamadı.' } };
    }
    if (rest === '/bookings' && method === 'GET') {
      const all = bookings.map((x) => view(x, now));
      const upcoming = all.filter((x) => !x.past && (x.status === 'pending' || x.status === 'confirmed')).sort((x, y) => String(x.start).localeCompare(String(y.start)));
      const history = all.filter((x) => !upcoming.includes(x)).sort((x, y) => String(y.start).localeCompare(String(x.start)));
      return { status: 200, body: { upcoming, history } };
    }
    if (rest === '/bookings' && method === 'POST') {
      const f = FACILITIES.find((x) => x.facilityId === b.facilityId);
      const day = availability(String(b.facilityId), String(b.date), now);
      if (!f || !day) return { status: 404, body: { error: 'not_found', message: 'Ortak alan bulunamadı.' } };
      const minutes = Number(b.minutes);
      const start = String(b.start);
      const needed = minutes / f.slotMinutes;
      const from = day.slots.findIndex((s) => s.start === start);
      const free = from >= 0 && day.slots.slice(from, from + needed).length === needed && day.slots.slice(from, from + needed).every((s) => s.state === 'free');
      if (!day.bookable || !free) return { status: 409, body: { error: 'slot_taken', message: 'Seçilen saat artık müsait değil. Lütfen başka bir saat seçin.' } };
      const booking = add(f.facilityId, String(b.date), start, minutes, f.requiresApproval ? 'pending' : 'confirmed', {
        createdAt: now.toISOString(),
        ...(typeof b.partySize === 'number' ? { partySize: b.partySize } : {}),
        ...(typeof b.note === 'string' ? { note: b.note } : {}),
        fee: { amount: f.feeKurus, status: f.feeKurus ? (f.requiresApproval ? 'pending' : 'charged') : 'none' },
      });
      return { status: 201, body: { booking: view(booking, now), replayed: false } };
    }
    const cancel = /^\/bookings\/([^/]+)\/cancel$/.exec(rest);
    if (cancel && method === 'POST') {
      const bk = bookings.find((x) => x.bookingId === decodeURIComponent(cancel[1] ?? ''));
      if (!bk) return { status: 404, body: { error: 'not_found', message: 'Rezervasyon bulunamadı.' } };
      if (b.version !== bk.version) return { status: 409, body: { error: 'conflict', message: 'Rezervasyon bu arada güncellendi; yenileyip tekrar deneyin.' } };
      if (!view(bk, now).canCancel) return { status: 422, body: { error: 'cancel_window', message: 'İptal süresi geçti; değişiklik için yönetimle görüşün.' } };
      Object.assign(bk, { status: 'cancelled', cancelKind: 'resident', version: bk.version + 1, fee: { ...bk.fee, status: bk.fee.status === 'charged' ? 'reversed' : bk.fee.status === 'pending' ? 'void' : bk.fee.status } });
      return { status: 200, body: { booking: view(bk, now) } };
    }
    return undefined;
  };
}
