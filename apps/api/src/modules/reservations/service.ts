/**
 * Ortak alan rezervasyonu servisi: alan tanimi (yonetim), sakin rezervasyonu, onay / ret / iptal.
 *
 *  - Kiraci izolasyonu: apartman ve aktor JWT claim'lerinden; sakinin daireleri guncel uyelik
 *    kayitlarindan. Istek govdesindeki kimlik bilgisi kullanilmaz.
 *  - Cakisma yok: dilim kilitleri kosullu yazimla (bkz. repository.ts); daire basina aktif
 *    rezervasyon siniri surum sayaciyla es zamanli isteklerde de korunur.
 *  - Ucret: onay aninda Finans `chargeUnit` (oturan alt carisi, aidat benzeri tahakkuk) ile ayni
 *    atomik yazimda rezervasyon `confirmed` olur; iptalde Finans `reverseTransaction` ters kaydi.
 *    Bu modul defter satiri yazmaz.
 *  - KVKK: sakin baska dairelerin rezervasyonlarini yalnizca dolu / bos dilim olarak gorur.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CoreRepository } from '../core/repository.js';
import { coreRepository } from '../core/repository.js';
import type { IsoDate, IsoDateTime } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, optInt, optString, reqInt, reqString } from '../core/validation.js';
import { FinanceError, type FinanceService } from '../finance/service.js';
import { PeriodClosedError } from '../finance/periodLock.js';
import { type OwnershipReader, createOwnershipReader } from '../ownership/reader.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import type { UnitMembership } from '../portal/types.js';
import { ReservationError } from './errors.js';
import { ReservationConflictError, type ReservationRepository, type ReservationWrite, reservationRepository } from './repository.js';
import { addDays, bookingTimeError, daysBetween, formatClock, istanbulDate, istanbulInstant, istanbulMinutes, lockSlotsOf, parseClock, slotGrid, windowOn } from './time.js';
import {
  type Booking,
  type BookingIndex,
  type BookingPayer,
  type BookingStatus,
  BOOKING_STATUSES,
  type Facility,
  HOLDING_STATUSES,
  MAX_ACTIVE_PER_UNIT,
  MAX_ADVANCE_DAYS,
  MAX_BOOKING_MINUTES,
  MAX_CANCEL_NOTICE_HOURS,
  MAX_CAPACITY,
  MAX_FEE_KURUS,
  MAX_RANGE_DAYS,
  type OpeningWindow,
  SLOT_LENGTHS,
  SLOT_STEP_MINUTES,
  type SlotLength,
  type SlotLock,
  type Weekday,
  reservationKeys,
} from './types.js';

export type ReservationContext = { apartmentId: string; userId: string; role: string };

export type ReservationFinance = Pick<FinanceService, 'chargeUnit' | 'reverseTransaction' | 'isReversed' | 'resolveIncomeAccount'>;

export type ReservationServiceDeps = {
  repo: ReservationRepository;
  core: Pick<CoreRepository, 'getUnit' | 'getBlock'>;
  memberships: Pick<PortalRepository, 'listMemberships'>;
  /** Hisseli mulkiyet faturalama modu (malik adina ucret paydaslara bolunecekse belirsiz sayilir). */
  ownership: Pick<OwnershipReader, 'billingOf'>;
  /** Ucret tahakkuku ve ters kaydi; verilmezse yalnizca ucretsiz alan tanimlanabilir. */
  finance: ReservationFinance | undefined;
  now: () => Date;
  newId: () => string;
};

type ActorKind = 'manager' | 'observer' | 'resident';
/** Sakinin bir dairedeki guncel uyelikleri: en erken baslangic ve uyelik basina ucret tarafi. */
type ResidentUnit = { since: IsoDate; payers: (BookingPayer | undefined)[] };
type Actor = { kind: ActorKind; userId: string; role: string; unitIds: string[]; units: Map<string, ResidentUnit> };

const activeOn = (m: Pick<UnitMembership, 'status' | 'startDate' | 'endDate'>, d: IsoDate) => m.status === 'active' && m.startDate <= d && (!m.endDate || m.endDate >= d);

/** Uyelikten ucret tarafi: dairede oturan (kiraci / oturan malik) -> oturan; oturmayan malik -> malik. */
export function payerOfMembership(m: Pick<UnitMembership, 'relation' | 'residesInUnit'>): BookingPayer | undefined {
  if (m.relation === 'tenant') return m.residesInUnit === false ? undefined : { liableParty: 'occupant', relation: 'tenant' };
  if (m.relation === 'owner') return { liableParty: m.residesInUnit ? 'occupant' : 'owner', relation: 'owner' };
  return undefined;
}

const MANAGER_ROLES = new Set(['apartment_manager', 'management_company']);
const DEFAULT_INCOME = 'income-dues';
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** Sakin "rezervasyonlarim" listesinde gecmis rezervasyonlar (gun). */
const HISTORY_DAYS = 90;
const WRITE_RETRIES = 3;
const SLOT_TAKEN = 'Seçtiğiniz saat aralığı az önce doldu; başka bir saat seçin';

type FacilityFields = Pick<
  Facility,
  | 'name'
  | 'description'
  | 'capacity'
  | 'openingHours'
  | 'slotMinutes'
  | 'maxBookingMinutes'
  | 'advanceDays'
  | 'maxActivePerUnit'
  | 'requiresApproval'
  | 'cancelNoticeHours'
  | 'blockIds'
  | 'feeKurus'
  | 'incomeAccountId'
>;
const FACILITY_FIELDS = [
  'name',
  'description',
  'capacity',
  'openingHours',
  'slotMinutes',
  'maxBookingMinutes',
  'advanceDays',
  'maxActivePerUnit',
  'requiresApproval',
  'cancelNoticeHours',
  'blockIds',
  'feeKurus',
  'incomeAccountId',
] as const satisfies readonly (keyof FacilityFields)[];

