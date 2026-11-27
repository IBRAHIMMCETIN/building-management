import type { DomainEvent } from '../../src/events/publisher.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import { ReservationConflictError, type ReservationRepository, type ReservationWrite } from '../../src/modules/reservations/repository.js';
import type { Booking, BookingIndex, Facility, ReservationIdempotency, SlotLock } from '../../src/modules/reservations/types.js';

type Doc = Record<string, unknown> & { PK: string; SK: string };

/**
 * Bellek ici rezervasyon deposu; kosullar gercek depoyla ayni (surum, dilim kilidi, daire sayaci,
 * idempotency). `store` verilirse sahte finans deposunun belge haritasi paylasilir: Finans
 * `chargeUnit`'in `replaceRecords` ile guncelledigi rezervasyon ayni kayittir (gercek tabloda oldugu gibi).
 */
export function createFakeReservationRepo(store: Map<string, Doc> = new Map()) {
  const audits: AuditDraft[] = [];
  const outbox: DomainEvent[] = [];
  const writes: ReservationWrite[] = [];
  const k = (o: { PK: string; SK: string }) => `${o.PK}|${o.SK}`;
  const get = <T>(key: { PK: string; SK: string }) => {
    const v = store.get(k(key));
    return v ? (structuredClone(v) as unknown as T) : undefined;
  };
  const between = <T>(apt: string, from: string, to: string) =>
    [...store.values()]
      .filter((i) => i.PK === `APT#${apt}` && i.SK >= from && i.SK <= to)
      .sort((a, b) => a.SK.localeCompare(b.SK))
      .map((i) => structuredClone(i) as unknown as T);
  let failNext: Error | undefined;
  /** Yazimdan hemen once calisir (es zamanli istek benzetimi). */
  let beforeWrite: (() => Promise<void>) | undefined;

  const repo: ReservationRepository = {
    getFacility: async (apt, id) => get<Facility>({ PK: `APT#${apt}`, SK: `RFAC#${id}` }),
    listFacilities: async (apt) => between<Facility>(apt, 'RFAC#', 'RFAC#~').filter((f) => f.entityType === 'RESERVATION_FACILITY'),
    getBooking: async (apt, id) => get<Booking>({ PK: `APT#${apt}`, SK: `RBOOK#${id}` }),
    getBookings: async (apt, ids) => [...new Set(ids)].map((id) => get<Booking>({ PK: `APT#${apt}`, SK: `RBOOK#${id}` })).filter((b): b is Booking => !!b),
    listFacilityBookingIds: async (apt, fac, from, to) =>
      between<BookingIndex>(apt, `RBFAC#${fac}#${from}`, `RBFAC#${fac}#${to}`)
        .filter((i) => i.start >= from && i.start < to)
        .map((i) => i.bookingId),
    listUnitBookingIds: async (apt, unit, from) => between<BookingIndex>(apt, `RBUNIT#${unit}#${from}`, `RBUNIT#${unit}#~`).map((i) => i.bookingId),
    listHeldSlots: async (apt, fac, from, to) => between<SlotLock>(apt, `RSLOT#${fac}#${from}`, `RSLOT#${fac}#${to}`).filter((s) => s.state === 'held' && s.slotStart < to),
    getGuard: async (apt, fac, unit) => (store.get(`APT#${apt}|RGUARD#${fac}#${unit}`)?.seq as number | undefined) ?? 0,
    getIdempotency: async (apt, key) => get<ReservationIdempotency>({ PK: `APT#${apt}`, SK: `RIDEM#${key}` }),
    listFeeQueue: async (apt) => between<BookingIndex>(apt, 'RFEEQ#', 'RFEEQ#~').map((i) => i.bookingId),
    async write(apt, w) {
      // Kanca ve hata bu yazima aittir: kancanin icindeki (araya giren) yazim etkilenmez.
      const hook = beforeWrite;
      const fail = failNext;
      beforeWrite = undefined;
      failNext = undefined;
      if (hook) await hook();
      if (fail) throw fail;
      const pk = `APT#${apt}`;
      for (const d of [w.facility?.item, w.booking?.item, ...(w.hold ?? []), ...(w.release ?? []), ...(w.indexes ?? []), w.idempotency]) {
        if (d && d.PK !== pk) throw new Error('Kiraci uyusmazligi');
      }
      // 1) Kosullar (atomik: hicbir sey yazilmadan once)
      if (w.idempotency && store.has(k(w.idempotency))) throw new ReservationConflictError('duplicate');
      for (const v of [w.facility, w.booking]) {
        if (!v) continue;
        const cur = store.get(k(v.item)) as { version?: number } | undefined;
        if (v.expectedVersion === 0 ? !!cur : cur?.version !== v.expectedVersion) throw new ReservationConflictError('version');
      }
      if (w.facilityCheck) {
        const f = store.get(`${pk}|RFAC#${w.facilityCheck.facilityId}`);
        if (!f || f.version !== w.facilityCheck.version || f.status !== 'active') throw new ReservationConflictError('facility');
      }
      for (const s of w.hold ?? []) {
        const cur = store.get(k(s));
        if (cur && cur.state !== 'released') throw new ReservationConflictError('slot');
      }
      for (const s of w.release ?? []) {
        const cur = store.get(k(s));
        if (!cur || cur.state !== 'held' || cur.bookingId !== s.bookingId) throw new ReservationConflictError('version');
      }
      if (w.guard) {
        const cur = (store.get(`${pk}|RGUARD#${w.guard.facilityId}#${w.guard.unitId}`)?.seq as number | undefined) ?? 0;
        if (cur !== w.guard.expected) throw new ReservationConflictError('guard');
      }
      // 2) Yazim
      const put = (d: Doc) => store.set(k(d), structuredClone(d));
      if (w.idempotency) put(w.idempotency as unknown as Doc);
      if (w.facility) put(w.facility.item as unknown as Doc);
      if (w.booking) put(w.booking.item as unknown as Doc);
      for (const s of w.hold ?? []) put({ ...s, state: 'held' } as unknown as Doc);
      for (const s of w.release ?? []) put({ ...s, state: 'released' } as unknown as Doc);
      if (w.guard) put({ PK: pk, SK: `RGUARD#${w.guard.facilityId}#${w.guard.unitId}`, entityType: 'RESERVATION_GUARD', seq: w.guard.expected + 1 });
      for (const i of w.indexes ?? []) put(i as unknown as Doc);
      if (w.audit) audits.push(w.audit);
      outbox.push(...(w.outbox ?? []));
      writes.push(structuredClone(w));
    },
  };
  return {
    repo,
    store,
    audits,
    outbox,
    writes,
    failNextWith: (e: Error) => {
      failNext = e;
    },
    /** Bir sonraki yazimdan once `hook` calisir (araya giren es zamanli istek). */
    beforeNextWrite: (hook: () => Promise<void>) => {
      beforeWrite = hook;
    },
  };
}