const trDate = (d: IsoDate) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function createReservationService(overrides: Partial<ReservationServiceDeps> = {}) {
  const deps: ReservationServiceDeps = {
    repo: reservationRepository,
    core: coreRepository,
    memberships: portalRepository,
    ownership: overrides.ownership ?? createOwnershipReader(),
    finance: undefined,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repo;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => istanbulDate(deps.now());
  const shortId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  // -------------------------------------------------------------------------
  // Aktor
  // -------------------------------------------------------------------------

  async function actorOf(ctx: ReservationContext): Promise<Actor> {
    if (MANAGER_ROLES.has(ctx.role)) return { kind: 'manager', userId: ctx.userId, role: ctx.role, unitIds: [], units: new Map() };
    if (ctx.role === 'observer') return { kind: 'observer', userId: ctx.userId, role: ctx.role, unitIds: [], units: new Map() };
    if (ctx.role === 'resident') {
      const d = today();
      const units = new Map<string, ResidentUnit>();
      for (const m of await deps.memberships.listMemberships(ctx.apartmentId, ctx.userId)) {
        if (m.apartmentId !== ctx.apartmentId || !activeOn(m, d)) continue;
        const cur = units.get(m.unitId);
        units.set(m.unitId, { since: cur && cur.since < m.startDate ? cur.since : m.startDate, payers: [...(cur?.payers ?? []), payerOfMembership(m)] });
      }
      return { kind: 'resident', userId: ctx.userId, role: ctx.role, unitIds: [...units.keys()], units };
    }
    throw new ReservationError('forbidden', 'Bu rol rezervasyon modülünü kullanamaz');
  }

  async function managerOf(ctx: ReservationContext): Promise<Actor> {
    const actor = await actorOf(ctx);
    if (actor.kind !== 'manager') throw new ReservationError('forbidden', 'Bu işlem yalnızca yönetim tarafından yapılabilir');
    return actor;
  }

  async function staffOf(ctx: ReservationContext): Promise<Actor> {
    const actor = await actorOf(ctx);
    if (actor.kind === 'resident') throw new ReservationError('forbidden', 'Bu ekran yönetim ekranıdır');
    return actor;
  }

  async function residentOf(ctx: ReservationContext): Promise<Actor> {
    const actor = await actorOf(ctx);
    if (actor.kind !== 'resident') throw new ReservationError('forbidden', 'Bu ekran sakin portalıdır');
    return actor;
  }

  const fctx = (ctx: ReservationContext) => ({ apartmentId: ctx.apartmentId, userId: ctx.userId });

  /**
   * KVKK: sakin bir rezervasyonu ancak o dairenin guncel uyesiyse ve rezervasyonu kendisi yaptiysa
   * ya da rezervasyon dairedeki uyeliginin baslangicindan sonra yapildiysa gorur, iptal eder ve
   * sinira sayar. Yeni kiraci onceki sakinin rezervasyonlarini gormez.
   */
  function entitled(actor: Actor, b: Pick<Booking, 'unitId' | 'createdBy' | 'createdAt'>): boolean {
    const u = actor.units.get(b.unitId);
    return !!u && (b.createdBy === actor.userId || istanbulDate(new Date(b.createdAt)) >= u.since);
  }

  /**
   * Ucretin yazilacagi taraf: rezervasyonu yapanin bu dairedeki uyeliginden. Birden fazla uyelik
   * farkli taraf veriyorsa veya kayit tutarsizsa (oturmayan kiraci) belirsizdir (undefined).
   */
  function payerOf(unit: ResidentUnit | undefined): BookingPayer | undefined {
    if (!unit || !unit.payers.length || unit.payers.some((p) => !p)) return undefined;
    const parties = new Set(unit.payers.map((p) => p?.liableParty));
    return parties.size === 1 ? unit.payers[0] : undefined;
  }

  async function write(apartmentId: string, w: ReservationWrite) {
    try {
      await repo.write(apartmentId, w);
    } catch (err) {
      if (err instanceof ReservationConflictError && err.reason === 'version') throw new ReservationError('conflict', err.message);
      if (err instanceof ReservationConflictError && err.reason === 'slot') throw new ReservationError('slot_taken', SLOT_TAKEN);
      if (err instanceof ReservationConflictError) throw new ReservationError('conflict', 'Kayıt başka bir işlemle değişti; sayfayı yenileyin');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Alan tanimi (yonetim)
  // -------------------------------------------------------------------------

  function parseHours(value: unknown): OpeningWindow[] {
    if (!Array.isArray(value) || value.length > 7) throw new ValidationError('openingHours en fazla 7 günlük bir dizi olmalı', 'openingHours');
    const seen = new Set<number>();
    const out = value.map((raw, i) => {
      const o = asObject(raw, `openingHours[${i}]`);
      const day = reqInt(o, 'day', 1, 7) as Weekday;
      if (seen.has(day)) throw new ValidationError('Aynı gün iki kez verilemez', 'openingHours');
      seen.add(day);
      const open = parseClock(o.open);
      const close = parseClock(o.close);
      if (open === undefined || close === undefined) throw new ValidationError('Açılış / kapanış SS:DD biçiminde olmalı', 'openingHours');
      if (open % SLOT_STEP_MINUTES || close % SLOT_STEP_MINUTES) throw new ValidationError('Açılış / kapanış saatleri :00 veya :30 olmalı', 'openingHours');
      if (close <= open) throw new ValidationError('Kapanış saati açılıştan sonra olmalı', 'openingHours');
      return { day, open: formatClock(open), close: formatClock(close) };
    });
    return out.sort((a, b) => a.day - b.day);
  }

  async function parseBlockIds(ctx: ReservationContext, value: unknown): Promise<string[] | undefined> {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > 50) throw new ValidationError('blockIds en fazla 50 öğeli bir dizi olmalı', 'blockIds');
    const ids = [...new Set(value.map((v, i) => assertId(v, `blockIds[${i}]`)))].sort();
    for (const id of ids) {
      const block = await deps.core.getBlock(ctx.apartmentId, id);
      if (!block || block.status !== 'active') throw new ReservationError('not_found', 'Blok bulunamadı');
    }
    return ids.length ? ids : undefined;
  }

  /** Alan alanlarini okur; verilmeyenler `current`ten (guncelleme) veya varsayilandan gelir. */
  async function readFacility(ctx: ReservationContext, o: Obj, current?: FacilityFields): Promise<FacilityFields> {
    const has = (k: string) => o[k] !== undefined;
    const name = has('name') ? reqString(o, 'name', 80, 2) : current?.name;
    if (!name) throw new ValidationError('name zorunlu', 'name');
    const description = has('description') ? (o.description === null || o.description === '' ? undefined : optString(o, 'description', 500)) : current?.description;
    const capacity = has('capacity') ? reqInt(o, 'capacity', 1, MAX_CAPACITY) : (current?.capacity ?? reqInt(o, 'capacity', 1, MAX_CAPACITY));
    const openingHours = has('openingHours') ? parseHours(o.openingHours) : current?.openingHours;
    if (!openingHours) throw new ValidationError('openingHours zorunlu', 'openingHours');
    let slotMinutes: SlotLength;
    if (has('slotMinutes')) {
      const v = o.slotMinutes;
      if (typeof v !== 'number' || !(SLOT_LENGTHS as readonly number[]).includes(v)) throw new ValidationError(`slotMinutes şu değerlerden biri olmalı: ${SLOT_LENGTHS.join(', ')}`, 'slotMinutes');
      slotMinutes = v as SlotLength;
    } else slotMinutes = current?.slotMinutes ?? 60;
    const maxBookingMinutes = has('maxBookingMinutes') ? reqInt(o, 'maxBookingMinutes', SLOT_STEP_MINUTES, MAX_BOOKING_MINUTES) : (current?.maxBookingMinutes ?? Math.min(slotMinutes * 2, MAX_BOOKING_MINUTES));
    if (maxBookingMinutes < slotMinutes || maxBookingMinutes % slotMinutes) throw new ValidationError('En uzun süre dilim uzunluğunun katı olmalı', 'maxBookingMinutes');
    for (const w of openingHours) {
      if ((parseClock(w.close) as number) - (parseClock(w.open) as number) < slotMinutes) throw new ValidationError('Açık kalma süresi en az bir dilim olmalı', 'openingHours');
    }
    const advanceDays = has('advanceDays') ? reqInt(o, 'advanceDays', 0, MAX_ADVANCE_DAYS) : (current?.advanceDays ?? 30);
    const maxActivePerUnit = has('maxActivePerUnit') ? reqInt(o, 'maxActivePerUnit', 1, MAX_ACTIVE_PER_UNIT) : (current?.maxActivePerUnit ?? 1);
    let requiresApproval = current?.requiresApproval ?? false;
    if (has('requiresApproval')) {
      if (typeof o.requiresApproval !== 'boolean') throw new ValidationError('requiresApproval true/false olmali', 'requiresApproval');
      requiresApproval = o.requiresApproval;
    }
    const cancelNoticeHours = has('cancelNoticeHours') ? reqInt(o, 'cancelNoticeHours', 0, MAX_CANCEL_NOTICE_HOURS) : (current?.cancelNoticeHours ?? 24);
    const blockIds = has('blockIds') ? await parseBlockIds(ctx, o.blockIds) : current?.blockIds;
    const feeKurus = has('feeKurus') ? reqInt(o, 'feeKurus', 0, MAX_FEE_KURUS) : (current?.feeKurus ?? 0);
    let incomeAccountId = has('incomeAccountId') ? (o.incomeAccountId === null || o.incomeAccountId === '' ? undefined : assertId(o.incomeAccountId, 'incomeAccountId')) : current?.incomeAccountId;
    if (feeKurus > 0) {
      if (!deps.finance) throw new ReservationError('unprocessable', 'Ücretli ortak alan için finans modülü gerekli');
      const resolved = await deps.finance.resolveIncomeAccount(fctx(ctx), incomeAccountId, 'incomeAccountId');
      incomeAccountId = resolved === DEFAULT_INCOME ? undefined : resolved;
    } else incomeAccountId = undefined;
    return {
      name,
      ...(description ? { description } : {}),
      capacity,
      openingHours,
      slotMinutes,
      maxBookingMinutes,
      advanceDays,
      maxActivePerUnit,
      requiresApproval,
      cancelNoticeHours,
      ...(blockIds?.length ? { blockIds } : {}),
      feeKurus,
      ...(incomeAccountId ? { incomeAccountId } : {}),
    };
  }

  function facilityView(f: Facility) {
    const { PK: _pk, SK: _sk, ...rest } = f;
    return rest;
  }

  /** Sakin gorunumu: yonetim alanlari (gelir hesabi, kayit eden) donmez. */
  function portalFacilityView(f: Facility) {
    const { PK: _pk, SK: _sk, incomeAccountId: _i, createdBy: _cb, updatedBy: _ub, ...rest } = f;
    return rest;
  }

  async function listFacilities(ctx: ReservationContext) {
    await staffOf(ctx);
    const items = (await repo.listFacilities(ctx.apartmentId)).sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || a.name.localeCompare(b.name, 'tr'));
    return { items: items.map(facilityView) };
  }

  /** Yeni alan. `idempotencyKey` ayni istegin tekrarini ikinci alana cevirmez. */
  async function createFacility(ctx: ReservationContext, body: unknown) {
    await managerOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const fields = await readFacility(ctx, o);
    const fp = fingerprint({ kind: 'facility', ...fields });
    const replay = async () => {
      const idem = await repo.getIdempotency(ctx.apartmentId, key);
      if (!idem) return undefined;
      if (idem.fingerprint !== fp || idem.kind !== 'facility') throw new ReservationError('conflict', 'Bu idempotencyKey farklı bir istek için kullanılmış');
      const f = await repo.getFacility(ctx.apartmentId, idem.targetId);
      if (!f) throw new ReservationError('conflict', 'Ortak alan oluşturma sürüyor; tekrar deneyin');
      return { facility: facilityView(f), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    const ts = stamp();
    const facilityId = `fac-${shortId()}`;
    const facility: Facility = {
      ...reservationKeys.facility(ctx.apartmentId, facilityId),
      entityType: 'RESERVATION_FACILITY',
      apartmentId: ctx.apartmentId,
      facilityId,
      ...fields,
      status: 'active',
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.write(ctx.apartmentId, {
        at: ts,
        facility: { item: facility, expectedVersion: 0 },
        idempotency: { ...reservationKeys.idempotency(ctx.apartmentId, key), entityType: 'RESERVATION_IDEMPOTENCY', apartmentId: ctx.apartmentId, kind: 'facility', targetId: facilityId, fingerprint: fp, createdAt: ts },
        audit: { apartmentId: ctx.apartmentId, action: 'reservation.facility_create', target: { type: 'facility', id: facilityId }, details: { name: fields.name, feeKurus: fields.feeKurus, requiresApproval: fields.requiresApproval } },
      });
    } catch (err) {
      if (err instanceof ReservationConflictError && err.reason === 'duplicate') {
        const r = await replay();
        if (r) return r;
      }
      if (err instanceof ReservationConflictError) throw new ReservationError('conflict', err.message);
      throw err;
    }
    return { facility: facilityView(facility), replayed: false };
  }

  /** Alan duzeltme ve pasife alma / yeniden acma (`status`). Silme yok. */
  async function updateFacility(ctx: ReservationContext, facilityId: string, body: unknown) {
    await managerOf(ctx);
    assertId(facilityId, 'facilityId');
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await repo.getFacility(ctx.apartmentId, facilityId);
    if (!current) throw new ReservationError('not_found', 'Ortak alan bulunamadı');
    if (current.version !== version) throw new ReservationError('conflict', 'Ortak alan başka bir işlemle değişti; sayfayı yenileyin');
    const fields = await readFacility(ctx, o, current);
    let status = current.status;
    if (o.status !== undefined) {
      if (o.status !== 'active' && o.status !== 'inactive') throw new ValidationError('status active veya inactive olmalı', 'status');
      status = o.status;
    }
    const changed = FACILITY_FIELDS.filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(current[k]));
    if (!changed.length && status === current.status) return { facility: facilityView(current) };
    const ts = stamp();
    const base = Object.fromEntries(Object.entries(current).filter(([k]) => !(FACILITY_FIELDS as readonly string[]).includes(k))) as Facility;
    const next: Facility = { ...base, ...fields, status, updatedAt: ts, updatedBy: ctx.userId, version: current.version + 1 };
    const action = status !== current.status ? (status === 'inactive' ? 'reservation.facility_deactivate' : 'reservation.facility_activate') : 'reservation.facility_update';
    await write(ctx.apartmentId, {
      at: ts,
      facility: { item: next, expectedVersion: version },
      audit: { apartmentId: ctx.apartmentId, action, target: { type: 'facility', id: facilityId }, details: { name: next.name, fields: changed, ...(status !== current.status ? { status } : {}) } },
    });
    return { facility: facilityView(next) };
  }

  // -------------------------------------------------------------------------
  // Gorunumler
  // -------------------------------------------------------------------------

  function timesOf(b: Pick<Booking, 'start' | 'end'>) {
    const startMin = istanbulMinutes(b.start);
    return { startTime: formatClock(startMin), endTime: formatClock(startMin + (Date.parse(b.end) - Date.parse(b.start)) / MINUTE), minutes: (Date.parse(b.end) - Date.parse(b.start)) / MINUTE };
  }

  function cancelDeadline(b: Booking, f: Pick<Facility, 'cancelNoticeHours'> | undefined): IsoDateTime {
    return new Date(Date.parse(b.start) - (f?.cancelNoticeHours ?? 0) * HOUR).toISOString();
  }

  function residentCanCancel(b: Booking, f: Facility | undefined, now: Date): boolean {
    return HOLDING_STATUSES.includes(b.status) && now.getTime() <= Date.parse(cancelDeadline(b, f));
  }

  function adminView(b: Booking, now: Date) {
    const { PK: _pk, SK: _sk, slots: _s, ...rest } = b;
    const nowIso = now.toISOString();
    return {
      ...rest,
      ...timesOf(b),
      expired: b.status === 'pending' && b.start <= nowIso,
      past: b.end <= nowIso,
      canApprove: b.status === 'pending' && b.start > nowIso,
      canCancel: HOLDING_STATUSES.includes(b.status),
      canRetryReversal: b.fee.status === 'reversal_pending',
    };
  }

  /** Sakin gorunumu: kendi dairesinin kaydi; diger kisilerin kullanici kimlikleri ve defter ayrintisi yok. */
  function residentView(actor: Actor, b: Booking, f: Facility | undefined, now: Date) {
    const nowIso = now.toISOString();
    return {
      bookingId: b.bookingId,
      facilityId: b.facilityId,
      facilityName: b.facilityName,
      unitId: b.unitId,
      date: b.date,
      start: b.start,
      end: b.end,
      ...timesOf(b),
      ...(b.partySize ? { partySize: b.partySize } : {}),
      ...(b.note ? { note: b.note } : {}),
      status: b.status,
      fee: { amount: b.fee.amount, status: b.fee.status },
      ...(b.status === 'rejected' && b.decisionNote ? { decisionNote: b.decisionNote } : {}),
      ...(b.cancelKind ? { cancelKind: b.cancelKind } : {}),
      ...(b.cancelKind === 'manager' && b.cancelReason ? { cancelReason: b.cancelReason } : {}),
      mine: b.createdBy === actor.userId,
      expired: b.status === 'pending' && b.start <= nowIso,
      past: b.end <= nowIso,
      canCancel: residentCanCancel(b, f, now),
      cancelDeadline: cancelDeadline(b, f),
      createdAt: b.createdAt,
      version: b.version,
    };
  }

  // -------------------------------------------------------------------------
  // Okuma (yonetim)
  // -------------------------------------------------------------------------

  function parseRange(q: { from?: string; to?: string }) {
    const from = q.from ?? today();
    const to = q.to ?? addDays(from, 6);
    if (!isIsoDate(from)) throw new ValidationError('from YYYY-AA-GG olmalı', 'from');
    if (!isIsoDate(to)) throw new ValidationError('to YYYY-AA-GG olmalı', 'to');
    const days = daysBetween(from, to);
    if (days < 0) throw new ValidationError('to, from tarihinden önce olamaz', 'to');
    if (days >= MAX_RANGE_DAYS) throw new ValidationError(`En fazla ${MAX_RANGE_DAYS} günlük aralık sorgulanabilir`, 'to');
    return { from, to, fromIso: istanbulInstant(from, 0), toIso: istanbulInstant(addDays(to, 1), 0) };
  }

  /** Takvim: alan(lar)in [from, to] gunlerindeki rezervasyonlari (iptaller dahil, `status` ile suzulur). */
  async function listBookings(ctx: ReservationContext, q: { facilityId?: string; from?: string; to?: string; status?: string } = {}) {
    await staffOf(ctx);
    const range = parseRange(q);
    let statuses: BookingStatus[] | undefined;
    if (q.status) {
      statuses = q.status.split(',').map((s) => {
        if (!(BOOKING_STATUSES as readonly string[]).includes(s)) throw new ValidationError('status geçersiz', 'status');
        return s as BookingStatus;
      });
    }
    const facilities = q.facilityId ? [assertId(q.facilityId, 'facilityId')] : (await repo.listFacilities(ctx.apartmentId)).map((f) => f.facilityId);
    const ids = (await Promise.all(facilities.map((id) => repo.listFacilityBookingIds(ctx.apartmentId, id, range.fromIso, range.toIso)))).flat();
    const now = deps.now();
    const items = (ids.length ? await repo.getBookings(ctx.apartmentId, ids) : [])
      .filter((b) => !statuses || statuses.includes(b.status))
      .sort((a, b) => a.start.localeCompare(b.start) || a.facilityName.localeCompare(b.facilityName, 'tr'));
    return { from: range.from, to: range.to, items: items.map((b) => adminView(b, now)) };
  }

  /**
   * Onay bekleyenler: baslangici gelmemis `pending` rezervasyonlar (en yakini once) ve iade
   * bekleyenler (`reversal_pending`: iptal edildi, ucretin ters kaydi yapilamadi).
   */
  async function pending(ctx: ReservationContext) {
    await staffOf(ctx);
    const now = deps.now();
    const nowIso = now.toISOString();
    const facilities = await repo.listFacilities(ctx.apartmentId);
    const ids = (
      await Promise.all(
        facilities.map((f) => repo.listFacilityBookingIds(ctx.apartmentId, f.facilityId, nowIso, istanbulInstant(addDays(today(), MAX_ADVANCE_DAYS + 1), 0))),
      )
    ).flat();
    const items = (ids.length ? await repo.getBookings(ctx.apartmentId, ids) : []).filter((b) => b.status === 'pending' && b.start > nowIso).sort((a, b) => a.start.localeCompare(b.start));
    const queued = await repo.listFeeQueue(ctx.apartmentId);
    const reversals = (queued.length ? await repo.getBookings(ctx.apartmentId, queued) : [])
      .filter((b) => b.fee.status === 'reversal_pending')
      .sort((a, b) => (a.cancelledAt ?? a.updatedAt).localeCompare(b.cancelledAt ?? b.updatedAt));
    return { items: items.map((b) => adminView(b, now)), total: items.length, reversals: reversals.map((b) => adminView(b, now)) };
  }

  async function loadBooking(ctx: ReservationContext, bookingId: string): Promise<Booking> {
    assertId(bookingId, 'bookingId');
    const b = await repo.getBooking(ctx.apartmentId, bookingId);
    if (!b || b.apartmentId !== ctx.apartmentId) throw new ReservationError('not_found', 'Rezervasyon bulunamadı');
    return b;
  }

  async function getBooking(ctx: ReservationContext, bookingId: string) {
    await staffOf(ctx);
    return { booking: adminView(await loadBooking(ctx, bookingId), deps.now()) };
  }

  // -------------------------------------------------------------------------
  // Sakin: alanlar, musaitlik, rezervasyonlarim
  // -------------------------------------------------------------------------

  async function residentUnits(ctx: ReservationContext, actor: Actor) {
    const units = await Promise.all(actor.unitIds.map((id) => deps.core.getUnit(ctx.apartmentId, id)));
    const active = units.filter((u): u is NonNullable<typeof u> => !!u && u.status === 'active');
    const blockNames = new Map<string, string>();
    for (const blockId of new Set(active.map((u) => u.blockId))) {
      const b = await deps.core.getBlock(ctx.apartmentId, blockId);
      if (b) blockNames.set(blockId, b.name);
    }
    return active
      .map((u) => ({ unitId: u.unitId, blockId: u.blockId, number: u.number, label: blockNames.has(u.blockId) ? `${blockNames.get(u.blockId)} · ${u.number}` : u.number }))
      .sort((a, b) => a.label.localeCompare(b.label, 'tr', { numeric: true }));
  }

  const openTo = (f: Facility, blockIds: readonly string[]) => !f.blockIds?.length || blockIds.some((b) => f.blockIds?.includes(b));

  async function portalFacilities(ctx: ReservationContext) {
    const actor = await residentOf(ctx);
    const units = await residentUnits(ctx, actor);
    const blocks = units.map((u) => u.blockId);
    const facilities = units.length ? (await repo.listFacilities(ctx.apartmentId)).filter((f) => f.status === 'active' && openTo(f, blocks)) : [];
    return {
      units,
      today: today(),
      items: facilities.sort((a, b) => a.name.localeCompare(b.name, 'tr')).map((f) => ({ ...portalFacilityView(f), unitIds: units.filter((u) => openTo(f, [u.blockId])).map((u) => u.unitId) })),
    };
  }

  async function portalFacility(ctx: ReservationContext, actor: Actor, facilityId: string): Promise<{ facility: Facility; units: Awaited<ReturnType<typeof residentUnits>> }> {
    assertId(facilityId, 'facilityId');
    const facility = await repo.getFacility(ctx.apartmentId, facilityId);
    const units = await residentUnits(ctx, actor);
    // Kapali / blok disi alanin varligi da sizdirilmaz.
    if (!facility || facility.status !== 'active' || !openTo(facility, units.map((u) => u.blockId))) throw new ReservationError('not_found', 'Ortak alan bulunamadı');
    return { facility, units };
  }

  /**
   * Bir gunun dilimleri: `free` / `busy` (baska daire; kim oldugu donmez) / `mine` (kendi
   * dairelerimden biri) / `past`. Gun rezervasyon penceresi disindaysa `bookable: false`.
   */
  async function availability(ctx: ReservationContext, facilityId: string, date: string | undefined) {
    const actor = await residentOf(ctx);
    if (!date || !isIsoDate(date)) throw new ValidationError('date YYYY-AA-GG olmalı', 'date');
    const { facility } = await portalFacility(ctx, actor, facilityId);
    const now = deps.now();
    const ahead = daysBetween(today(), date);
    const held = await repo.listHeldSlots(ctx.apartmentId, facility.facilityId, istanbulInstant(date, 0), istanbulInstant(date, 1440));
    // Kendi dairemdeki dilimler yalnizca gorme hakkim olan rezervasyonlarsa "mine"; digerleri "busy".
    const ownHeld = held.filter((s) => actor.unitIds.includes(s.unitId));
    const ownBookings = ownHeld.length ? await repo.getBookings(ctx.apartmentId, [...new Set(ownHeld.map((s) => s.bookingId))]) : [];
    const mineIds = new Set(ownBookings.filter((b) => entitled(actor, b)).map((b) => b.bookingId));
    const holder = new Map(held.map((s) => [s.slotStart, mineIds.has(s.bookingId) ? 'mine' : 'busy']));
    const w = windowOn(facility.openingHours, date);
    const slots = slotGrid(facility, date).map((g) => {
      const startAt = istanbulInstant(date, g.start);
      const atoms = lockSlotsOf(startAt, istanbulInstant(date, g.end));
      const holders = atoms.map((a) => holder.get(a)).filter((u): u is string => !!u);
      const state = Date.parse(startAt) <= now.getTime() ? 'past' : holders.includes('busy') ? 'busy' : holders.length ? 'mine' : 'free';
      return { start: formatClock(g.start), end: formatClock(g.end), startAt, state };
    });
    return {
      facilityId: facility.facilityId,
      date,
      open: !!w,
      ...(w ? { window: { open: formatClock(w.open), close: formatClock(w.close) } } : {}),
      bookable: !!w && ahead >= 0 && ahead <= facility.advanceDays,
      lastBookableDate: addDays(today(), facility.advanceDays),
      slotMinutes: facility.slotMinutes,
      maxBookingMinutes: facility.maxBookingMinutes,
      slots,
    };
  }

  async function myBookings(ctx: ReservationContext) {
    const actor = await residentOf(ctx);
    const now = deps.now();
    const from = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
    const ids = (await Promise.all(actor.unitIds.map((u) => repo.listUnitBookingIds(ctx.apartmentId, u, from)))).flat();
    const bookings = (ids.length ? await repo.getBookings(ctx.apartmentId, ids) : []).filter((b) => entitled(actor, b));
    const facilities = new Map((await repo.listFacilities(ctx.apartmentId)).map((f) => [f.facilityId, f]));
    const nowIso = now.toISOString();
    const upcoming = bookings.filter((b) => b.end > nowIso && b.status !== 'cancelled' && b.status !== 'rejected').sort((a, b) => a.start.localeCompare(b.start));
    const history = bookings.filter((b) => !upcoming.includes(b)).sort((a, b) => b.start.localeCompare(a.start));
    return {
      upcoming: upcoming.map((b) => residentView(actor, b, facilities.get(b.facilityId), now)),
      history: history.map((b) => residentView(actor, b, facilities.get(b.facilityId), now)),
    };
  }

  // -------------------------------------------------------------------------
  // Sakin: rezervasyon
  // -------------------------------------------------------------------------

  /** Daire basina sinira sayilanlar: aktorun gorme hakki olan (bkz. `entitled`) bitmemis rezervasyonlar. */
  async function activeBookings(apartmentId: string, actor: Actor, unitId: string, facilityId: string, now: Date): Promise<Booking[]> {
    const ids = await repo.listUnitBookingIds(apartmentId, unitId, new Date(now.getTime() - MAX_BOOKING_MINUTES * MINUTE).toISOString());
    const nowIso = now.toISOString();
    return (ids.length ? await repo.getBookings(apartmentId, ids) : []).filter(
      (b) => b.facilityId === facilityId && HOLDING_STATUSES.includes(b.status) && b.end > nowIso && entitled(actor, b),
    );
  }

  /**
   * Yeni rezervasyon (sakin, kendi dairesi icin). Kurallar: aktif alan, blok kisiti, acik gun ve
   * saatler, izgara + sure, gecmis saat yok, rezervasyon penceresi, daire basina aktif siniri, kisi
   * sayisi <= kapasite. Dilim kilitleri + daire sayaci + rezervasyon + indeksler + denetim tek atomik
   * yazim. Onay gerektiren alanda `pending`; gerektirmeyen ucretsiz alanda `confirmed`; ucretli alanda
   * hemen tahakkukla onaylanir (tahakkuk yapilamazsa yonetici onayina duser).
   */
  async function book(ctx: ReservationContext, body: unknown) {
    const actor = await residentOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const facilityId = assertId(o.facilityId, 'facilityId');
    const unitId = assertId(o.unitId, 'unitId');
    const date = typeof o.date === 'string' && isIsoDate(o.date) ? o.date : undefined;
    if (!date) throw new ValidationError('date YYYY-AA-GG olmalı', 'date');
    const start = parseClock(o.start);
    if (start === undefined || start >= 1440) throw new ValidationError('start SS:DD biçiminde olmalı', 'start');
    const minutes = reqInt(o, 'minutes', SLOT_STEP_MINUTES, MAX_BOOKING_MINUTES);
    const partySize = optInt(o, 'partySize', 1, MAX_CAPACITY);
    const note = optString(o, 'note', 300);
    const fp = fingerprint({ kind: 'booking', facilityId, unitId, date, start, minutes, partySize, note, by: ctx.userId });

    const replay = async () => {
      const idem = await repo.getIdempotency(ctx.apartmentId, key);
      if (!idem) return undefined;
      if (idem.fingerprint !== fp || idem.kind !== 'booking') throw new ReservationError('conflict', 'Bu idempotencyKey farklı bir istek için kullanılmış');
      let b = await repo.getBooking(ctx.apartmentId, idem.targetId);
      if (!b) throw new ReservationError('conflict', 'Rezervasyon oluşturma sürüyor; tekrar deneyin');
      // Yarim kalan otomatik onay (ucretli alan) ayni istekle tamamlanir.
      if (b.status === 'pending' && b.autoConfirm) b = (await tryAutoConfirm(ctx, b)).booking;
      return { booking: residentView(actor, b, await repo.getFacility(ctx.apartmentId, b.facilityId), deps.now()), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    if (!actor.unitIds.includes(unitId)) throw new ReservationError('forbidden', 'Yalnızca üyesi olduğunuz daire için rezervasyon yapabilirsiniz');
    const { facility, units } = await portalFacility(ctx, actor, facilityId);
    const fee = facility.feeKurus;
    // Ucret tarafi rezervasyonu yapanin uyeliginden; belirsizse ucretli alanda tahmin edilmez.
    const payer = payerOf(actor.units.get(unitId));
    if (fee > 0 && !payer) {
      throw new ReservationError('unprocessable', 'Bu dairedeki üyelik kaydınızdan ücretin kime yazılacağı belirlenemiyor (malik / kiracı / oturma durumu). Lütfen yönetimle iletişime geçin.');
    }
    if (fee > 0 && payer?.liableParty === 'owner' && (await deps.ownership.billingOf(ctx.apartmentId, unitId)) === 'split') {
      throw new ReservationError('unprocessable', 'Hisseli faturalanan dairede, dairede oturmayan malik adına ücretli rezervasyon yapılamaz (ücret paydaşlara bölünürdü). Lütfen yönetimle iletişime geçin.');
    }
    const unit = units.find((u) => u.unitId === unitId);
    if (!unit) throw new ReservationError('not_found', 'Bağımsız bölüm bulunamadı');
    if (!openTo(facility, [unit.blockId])) throw new ReservationError('forbidden', 'Bu ortak alan dairenizin bloğuna açık değil');
    if (partySize !== undefined && partySize > facility.capacity) throw new ValidationError(`Kişi sayısı en fazla ${facility.capacity} olabilir`, 'partySize');
    const timeError = bookingTimeError(facility, date, start, minutes);
    if (timeError) throw new ReservationError('unprocessable', timeError);
    const startIso = istanbulInstant(date, start);
    const endIso = istanbulInstant(date, start + minutes);
    const now = deps.now();
    if (Date.parse(startIso) <= now.getTime()) throw new ReservationError('unprocessable', 'Geçmiş bir saate rezervasyon yapılamaz');
    if (daysBetween(today(), date) > facility.advanceDays) {
      throw new ReservationError('unprocessable', `Bu alan için en fazla ${facility.advanceDays} gün sonrasına rezervasyon yapılabilir (${trDate(addDays(today(), facility.advanceDays))})`);
    }
    const slots = lockSlotsOf(startIso, endIso);
    const bookingId = `${date.replaceAll('-', '')}-${shortId()}`;
    const status: BookingStatus = facility.requiresApproval || fee > 0 ? 'pending' : 'confirmed';
    const autoConfirm = !facility.requiresApproval && fee > 0;

    for (let attempt = 1; ; attempt++) {
      const guard = await repo.getGuard(ctx.apartmentId, facilityId, unitId);
      const active = await activeBookings(ctx.apartmentId, actor, unitId, facilityId, now);
      if (active.length >= facility.maxActivePerUnit) {
        throw new ReservationError('unprocessable', `Bu alan için daire başına en fazla ${facility.maxActivePerUnit} aktif rezervasyon yapılabilir`);
      }
      const ts = stamp();
      const booking: Booking = {
        ...reservationKeys.booking(ctx.apartmentId, bookingId),
        entityType: 'RESERVATION_BOOKING',
        apartmentId: ctx.apartmentId,
        bookingId,
        facilityId,
        facilityName: facility.name,
        unitId,
        ...(unit.blockId ? { blockId: unit.blockId } : {}),
        date,
        start: startIso,
        end: endIso,
        slots,
        ...(partySize ? { partySize } : {}),
        ...(note ? { note } : {}),
        status,
        createdByRole: ctx.role,
        ...(payer ? { payer } : {}),
        ...(autoConfirm ? { autoConfirm } : {}),
        fee: fee > 0 ? { amount: fee, status: 'pending', ...(facility.incomeAccountId ? { incomeAccountId: facility.incomeAccountId } : {}) } : { amount: 0, status: 'none' },
        ...(status === 'confirmed' ? { decidedAt: ts, decidedBy: ctx.userId } : {}),
        createdAt: ts,
        createdBy: ctx.userId,
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: 1,
      };
      const index = (k: { PK: string; SK: string }): BookingIndex => ({ ...k, entityType: 'RESERVATION_INDEX', apartmentId: ctx.apartmentId, bookingId, facilityId, unitId, start: startIso });
      try {
        await repo.write(ctx.apartmentId, {
          at: ts,
          booking: { item: booking, expectedVersion: 0 },
          // Alan bu arada duzenlendiyse / pasife alindiysa eski kurallarla yazilmaz.
          facilityCheck: { facilityId, version: facility.version },
          hold: slots.map((slotStart) => lockOf(ctx.apartmentId, booking, slotStart, ts)),
          guard: { facilityId, unitId, expected: guard },
          indexes: [index(reservationKeys.facilityIndex(ctx.apartmentId, facilityId, startIso, bookingId)), index(reservationKeys.unitIndex(ctx.apartmentId, unitId, startIso, bookingId))],
          idempotency: { ...reservationKeys.idempotency(ctx.apartmentId, key), entityType: 'RESERVATION_IDEMPOTENCY', apartmentId: ctx.apartmentId, kind: 'booking', targetId: bookingId, fingerprint: fp, createdAt: ts },
          audit: {
            apartmentId: ctx.apartmentId,
            action: 'reservation.book',
            target: { type: 'reservation', id: bookingId },
            details: { facilityId, facility: facility.name, unitId, date, start: formatClock(start), minutes, status, feeKurus: fee, ...(payer ? { liableParty: payer.liableParty } : {}) },
          },
        });
      } catch (err) {
        if (err instanceof ReservationConflictError && err.reason === 'duplicate') {
          const r = await replay();
          if (r) return r;
        }
        if (err instanceof ReservationConflictError && err.reason === 'guard' && attempt < WRITE_RETRIES) continue;
        if (err instanceof ReservationConflictError && err.reason === 'slot') throw new ReservationError('slot_taken', SLOT_TAKEN);
        if (err instanceof ReservationConflictError && err.reason === 'facility') {
          throw new ReservationError('conflict', 'Ortak alanın kuralları bu arada değişti veya alan rezervasyona kapatıldı; sayfayı yenileyip tekrar deneyin');
        }
        if (err instanceof ReservationConflictError && err.reason === 'contention') {
          // Es zamanli yazim yarisi: dilim baska rezervasyonca alindiysa dolu, degilse tekrar denenebilir.
          const held = await repo.listHeldSlots(ctx.apartmentId, facilityId, startIso, endIso);
          if (held.some((h) => h.bookingId !== bookingId)) throw new ReservationError('slot_taken', SLOT_TAKEN);
        }
        if (err instanceof ReservationConflictError) throw new ReservationError('conflict', 'Aynı anda başka bir rezervasyon işlendi; tekrar deneyin');
        throw err;
      }
      if (!autoConfirm) return { booking: residentView(actor, booking, facility, deps.now()), replayed: false };
      const confirmed = await tryAutoConfirm(ctx, booking);
      return { booking: residentView(actor, confirmed.booking, facility, deps.now()), replayed: false, ...(confirmed.error ? { warning: confirmed.error } : {}) };
    }
  }

  function lockOf(apartmentId: string, b: Booking, slotStart: IsoDateTime, at: IsoDateTime): SlotLock {
    return {
      ...reservationKeys.slot(apartmentId, b.facilityId, slotStart),
      entityType: 'RESERVATION_SLOT',
      apartmentId,
      facilityId: b.facilityId,
      slotStart,
      state: 'held',
      bookingId: b.bookingId,
      unitId: b.unitId,
      at,
    };
  }

  // -------------------------------------------------------------------------
  // Onay, ret, iptal
  // -------------------------------------------------------------------------

  const touch = (ctx: ReservationContext, b: Booking, ts: IsoDateTime) => ({ updatedAt: ts, updatedBy: ctx.userId, version: b.version + 1 });

  /**
   * `pending` -> `confirmed`. Ucretli rezervasyonda Finans `chargeUnit` (oturan alt carisi) ve
   * rezervasyon guncellemesi AYNI atomik yazimdadir (`replaceRecords`, surum kosullu); ucretsizde
   * yalnizca rezervasyon + denetim.
   */
  async function confirm(ctx: ReservationContext, booking: Booking, opts: { action: string; note?: string }): Promise<Booking> {
    if (booking.fee.amount > 0) {
      if (!deps.finance) throw new ReservationError('unprocessable', 'Ücret tahakkuku için finans modülü gerekli');
      let confirmed: Booking | undefined;
      const day = today();
      const payer = booking.payer ?? { liableParty: 'occupant', relation: 'tenant' };
      // Ucret, rezervasyonu yapanin tarafina yazilir: o kisi hala dairenin ayni taraftan uyesi olmali
      // (onay gunu dairede kim oturuyorsa ona degil).
      const bookerParties = (await deps.memberships.listMemberships(ctx.apartmentId, booking.createdBy))
        .filter((m) => m.apartmentId === ctx.apartmentId && m.unitId === booking.unitId && activeOn(m, day))
        .map((m) => payerOfMembership(m)?.liableParty);
      if (!bookerParties.includes(payer.liableParty)) {
        throw new ReservationError('unprocessable', 'Rezervasyonu yapan kişinin bu dairedeki üyeliği sona ermiş veya değişmiş; ücret kime yazılacağı belirsiz. Rezervasyonu reddedin veya iptal edin.');
      }
      const r = await deps.finance.chargeUnit(
        fctx(ctx),
        {
          idempotencyKey: `RSVFEE_${booking.bookingId}`,
          unitId: booking.unitId,
          liableParty: payer.liableParty,
          amount: booking.fee.amount,
          date: day,
          dueDate: booking.date > day ? booking.date : day,
          description: `Ortak alan rezervasyonu: ${booking.facilityName} ${trDate(booking.date)} ${timesOf(booking).startTime}`.slice(0, 200),
          ...(booking.fee.incomeAccountId ? { incomeAccountId: booking.fee.incomeAccountId } : {}),
        },
        {
          fp: { reservation: booking.bookingId },
          reference: `RSV:${booking.bookingId}`,
          async build({ transaction }) {
            const cur = await repo.getBooking(ctx.apartmentId, booking.bookingId);
            if (!cur || cur.status !== 'pending') throw new ReservationError('conflict', 'Rezervasyon başka bir işlemle değişti; sayfayı yenileyin');
            // Finans bos daire / hisse kurallariyla baska bir cariye yonlendirdiyse yazim yapilmaz.
            const debits = transaction.lines.filter((l) => l.side === 'debit');
            if (debits.length !== 1 || debits[0]?.liableParty !== payer.liableParty) {
              throw new ReservationError('unprocessable', 'Ücret rezervasyonu yapan tarafın carisine yazılamıyor (daire boş görünüyor veya hisseli faturalama); rezervasyonu reddedin veya iptal edin.');
            }
            const { error: _e, ...fee } = cur.fee;
            const next: Booking = {
              ...cur,
              status: 'confirmed',
              fee: { ...fee, status: 'charged', transactionId: transaction.transactionId, chargedAt: transaction.createdAt },
              decidedAt: transaction.createdAt,
              decidedBy: ctx.userId,
              ...(opts.note ? { decisionNote: opts.note } : {}),
              ...touch(ctx, cur, transaction.createdAt),
            };
            confirmed = next;
            return {
              replaceRecords: [{ item: next, expectedVersion: cur.version, label: 'reservation' }],
              auditDetails: { reservation: { action: opts.action, bookingId: cur.bookingId, facilityId: cur.facilityId, unitId: cur.unitId, date: cur.date, start: timesOf(cur).startTime, liableParty: payer.liableParty } },
            };
          },
        },
      );
      if (confirmed && !r.replayed) return confirmed;
      const fresh = await loadBooking(ctx, booking.bookingId);
      if (fresh.status !== 'confirmed') throw new ReservationError('conflict', 'Rezervasyon başka bir işlemle değişti; sayfayı yenileyin');
      return fresh;
    }
    const ts = stamp();
    const next: Booking = { ...booking, status: 'confirmed', decidedAt: ts, decidedBy: ctx.userId, ...(opts.note ? { decisionNote: opts.note } : {}), ...touch(ctx, booking, ts) };
    await write(ctx.apartmentId, {
      at: ts,
      booking: { item: next, expectedVersion: booking.version },
      audit: { apartmentId: ctx.apartmentId, action: opts.action, target: { type: 'reservation', id: booking.bookingId }, details: { facilityId: booking.facilityId, unitId: booking.unitId, date: booking.date, from: 'pending', to: 'confirmed' } },
    });
    return next;
  }

  const domainMessage = (err: unknown) =>
    err instanceof ReservationError || err instanceof FinanceError || err instanceof ValidationError || err instanceof PeriodClosedError ? err.message : undefined;

  /** Onay gerektirmeyen ucretli alan: tahakkuk yapilamazsa rezervasyon yonetici onayina duser. */
  async function tryAutoConfirm(ctx: ReservationContext, booking: Booking): Promise<{ booking: Booking; error?: string }> {
    try {
      return { booking: await confirm(ctx, booking, { action: 'reservation.auto_confirm' }) };
    } catch (err) {
      const message = domainMessage(err);
      if (!message) console.error(err);
      const error = `Ücret tahakkuk edilemedi; rezervasyon yönetici onayına düştü${message ? ` (${message})` : ''}`.slice(0, 300);
      const cur = (await repo.getBooking(ctx.apartmentId, booking.bookingId)) ?? booking;
      if (cur.status !== 'pending') return { booking: cur };
      const next: Booking = { ...cur, autoConfirm: false, fee: { ...cur.fee, error }, ...touch(ctx, cur, stamp()) };
      try {
        await repo.write(ctx.apartmentId, { at: next.updatedAt, booking: { item: next, expectedVersion: cur.version } });
        return { booking: next, error };
      } catch {
        return { booking: cur, error };
      }
    }
  }

  function parseVersion(o: Obj): number {
    return reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
  }

  function assertVersion(b: Booking, version: number) {
    if (b.version !== version) throw new ReservationError('conflict', 'Rezervasyon başka bir işlemle değişti; sayfayı yenileyin');
  }

  function reqReason(o: Obj, key: string): string {
    const text = reqString(o, key, 300, 1).trim();
    if (text.length < 3) throw new ValidationError('Bu işlem için açıklama gerekli (en az 3 karakter)', key);
    return text;
  }

  /** Yonetici onayi (`pending`, baslangic gelmemis). Ucretliyse tahakkukla birlikte. */
  async function approve(ctx: ReservationContext, bookingId: string, body: unknown) {
    await managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const note = optString(o, 'note', 300);
    const booking = await loadBooking(ctx, bookingId);
    if (booking.status !== 'pending') throw new ReservationError('invalid_state', 'Yalnızca onay bekleyen rezervasyon onaylanabilir');
    assertVersion(booking, version);
    if (Date.parse(booking.start) <= deps.now().getTime()) throw new ReservationError('invalid_state', 'Başlangıç saati geçmiş rezervasyon onaylanamaz');
    const next = await confirm(ctx, booking, { action: 'reservation.approve', ...(note ? { note } : {}) });
    return { booking: adminView(next, deps.now()) };
  }

  /** Yonetici reddi (gerekceli): dilimler serbest kalir; tahakkuk yapilmamistir. */
  async function reject(ctx: ReservationContext, bookingId: string, body: unknown) {
    await managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const reason = reqReason(o, 'reason');
    const booking = await loadBooking(ctx, bookingId);
    if (booking.status !== 'pending') throw new ReservationError('invalid_state', 'Yalnızca onay bekleyen rezervasyon reddedilebilir');
    assertVersion(booking, version);
    const ts = stamp();
    const next: Booking = {
      ...booking,
      status: 'rejected',
      autoConfirm: false,
      fee: booking.fee.amount > 0 ? { ...booking.fee, status: 'void' } : booking.fee,
      decidedAt: ts,
      decidedBy: ctx.userId,
      decisionNote: reason,
      ...touch(ctx, booking, ts),
    };
    await write(ctx.apartmentId, {
      at: ts,
      booking: { item: next, expectedVersion: version },
      release: booking.slots.map((s) => lockOf(ctx.apartmentId, booking, s, ts)),
      audit: { apartmentId: ctx.apartmentId, action: 'reservation.reject', target: { type: 'reservation', id: bookingId }, reason, details: { facilityId: booking.facilityId, unitId: booking.unitId, date: booking.date } },
    });
    return { booking: adminView(next, deps.now()) };
  }

  /**
   * Iptal. Sakin: gorme hakki oldugu (bkz. `entitled`) bekleyen / onayli rezervasyon, alanin iptal
   * suresi dolmadan. Yonetici: gerekceyle her zaman. Ucret tahakkuk edildiyse Finans ters kaydi
   * yapilir; iptal yazildiktan sonra ters kayit hatasi istegi BOZMAZ: hata rezervasyona yazilir,
   * yanit `warning` tasir ve kayit yonetimin iade kuyruguna (`RFEEQ#`) duser. Yonetici ayni ucla
   * yeniden dener veya `fee-resolved` ile elle cozuldu olarak isaretler.
   */
  async function cancel(ctx: ReservationContext, bookingId: string, body: unknown) {
    const actor = await actorOf(ctx);
    if (actor.kind === 'observer') throw new ReservationError('forbidden', 'Denetçi rezervasyon iptal edemez');
    const o = asObject(body);
    const version = parseVersion(o);
    const booking = await loadBooking(ctx, bookingId);
    // Sakin gorme hakki olmayan rezervasyonun (baska daire, onceki sakin) varligini da ogrenmez.
    if (actor.kind === 'resident' && !entitled(actor, booking)) throw new ReservationError('not_found', 'Rezervasyon bulunamadı');
    assertVersion(booking, version);
    const now = deps.now();
    const facility = await repo.getFacility(ctx.apartmentId, booking.facilityId);
    const view = (b: Booking) => (actor.kind === 'resident' ? residentView(actor, b, facility, deps.now()) : adminView(b, deps.now()));
    const result = (r: { booking: Booking; warning?: string }) => ({ booking: view(r.booking), ...(r.warning ? { warning: r.warning } : {}) });

    if (!HOLDING_STATUSES.includes(booking.status)) {
      // Yarida kalan ucret iadesi: yalnizca yonetim yeniden dener.
      if (booking.fee.status === 'reversal_pending' && actor.kind === 'manager') return result(await reverseFee(ctx, booking));
      throw new ReservationError('invalid_state', 'Rezervasyon zaten iptal edilmiş veya reddedilmiş');
    }
    let reason: string | undefined;
    if (actor.kind === 'manager') reason = reqReason(o, 'reason');
    else {
      reason = optString(o, 'reason', 300);
      if (now.getTime() > Date.parse(cancelDeadline(booking, facility))) {
        const hours = facility?.cancelNoticeHours ?? 0;
        throw new ReservationError('unprocessable', hours ? `Rezervasyon en geç başlangıçtan ${hours} saat önce iptal edilebilir` : 'Başlamış rezervasyon iptal edilemez');
      }
    }
    const ts = now.toISOString();
    const charged = booking.fee.status === 'charged';
    const next: Booking = {
      ...booking,
      status: 'cancelled',
      autoConfirm: false,
      fee: booking.fee.amount > 0 ? { ...booking.fee, status: charged ? 'reversal_pending' : 'void' } : booking.fee,
      cancelledAt: ts,
      cancelledBy: ctx.userId,
      cancelKind: actor.kind === 'manager' ? 'manager' : 'resident',
      ...(reason ? { cancelReason: reason } : {}),
      ...touch(ctx, booking, ts),
    };
    await write(ctx.apartmentId, {
      at: ts,
      booking: { item: next, expectedVersion: version },
      release: booking.slots.map((s) => lockOf(ctx.apartmentId, booking, s, ts)),
      // Iade tamamlanana kadar yonetimin iade kuyrugunda gorunur (okuma guncel ucret durumuna gore suzer).
      ...(charged
        ? { indexes: [{ ...reservationKeys.feeQueue(ctx.apartmentId, bookingId), entityType: 'RESERVATION_INDEX' as const, apartmentId: ctx.apartmentId, bookingId, facilityId: booking.facilityId, unitId: booking.unitId, start: booking.start }] }
        : {}),
      audit: {
        apartmentId: ctx.apartmentId,
        action: 'reservation.cancel',
        target: { type: 'reservation', id: bookingId },
        ...(reason ? { reason } : {}),
        details: { facilityId: booking.facilityId, unitId: booking.unitId, date: booking.date, from: booking.status, by: next.cancelKind, ...(charged ? { feeTransactionId: booking.fee.transactionId } : {}) },
      },
    });
    return result(charged ? await reverseFee(ctx, next) : { booking: next });
  }

  const REVERSAL_WARNING = 'Rezervasyon iptal edildi; ücret iadesi (ters kayıt) yapılamadı ve yönetimin iade kuyruğuna alındı.';

  /**
   * Tahakkuk edilmis ucretin Finans ters kaydi (idempotent: `REV_<islem>`; zaten ters kaydedildiyse
   * yalnizca rezervasyon isaretlenir). Iptal zaten yazilmistir: hicbir hata disari firlatilmaz; hata
   * metni rezervasyona (`fee.error`) yazilir ve `warning` doner.
   */
  async function reverseFee(ctx: ReservationContext, booking: Booking): Promise<{ booking: Booking; warning?: string }> {
    const txId = booking.fee.transactionId;
    let fee: Booking['fee'];
    try {
      if (!txId || !deps.finance) throw new ReservationError('unprocessable', 'Ters kayıt için finans işlemi bulunamadı');
      const finance = deps.finance;
      if (!(await finance.isReversed(fctx(ctx), txId))) {
        await finance.reverseTransaction(fctx(ctx), txId, { reason: `Rezervasyon iptali: ${booking.facilityName} ${trDate(booking.date)} ${timesOf(booking).startTime}`.slice(0, 300) });
      }
      const { error: _e, ...rest } = booking.fee;
      fee = { ...rest, status: 'reversed', reversedAt: stamp() };
    } catch (err) {
      const message = domainMessage(err);
      if (!message) console.error(err);
      fee = { ...booking.fee, status: 'reversal_pending', error: `Ücret iadesi (ters kayıt) yapılamadı: ${message ?? 'beklenmeyen hata'}`.slice(0, 300) };
    }
    const next: Booking = { ...booking, fee, ...touch(ctx, booking, stamp()) };
    const warning = fee.status === 'reversal_pending' ? REVERSAL_WARNING : undefined;
    try {
      await repo.write(ctx.apartmentId, { at: next.updatedAt, booking: { item: next, expectedVersion: booking.version } });
      return { booking: next, ...(warning ? { warning } : {}) };
    } catch (err) {
      // Es zamanli guncelleme veya gecici hata: ters kayit idempotent; kayit iade kuyrugunda kalir.
      if (!(err instanceof ReservationConflictError)) console.error(err);
      const fresh = await repo.getBooking(ctx.apartmentId, booking.bookingId).catch(() => undefined);
      const shown = fresh ?? next;
      return { booking: shown, ...(shown.fee.status === 'reversal_pending' ? { warning: REVERSAL_WARNING } : {}) };
    }
  }

  /**
   * Finans engeli (ornegin kalem yapilandirma planina bagli) nedeniyle ters kaydi yapilamayan ucreti
   * yonetici gerekceyle "elle cozuldu" olarak isaretler (denetimli; defter degismez, duzeltme Finans'ta).
   */
  async function resolveFeeManually(ctx: ReservationContext, bookingId: string, body: unknown) {
    await managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const reason = reqReason(o, 'reason');
    const booking = await loadBooking(ctx, bookingId);
    if (booking.fee.status !== 'reversal_pending') throw new ReservationError('invalid_state', 'Yalnızca iadesi bekleyen ücret elle çözüldü olarak işaretlenebilir');
    assertVersion(booking, version);
    const ts = stamp();
    const { error: _e, ...rest } = booking.fee;
    const next: Booking = { ...booking, fee: { ...rest, status: 'resolved_manually', resolvedNote: reason, resolvedAt: ts, resolvedBy: ctx.userId }, ...touch(ctx, booking, ts) };
    await write(ctx.apartmentId, {
      at: ts,
      booking: { item: next, expectedVersion: version },
      audit: {
        apartmentId: ctx.apartmentId,
        action: 'reservation.fee_manual_resolve',
        target: { type: 'reservation', id: bookingId },
        reason,
        details: { unitId: booking.unitId, feeKurus: booking.fee.amount, feeTransactionId: booking.fee.transactionId, lastError: booking.fee.error },
      },
    });
    return { booking: adminView(next, deps.now()) };
  }

  return {
    listFacilities,
    createFacility,
    updateFacility,
    listBookings,
    pending,
    getBooking,
    approve,
    reject,
    cancel,
    resolveFeeManually,
    portalFacilities,
    availability,
    myBookings,
    book,
  };
}

export type ReservationService = ReturnType<typeof createReservationService>;
