/**
 * Guvenlik kapisi servisi: arac plakalari ve plaka sorgusu, misafir gecisleri (QR jetonu + kisa kod),
 * kurye kaydi ve sakin onayi, kapi gunlugu.
 *
 * Yetki: apartman ve rol JWT claim'lerinden, sakinin daireleri guncel uyelik kayitlarindan gelir
 * (istek govdesindeki kimlik kullanilmaz). Sakin yalnizca OTURDUGU bolumleri (kiraci veya dairede
 * oturan malik) yonetir; oturmayan malik ziyaretci kayitlarini gormez (KVKK: en az veri).
 * Gorevli plaka / gecis sorgusunda yalnizca bolum (blok + daire no), gecerlilik ve not gorur;
 * sakinin adi, telefonu, e-postasi veya borcu hicbir gorevli yanitinda yoktur.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type ApartmentRoleRepository, apartmentRoleRepository } from '../apartment-roles/repository.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { Block, IsoDate, IsoDateTime, Unit } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, reqEnum, reqInt, reqString } from '../core/validation.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import type { AuditDraft } from '../audit/log.js';
import { GateError, type GateErrorCode } from './errors.js';
import {
  TOKEN_RE,
  VERDICT_MESSAGES,
  addDays,
  daySpan,
  formatPlate,
  indexTtl,
  isTurkishPlate,
  istanbulDay,
  istanbulDayStart,
  newPassToken,
  newShortCode,
  normalizePlate,
  normalizeShortCode,
  passActions,
  passVerdict,
  plateQuery,
  reversePlate,
  tokenHash,
} from './model.js';
import { GateConflictError, type GatePut, type GateRepository, gateRepository } from './repository.js';
import {
  COURIER_RESPONSE_MINUTES,
  type Courier,
  type EntryMode,
  GATE_LOG_KINDS,
  type GateDirection,
  type GateIdempotency,
  type GateLogEntry,
  type GateLogKind,
  type GuestPass,
  MAX_PASS_DAYS,
  MAX_PASS_LEAD_DAYS,
  MAX_VEHICLES_PER_UNIT,
  PASS_INDEX_GRACE_DAYS,
  PLATE_SEARCH_LIMIT,
  PLATE_SEARCH_MIN,
  type PassCodeIndex,
  type PassTokenIndex,
  type PlateIndex,
  type UnitPointer,
  type Vehicle,
  type VehicleStatus,
  gateKeys,
} from './types.js';

export type GateContext = { apartmentId: string; userId: string; role: string };

type ActorKind = 'manager' | 'guard' | 'resident';
type GateActor = GateContext & { kind: ActorKind; unitIds: string[] };

const KIND_BY_ROLE: Record<string, ActorKind> = {
  apartment_manager: 'manager',
  management_company: 'manager',
  security_guard: 'guard',
  resident: 'resident',
};

export type GateServiceDeps = {
  repo: GateRepository;
  core: Pick<CoreRepository, 'getUnit' | 'getBlock' | 'listUnits' | 'listBlocks'>;
  memberships: Pick<PortalRepository, 'listMemberships'>;
  roles: Pick<ApartmentRoleRepository, 'list'>;
  now: () => Date;
  newId: () => string;
  newToken: () => string;
  newCode: () => string;
};

const WRITE_RETRIES = 3;
const LOG_PAGE = 50;
const LOG_MAX_PAGE = 100;
/** Yonetici gunluk filtresinin en uzun araligi (gun). */
const LOG_MAX_RANGE_DAYS = 366;
const ROLE_TEXT: Record<string, string> = { security_guard: 'Güvenlik', apartment_manager: 'Yönetici', management_company: 'Yönetim firması' };

export function createGateService(overrides: Partial<GateServiceDeps> = {}) {
  const deps: GateServiceDeps = {
    repo: gateRepository,
    core: coreRepository,
    memberships: portalRepository,
    roles: apartmentRoleRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    newToken: newPassToken,
    newCode: () => newShortCode(),
    ...overrides,
  };
  const repo = deps.repo;
  const stamp = () => deps.now().toISOString();
  const today = () => istanbulDay(deps.now());
  const rand = (n: number) => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, n);
  /** Zaman sirali kimlik: `20261127T101530123Z-ab12cd34`. */
  const sortableId = (ts: IsoDateTime) => `${ts.replace(/[-:.]/g, '')}-${rand(8)}`;

  // -------------------------------------------------------------------------
  // Aktor, bolum etiketleri
  // -------------------------------------------------------------------------

  async function actorOf(ctx: GateContext): Promise<GateActor> {
    const kind = KIND_BY_ROLE[ctx.role];
    if (!kind) throw new GateError('forbidden', 'Bu rol güvenlik kapısı ekranlarını kullanamaz');
    let unitIds: string[] = [];
    if (kind === 'resident') {
      const d = today();
      const ms = await deps.memberships.listMemberships(ctx.apartmentId, ctx.userId);
      unitIds = [
        ...new Set(
          ms
            .filter((m) => m.apartmentId === ctx.apartmentId && m.status === 'active' && m.startDate <= d && (!m.endDate || m.endDate >= d))
            // Oturmayan malik ziyaretci / arac kayitlarini yonetmez (kiraci her zaman oturur).
            .filter((m) => m.relation === 'tenant' || m.residesInUnit)
            .map((m) => m.unitId),
        ),
      ];
    }
    return { ...ctx, kind, unitIds };
  }

  async function actorAs(ctx: GateContext, ...kinds: ActorKind[]): Promise<GateActor> {
    const actor = await actorOf(ctx);
    if (!kinds.includes(actor.kind)) throw new GateError('forbidden', 'Bu işlem için yetkiniz yok');
    return actor;
  }

  const labelOf = (unit: Unit | undefined, block: Block | undefined, unitId: string) =>
    unit ? (block ? `${block.name} · Daire ${unit.number}` : `Daire ${unit.number}`) : 'Bağımsız bölüm';

  /** Bolum etiketleri; cok bolumde tek liste okumasi, azinda tek tek. */
  async function labelsFor(apartmentId: string, unitIds: Iterable<string>): Promise<Map<string, string>> {
    const ids = [...new Set(unitIds)];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    if (ids.length > 25) {
      const [units, blocks] = await Promise.all([deps.core.listUnits(apartmentId), deps.core.listBlocks(apartmentId)]);
      const byBlock = new Map(blocks.map((b) => [b.blockId, b]));
      const byUnit = new Map(units.map((u) => [u.unitId, u]));
      for (const id of ids) {
        const u = byUnit.get(id);
        out.set(id, labelOf(u, u ? byBlock.get(u.blockId) : undefined, id));
      }
      return out;
    }
    const blocks = new Map<string, Promise<Block | undefined>>();
    await Promise.all(
      ids.map(async (id) => {
        const u = await deps.core.getUnit(apartmentId, id);
        let b: Block | undefined;
        if (u?.blockId) {
          if (!blocks.has(u.blockId)) blocks.set(u.blockId, deps.core.getBlock(apartmentId, u.blockId));
          b = await blocks.get(u.blockId);
        }
        out.set(id, labelOf(u, b, id));
      }),
    );
    return out;
  }

  /** Sakin yalnizca oturdugu bolum; yonetim / gorevli apartmandaki aktif bolum. */
  async function requireUnit(actor: GateActor, value: unknown, field = 'unitId'): Promise<string> {
    const unitId = assertId(value, field);
    if (actor.kind === 'resident') {
      if (!actor.unitIds.includes(unitId)) throw new GateError('forbidden', 'Yalnızca oturduğunuz bağımsız bölüm için işlem yapabilirsiniz');
      return unitId;
    }
    const unit = await deps.core.getUnit(actor.apartmentId, unitId);
    if (!unit || unit.status !== 'active') throw new GateError('not_found', 'Bağımsız bölüm bulunamadı');
    return unitId;
  }

  async function names(apartmentId: string): Promise<Map<string, string>> {
    const roles = await deps.roles.list(apartmentId);
    return new Map(roles.map((r) => [r.userId, r.displayName ?? r.fullName ?? ROLE_TEXT[r.role] ?? 'Görevli']));
  }

  // -------------------------------------------------------------------------
  // Ortak yazim yardimcilari
  // -------------------------------------------------------------------------

  const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

  function idemItem(ctx: GateContext, key: string, kind: GateIdempotency['kind'], refId: string, fp: string, at: IsoDateTime, logId?: string): GateIdempotency {
    return { ...gateKeys.idempotency(ctx.apartmentId, key), entityType: 'GATE_IDEMPOTENCY', apartmentId: ctx.apartmentId, kind, refId, ...(logId ? { logId } : {}), fingerprint: fp, createdAt: at };
  }

  /** Ayni anahtar ayni istekse kayit kimligi, farkli istekse 409. */
  async function replayOf(ctx: GateContext, key: string, kind: GateIdempotency['kind'], fp: string): Promise<GateIdempotency | undefined> {
    const idem = await repo.get<GateIdempotency>(ctx.apartmentId, gateKeys.idempotency(ctx.apartmentId, key).SK);
    if (!idem) return undefined;
    if (idem.kind !== kind || idem.fingerprint !== fp) throw new GateError('conflict', 'Bu idempotencyKey farklı bir işlem için kullanılmış');
    return idem;
  }

  const pointer = (keys: { PK: string; SK: string }, apartmentId: string, unitId: string, refId: string, at: IsoDateTime): UnitPointer => ({
    ...keys,
    entityType: 'GATE_UNIT_POINTER',
    apartmentId,
    unitId,
    refId,
    createdAt: at,
  });

  function logItems(ctx: GateContext, at: IsoDateTime, e: Omit<GateLogEntry, 'PK' | 'SK' | 'entityType' | 'apartmentId' | 'logId' | 'at' | 'recordedBy' | 'recordedByRole'>): { entry: GateLogEntry; puts: GatePut[] } {
    const logId = rand(16);
    const entry: GateLogEntry = {
      ...gateKeys.log(ctx.apartmentId, at, logId),
      entityType: 'GATE_LOG',
      apartmentId: ctx.apartmentId,
      logId,
      at,
      ...e,
      recordedBy: ctx.userId,
      recordedByRole: ctx.role,
    };
    const puts: GatePut[] = [{ item: entry, condition: { kind: 'new' }, reason: 'exists' }];
    // Sakin kendi dairesinin kayitlarini bu kopyadan okur (tum gunluk taranmaz).
    if (e.unitId) puts.push({ item: { ...entry, ...gateKeys.logUnit(ctx.apartmentId, e.unitId, at, logId), entityType: 'GATE_LOG_UNIT' }, condition: { kind: 'new' }, reason: 'exists' });
    return { entry, puts };
  }

  function optText(o: Obj, key: string, max: number): string | undefined {
    if (o[key] === undefined || o[key] === null || o[key] === '') return undefined;
    return reqString(o, key, max);
  }

  function reqDate(o: Obj, key: string): IsoDate {
    const v = o[key];
    if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${key} YYYY-MM-DD biçiminde tarih olmalıdır`, key);
    return v;
  }

  /** Misafir plakasi: yabanci plaka da olabilir; harf/rakam, 4-10 karakter. */
  function loosePlate(o: Obj, key: string): string | undefined {
    if (o[key] === undefined || o[key] === null || o[key] === '') return undefined;
    const plate = normalizePlate(reqString(o, key, 20));
    if (!/^[A-Z0-9]{4,10}$/.test(plate)) throw new ValidationError('Plaka yalnızca harf ve rakamdan oluşmalıdır', key);
    return plate;
  }

  // =========================================================================
  // Araclar
  // =========================================================================

  async function vehiclesOfUnits(apartmentId: string, unitIds: readonly string[]): Promise<Vehicle[]> {
    const refs = (await Promise.all(unitIds.map((u) => repo.query<UnitPointer>(apartmentId, { prefix: gateKeys.vehicleUnitPrefix(u) })))).flatMap((r) => r.items.map((p) => p.refId));
    const vehicles = await repo.getMany<Vehicle>(apartmentId, refs.map((id) => gateKeys.vehicle(apartmentId, id).SK));
    return vehicles.filter((v) => v.apartmentId === apartmentId && unitIds.includes(v.unitId));
  }

  function vehicleView(v: Vehicle, labels: Map<string, string>) {
    return {
      vehicleId: v.vehicleId,
      unitId: v.unitId,
      unitLabel: labels.get(v.unitId) ?? 'Bağımsız bölüm',
      plate: v.plate,
      plateDisplay: formatPlate(v.plate),
      ...(v.note ? { note: v.note } : {}),
      status: v.status,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      createdByRole: v.createdByRole,
      version: v.version,
    };
  }

  async function listVehicles(ctx: GateContext, q: Record<string, string | undefined> = {}) {
    const actor = await actorAs(ctx, 'manager', 'resident');
    let vehicles: Vehicle[];
    if (actor.kind === 'resident') vehicles = await vehiclesOfUnits(ctx.apartmentId, actor.unitIds);
    else vehicles = (await repo.query<Vehicle>(ctx.apartmentId, { prefix: 'VEH#' })).items.filter((v) => v.entityType === 'GATE_VEHICLE');
    const status = q.status === 'active' || q.status === 'inactive' ? q.status : undefined;
    const term = q.q ? normalizePlate(q.q) : '';
    const list = vehicles
      .filter((v) => !q.unitId || v.unitId === q.unitId)
      .filter((v) => !status || v.status === status)
      .filter((v) => !term || v.plate.includes(term));
    const labels = await labelsFor(ctx.apartmentId, list.map((v) => v.unitId));
    const collator = new Intl.Collator('tr', { numeric: true });
    // Aktifler once; bolum etiketine (A Blok · Daire 2 < Daire 10), sonra plakaya gore.
    list.sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        collator.compare(labels.get(a.unitId) ?? '', labels.get(b.unitId) ?? '') ||
        a.plate.localeCompare(b.plate),
    );
    return { items: list.map((v) => vehicleView(v, labels)), maxPerUnit: MAX_VEHICLES_PER_UNIT };
  }

  function plateTakenError(existing: PlateIndex, unitId: string, actor: GateActor): GateError {
    if (existing.unitId === unitId) return new GateError('plate_taken', 'Bu plaka bu bağımsız bölümde zaten kayıtlı');
    // Sakine diger bolum soylenmez; yonetici kendi apartmaninin verisini gorebilir.
    return new GateError('plate_taken', actor.kind === 'manager' ? 'Bu plaka başka bir bağımsız bölüme kayıtlı; önce oradaki kaydı pasife alın' : 'Bu plaka sitede başka bir bağımsız bölüme kayıtlı; yönetimle iletişime geçin');
  }

  async function assertUnitRoom(apartmentId: string, unitId: string, exceptVehicleId?: string) {
    const active = (await vehiclesOfUnits(apartmentId, [unitId])).filter((v) => v.status === 'active' && v.vehicleId !== exceptVehicleId);
    if (active.length >= MAX_VEHICLES_PER_UNIT) throw new GateError('limit_reached', `Bir bağımsız bölüme en fazla ${MAX_VEHICLES_PER_UNIT} aktif araç kaydedilebilir`);
  }

  const vehicleAudit = (ctx: GateContext, actor: GateActor, action: string, v: Vehicle, details: Record<string, unknown>): AuditDraft | undefined =>
    actor.kind === 'manager' ? { apartmentId: ctx.apartmentId, action, target: { type: 'vehicle', id: v.vehicleId }, details: { unitId: v.unitId, ...details } } : undefined;

  /** Plaka kaydi: Turk plaka bicimi; aktif plaka apartmanda tekil (kosullu yazim, yaris guvenli). */
  async function createVehicle(ctx: GateContext, body: unknown) {
    const actor = await actorAs(ctx, 'manager', 'resident');
    const o = asObject(body);
    const unitId = await requireUnit(actor, o.unitId);
    const plate = normalizePlate(reqString(o, 'plate', 20));
    if (!isTurkishPlate(plate)) throw new ValidationError('Plaka Türkiye plaka biçiminde olmalıdır (örnek: 34 ABC 123)', 'plate');
    const note = optText(o, 'note', 80);
    const existing = await repo.get<PlateIndex>(ctx.apartmentId, gateKeys.plate(ctx.apartmentId, reversePlate(plate)).SK);
    if (existing?.status === 'active') throw plateTakenError(existing, unitId, actor);
    await assertUnitRoom(ctx.apartmentId, unitId);

    const ts = stamp();
    const vehicleId = sortableId(ts);
    const vehicle: Vehicle = {
      ...gateKeys.vehicle(ctx.apartmentId, vehicleId),
      entityType: 'GATE_VEHICLE',
      apartmentId: ctx.apartmentId,
      vehicleId,
      unitId,
      plate,
      ...(note ? { note } : {}),
      status: 'active',
      createdAt: ts,
      createdBy: ctx.userId,
      createdByRole: ctx.role,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    const plateItem: PlateIndex = { ...gateKeys.plate(ctx.apartmentId, reversePlate(plate)), entityType: 'GATE_PLATE', apartmentId: ctx.apartmentId, plate, vehicleId, unitId, status: 'active', ...(note ? { note } : {}), updatedAt: ts };
    try {
      await repo.write(ctx.apartmentId, {
        puts: [
          { item: vehicle, condition: { kind: 'new' }, reason: 'exists' },
          { item: pointer(gateKeys.vehicleUnit(ctx.apartmentId, unitId, vehicleId), ctx.apartmentId, unitId, vehicleId, ts), condition: { kind: 'new' }, reason: 'exists' },
          { item: plateItem, condition: { kind: 'new_or', fields: { status: 'inactive' } }, reason: 'plate' },
        ],
        audit: vehicleAudit(ctx, actor, 'gate.vehicle.create', vehicle, {}),
      });
    } catch (err) {
      if (err instanceof GateConflictError && err.reason === 'plate') {
        const now = await repo.get<PlateIndex>(ctx.apartmentId, plateItem.SK);
        throw now ? plateTakenError(now, unitId, actor) : new GateError('conflict', 'Plaka kaydı başka bir işlemle çakıştı; tekrar deneyin');
      }
      throw err;
    }
    return { vehicle: vehicleView(vehicle, await labelsFor(ctx.apartmentId, [unitId])) };
  }

  /** Not duzeltme ve aktif / pasif (plaka degismez: yeni plaka = yeni kayit). */
  async function updateVehicle(ctx: GateContext, vehicleId: string, body: unknown) {
    const actor = await actorAs(ctx, 'manager', 'resident');
    assertId(vehicleId, 'vehicleId');
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await repo.get<Vehicle>(ctx.apartmentId, gateKeys.vehicle(ctx.apartmentId, vehicleId).SK);
    // Baska dairenin araci sakine hic gorunmez: 404.
    if (!current || (actor.kind === 'resident' && !actor.unitIds.includes(current.unitId))) throw new GateError('not_found', 'Araç bulunamadı');
    if (current.version !== version) throw new GateError('conflict', 'Araç kaydı başka bir işlemle değişti; sayfayı yenileyin');
    const status: VehicleStatus = o.status === undefined ? current.status : reqEnum(o, 'status', ['active', 'inactive'] as const);
    const note = o.note === undefined ? current.note : optText(o, 'note', 80);
    if (status === current.status && note === current.note) return { vehicle: vehicleView(current, await labelsFor(ctx.apartmentId, [current.unitId])) };

    const index = await repo.get<PlateIndex>(ctx.apartmentId, gateKeys.plate(ctx.apartmentId, reversePlate(current.plate)).SK);
    const owned = index?.vehicleId === vehicleId;
    if (status === 'active' && current.status === 'inactive') {
      if (index && index.status === 'active') throw plateTakenError(index, current.unitId, actor);
      await assertUnitRoom(ctx.apartmentId, current.unitId, vehicleId);
    }
    const ts = stamp();
    const next: Vehicle = { ...current, status, updatedAt: ts, updatedBy: ctx.userId, version: current.version + 1 };
    if (note) next.note = note;
    else delete next.note;
    const puts: GatePut[] = [{ item: next, condition: { kind: 'match', fields: { version } }, reason: 'version' }];
    const plateItem: PlateIndex = { ...gateKeys.plate(ctx.apartmentId, reversePlate(current.plate)), entityType: 'GATE_PLATE', apartmentId: ctx.apartmentId, plate: current.plate, vehicleId, unitId: current.unitId, status, ...(note ? { note } : {}), updatedAt: ts };
    if (status === 'active') {
      // Yeniden etkinlestirme: plaka bos ya da pasif olmali (yaris guvenli).
      puts.push({ item: plateItem, condition: owned ? { kind: 'match', fields: { vehicleId, status: index?.status ?? 'inactive' } } : { kind: 'new_or', fields: { status: 'inactive' } }, reason: 'plate' });
    } else if (owned) {
      // Plaka bu arac kaydina bagliysa guncel durum ve not dizine de yazilir.
      puts.push({ item: plateItem, condition: { kind: 'match', fields: { vehicleId } }, reason: 'plate' });
    }
    try {
      await repo.write(ctx.apartmentId, {
        puts,
        audit: vehicleAudit(ctx, actor, 'gate.vehicle.update', next, { from: current.status, to: status, noteChanged: note !== current.note }),
      });
    } catch (err) {
      if (err instanceof GateConflictError && err.reason === 'version') throw new GateError('conflict', 'Araç kaydı başka bir işlemle değişti; sayfayı yenileyin');
      if (err instanceof GateConflictError && err.reason === 'plate') throw new GateError('plate_taken', 'Bu plaka bu arada başka bir bağımsız bölüme kaydedildi');
      throw err;
    }
    return { vehicle: vehicleView(next, await labelsFor(ctx.apartmentId, [next.unitId])) };
  }

  /**
   * Gorevli / yonetici plaka sorgusu: tam plaka veya sondan en az 3 karakter. Tek `Query` (ters
   * plaka on eki), en fazla 10 sonuc. Yanit yalnizca bolum, kayit durumu ve arac notunu tasir.
   */
  async function lookupPlate(ctx: GateContext, input: string | undefined) {
    await actorAs(ctx, 'manager', 'guard');
    const q = plateQuery(input ?? '', PLATE_SEARCH_MIN);
    if (!q) throw new ValidationError(`Plaka araması en az ${PLATE_SEARCH_MIN} harf veya rakam olmalıdır`, 'q');
    const { items } = await repo.query<PlateIndex>(ctx.apartmentId, { prefix: `${gateKeys.platePrefix}${reversePlate(q)}`, limit: PLATE_SEARCH_LIMIT * 2 });
    const rows = items
      .filter((i) => i.entityType === 'GATE_PLATE')
      .sort((a, b) => Number(b.plate === q) - Number(a.plate === q) || Number(b.status === 'active') - Number(a.status === 'active') || a.plate.localeCompare(b.plate))
      .slice(0, PLATE_SEARCH_LIMIT);
    const labels = await labelsFor(ctx.apartmentId, rows.map((r) => r.unitId));
    return {
      query: q,
      queryDisplay: formatPlate(q),
      items: rows.map((r) => ({
        plate: r.plate,
        plateDisplay: formatPlate(r.plate),
        unitId: r.unitId,
        unitLabel: labels.get(r.unitId) ?? 'Bağımsız bölüm',
        registered: true,
        active: r.status === 'active',
        exact: r.plate === q,
        ...(r.note ? { note: r.note } : {}),
      })),
    };
  }

  // =========================================================================
  // Misafir gecisleri
  // =========================================================================

  async function requirePass(actor: GateActor, passId: string): Promise<GuestPass> {
    assertId(passId, 'passId');
    const pass = await repo.get<GuestPass>(actor.apartmentId, gateKeys.pass(actor.apartmentId, passId).SK);
    if (!pass || pass.apartmentId !== actor.apartmentId || (actor.kind === 'resident' && !actor.unitIds.includes(pass.unitId))) throw new GateError('not_found', 'Geçiş bulunamadı');
    return pass;
  }

  /** Sakin: QR jetonu ve kisa kod yalnizca hala kullanilabilir geciste doner. */
  function residentPassView(actor: GateActor, p: GuestPass, labels: Map<string, string>) {
    const verdict = passVerdict(p, today());
    const shareable = verdict === 'valid' || verdict === 'not_yet_valid';
    return {
      passId: p.passId,
      unitId: p.unitId,
      unitLabel: labels.get(p.unitId) ?? 'Bağımsız bölüm',
      guestName: p.guestName,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      entryMode: p.entryMode,
      ...(p.plate ? { plate: p.plate, plateDisplay: formatPlate(p.plate) } : {}),
      ...(p.note ? { note: p.note } : {}),
      status: p.status,
      verdict,
      ...(shareable ? { token: p.token, shortCode: p.shortCode } : {}),
      entryCount: p.entryCount,
      inside: p.inside,
      ...(p.lastEntryAt ? { lastEntryAt: p.lastEntryAt } : {}),
      ...(p.lastExitAt ? { lastExitAt: p.lastExitAt } : {}),
      ...(p.revokedAt ? { revokedAt: p.revokedAt } : {}),
      createdAt: p.createdAt,
      mine: p.createdBy === actor.userId,
      canRevoke: p.status === 'active' && verdict !== 'expired',
      version: p.version,
    };
  }

  /** Yonetici: jeton / kod yok (paylasim sakinindir). */
  function managerPassView(p: GuestPass, labels: Map<string, string>) {
    const verdict = passVerdict(p, today());
    return {
      passId: p.passId,
      unitId: p.unitId,
      unitLabel: labels.get(p.unitId) ?? 'Bağımsız bölüm',
      guestName: p.guestName,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      entryMode: p.entryMode,
      ...(p.plate ? { plate: p.plate, plateDisplay: formatPlate(p.plate) } : {}),
      status: p.status,
      verdict,
      entryCount: p.entryCount,
      inside: p.inside,
      ...(p.lastEntryAt ? { lastEntryAt: p.lastEntryAt } : {}),
      createdAt: p.createdAt,
      canRevoke: p.status === 'active' && verdict !== 'expired',
      version: p.version,
    };
  }

  /** Gorevli: misafir adi, ev sahibi bolum, gecerlilik ve karar. Sakin kimligi yok. */
  function guardPassView(p: GuestPass, labels: Map<string, string>) {
    const d = today();
    const verdict = passVerdict(p, d);
    return {
      passId: p.passId,
      unitId: p.unitId,
      unitLabel: labels.get(p.unitId) ?? 'Bağımsız bölüm',
      guestName: p.guestName,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      entryMode: p.entryMode,
      ...(p.plate ? { plate: p.plate, plateDisplay: formatPlate(p.plate) } : {}),
      ...(p.note ? { note: p.note } : {}),
      verdict,
      ...(verdict === 'valid' ? {} : { message: VERDICT_MESSAGES[verdict] }),
      entryCount: p.entryCount,
      inside: p.inside,
      ...(p.lastEntryAt ? { lastEntryAt: p.lastEntryAt } : {}),
      ...passActions(p, d),
      version: p.version,
    };
  }

  async function createPass(ctx: GateContext, body: unknown) {
    const actor = await actorAs(ctx, 'resident');
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const unitId = await requireUnit(actor, o.unitId);
    const guestName = reqString(o, 'guestName', 80, 2);
    const validFrom = reqDate(o, 'validFrom');
    const validUntil = o.validUntil == null || o.validUntil === '' ? validFrom : reqDate(o, 'validUntil');
    const entryMode: EntryMode = reqEnum(o, 'entryMode', ['single', 'multi'] as const);
    const plate = loosePlate(o, 'plate');
    const note = optText(o, 'note', 200);
    const d = today();
    if (validFrom < d) throw new ValidationError('Geçiş bugünden önce başlayamaz', 'validFrom');
    if (validFrom > addDays(d, MAX_PASS_LEAD_DAYS)) throw new ValidationError(`Geçiş en fazla ${MAX_PASS_LEAD_DAYS} gün sonrası için oluşturulabilir`, 'validFrom');
    if (validUntil < validFrom) throw new ValidationError('Bitiş tarihi başlangıçtan önce olamaz', 'validUntil');
    if (daySpan(validFrom, validUntil) > MAX_PASS_DAYS) throw new ValidationError(`Bir geçiş en fazla ${MAX_PASS_DAYS} gün geçerli olabilir`, 'validUntil');
    const fp = fingerprint({ unitId, guestName, validFrom, validUntil, entryMode, plate, note, by: ctx.userId });

    const replay = async () => {
      const idem = await replayOf(ctx, key, 'pass', fp);
      if (!idem) return undefined;
      const pass = await requirePass(actor, idem.refId);
      return { pass: residentPassView(actor, pass, await labelsFor(ctx.apartmentId, [unitId])), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    const ts = stamp();
    const passId = sortableId(ts);
    const ttl = indexTtl(validUntil, PASS_INDEX_GRACE_DAYS);
    for (let attempt = 1; ; attempt++) {
      const token = deps.newToken();
      const shortCode = deps.newCode();
      const pass: GuestPass = {
        ...gateKeys.pass(ctx.apartmentId, passId),
        entityType: 'GATE_PASS',
        apartmentId: ctx.apartmentId,
        passId,
        unitId,
        guestName,
        validFrom,
        validUntil,
        entryMode,
        ...(plate ? { plate } : {}),
        ...(note ? { note } : {}),
        status: 'active',
        token,
        shortCode,
        entryCount: 0,
        inside: false,
        createdAt: ts,
        createdBy: ctx.userId,
        createdByRole: ctx.role,
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: 1,
      };
      const tokenItem: PassTokenIndex = { ...gateKeys.passToken(ctx.apartmentId, tokenHash(token)), entityType: 'GATE_PASS_TOKEN', apartmentId: ctx.apartmentId, passId, ttl };
      const codeItem: PassCodeIndex = { ...gateKeys.passCode(ctx.apartmentId, shortCode), entityType: 'GATE_PASS_CODE', apartmentId: ctx.apartmentId, passId, ttl };
      try {
        await repo.write(ctx.apartmentId, {
          puts: [
            { item: idemItem(ctx, key, 'pass', passId, fp, ts), condition: { kind: 'new' }, reason: 'duplicate' },
            { item: pass, condition: { kind: 'new' }, reason: 'exists' },
            { item: pointer(gateKeys.passUnit(ctx.apartmentId, unitId, passId), ctx.apartmentId, unitId, passId, ts), condition: { kind: 'new' }, reason: 'exists' },
            { item: tokenItem, condition: { kind: 'new' }, reason: 'code' },
            { item: codeItem, condition: { kind: 'new' }, reason: 'code' },
          ],
        });
        return { pass: residentPassView(actor, pass, await labelsFor(ctx.apartmentId, [unitId])), replayed: false };
      } catch (err) {
        if (err instanceof GateConflictError && err.reason === 'duplicate') {
          const r = await replay();
          if (r) return r;
        }
        // Kisa kod (veya jeton) cakismasi: yeni kodla tekrar.
        if (err instanceof GateConflictError && err.reason === 'code' && attempt < WRITE_RETRIES) continue;
        if (err instanceof GateConflictError) throw new GateError('conflict', 'Geçiş oluşturulamadı; tekrar deneyin');
        throw err;
      }
    }
  }

  async function listPasses(ctx: GateContext, q: Record<string, string | undefined> = {}) {
    const actor = await actorAs(ctx, 'manager', 'resident');
    let passes: GuestPass[];
    if (actor.kind === 'resident') {
      const refs = (await Promise.all(actor.unitIds.map((u) => repo.query<UnitPointer>(ctx.apartmentId, { prefix: gateKeys.passUnitPrefix(u), desc: true, limit: 50 })))).flatMap((r) => r.items.map((p) => p.refId));
      passes = (await repo.getMany<GuestPass>(ctx.apartmentId, refs.map((id) => gateKeys.pass(ctx.apartmentId, id).SK))).filter((p) => actor.unitIds.includes(p.unitId));
    } else {
      passes = (await repo.query<GuestPass>(ctx.apartmentId, { prefix: 'GPASS#', desc: true, limit: 200 })).items.filter((p) => p.entityType === 'GATE_PASS');
    }
    const d = today();
    const usable = (p: GuestPass) => ['valid', 'not_yet_valid'].includes(passVerdict(p, d));
    const filter = q.status === 'active' ? usable : q.status === 'past' ? (p: GuestPass) => !usable(p) : () => true;
    const list = passes.filter((p) => !q.unitId || p.unitId === q.unitId).filter(filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const labels = await labelsFor(ctx.apartmentId, list.map((p) => p.unitId));
    return { items: list.map((p) => (actor.kind === 'resident' ? residentPassView(actor, p, labels) : managerPassView(p, labels))) };
  }

  /** Sakin (kendi dairesi) veya yonetici (denetimli) iptal eder. Iceri girmis misafirin cikisi yine kaydedilir. */
  async function revokePass(ctx: GateContext, passId: string, body: unknown) {
    const actor = await actorAs(ctx, 'manager', 'resident');
    const version = reqInt(asObject(body), 'version', 1, Number.MAX_SAFE_INTEGER);
    const pass = await requirePass(actor, passId);
    const labels = await labelsFor(ctx.apartmentId, [pass.unitId]);
    const view = (p: GuestPass) => (actor.kind === 'resident' ? residentPassView(actor, p, labels) : managerPassView(p, labels));
    if (pass.status === 'revoked') return { pass: view(pass) };
    if (pass.status !== 'active') throw new GateError('invalid_state', 'Kullanılmış geçiş iptal edilemez');
    if (pass.version !== version) throw new GateError('conflict', 'Geçiş başka bir işlemle değişti; sayfayı yenileyin');
    const ts = stamp();
    const next: GuestPass = { ...pass, status: 'revoked', revokedAt: ts, revokedBy: ctx.userId, updatedAt: ts, updatedBy: ctx.userId, version: pass.version + 1 };
    try {
      await repo.write(ctx.apartmentId, {
        puts: [{ item: next, condition: { kind: 'match', fields: { version, status: 'active' } }, reason: 'version' }],
        ...(actor.kind === 'manager' ? { audit: { apartmentId: ctx.apartmentId, action: 'gate.pass.revoke', target: { type: 'guest_pass', id: passId }, details: { unitId: pass.unitId } } } : {}),
      });
    } catch (err) {
      if (err instanceof GateConflictError) throw new GateError('conflict', 'Geçiş başka bir işlemle değişti; sayfayı yenileyin');
      throw err;
    }
    return { pass: view(next) };
  }

  /** QR jetonu veya kisa kodla gecis. Bulunamayan, baska apartmanin veya duzensiz girdi: 404. */
  async function verifyPass(ctx: GateContext, body: unknown) {
    await actorAs(ctx, 'manager', 'guard');
    const o = asObject(body);
    let passId: string | undefined;
    if (typeof o.token === 'string' && o.token) {
      if (!TOKEN_RE.test(o.token)) throw new GateError('not_found', 'Geçiş bulunamadı');
      passId = (await repo.get<PassTokenIndex>(ctx.apartmentId, gateKeys.passToken(ctx.apartmentId, tokenHash(o.token)).SK))?.passId;
    } else if (typeof o.code === 'string' && o.code) {
      const code = normalizeShortCode(o.code);
      if (!code) throw new ValidationError('Kod 8 karakter olmalıdır (örnek: K7M2-PQ4X)', 'code');
      passId = (await repo.get<PassCodeIndex>(ctx.apartmentId, gateKeys.passCode(ctx.apartmentId, code).SK))?.passId;
    } else {
      throw new ValidationError('QR jetonu veya kısa kod gerekli', 'code');
    }
    const pass = passId ? await repo.get<GuestPass>(ctx.apartmentId, gateKeys.pass(ctx.apartmentId, passId).SK) : undefined;
    if (!pass || pass.apartmentId !== ctx.apartmentId) throw new GateError('not_found', 'Geçiş bulunamadı');
    return { pass: guardPassView(pass, await labelsFor(ctx.apartmentId, [pass.unitId])) };
  }

  /**
   * Giris / cikis kaydi. Gecis guncellemesi + gunluk kaydi + idempotency tek atomik yazim.
   * Tek girislik geciste kosul `status = active AND entryCount = 0`: iki gorevli ayni anda okutursa
   * yalnizca biri kazanir, digeri yeniden okuyup "kullanildi" alir.
   */
  async function passMove(ctx: GateContext, passId: string, body: unknown, direction: GateDirection) {
    const actor = await actorAs(ctx, 'manager', 'guard');
    const key = assertId(asObject(body).idempotencyKey, 'idempotencyKey');
    const fp = fingerprint({ passId, direction });
    const kind = direction === 'entry' ? 'entry' : 'exit';
    for (let attempt = 1; ; attempt++) {
      const pass = await requirePass(actor, passId);
      const labels = await labelsFor(ctx.apartmentId, [pass.unitId]);
      const prior = await replayOf(ctx, key, kind, fp);
      if (prior) return { pass: guardPassView(pass, labels), replayed: true };
      const d = today();
      if (direction === 'entry') {
        const verdict = passVerdict(pass, d);
        if (verdict !== 'valid') throw new GateError(`pass_${verdict}` as GateErrorCode, VERDICT_MESSAGES[verdict]);
      } else if (!pass.inside) {
        throw new GateError('not_inside', 'Bu misafir için açık bir giriş kaydı yok');
      }
      const ts = stamp();
      const next: GuestPass =
        direction === 'entry'
          ? { ...pass, entryCount: pass.entryCount + 1, inside: true, lastEntryAt: ts, status: pass.entryMode === 'single' ? 'used' : pass.status }
          : { ...pass, inside: false, lastExitAt: ts };
      Object.assign(next, { updatedAt: ts, updatedBy: ctx.userId, version: pass.version + 1 });
      const condition: Record<string, string | number | boolean> =
        direction === 'entry' ? { version: pass.version, status: 'active', ...(pass.entryMode === 'single' ? { entryCount: 0 } : {}) } : { version: pass.version, inside: true };
      const log = logItems(ctx, ts, { direction, kind: 'guest', unitId: pass.unitId, passId, visitorName: pass.guestName, ...(pass.plate ? { plate: pass.plate } : {}) });
      try {
        await repo.write(ctx.apartmentId, {
          puts: [
            { item: idemItem(ctx, key, kind, passId, fp, ts, log.entry.logId), condition: { kind: 'new' }, reason: 'duplicate' },
            { item: next, condition: { kind: 'match', fields: condition }, reason: 'version' },
            ...log.puts,
          ],
        });
        return { pass: guardPassView(next, labels), log: logView(actor, log.entry, labels, new Map()), replayed: false };
      } catch (err) {
        // Yaris: guncel hali yeniden okunur (tek girislikte ikinci okutma "kullanildi" alir).
        if (err instanceof GateConflictError && (err.reason === 'version' || err.reason === 'duplicate') && attempt < WRITE_RETRIES) continue;
        if (err instanceof GateConflictError) throw new GateError('conflict', 'Geçiş başka bir işlemle değişti; tekrar okutun');
        throw err;
      }
    }
  }

  // =========================================================================
  // Kurye
  // =========================================================================

  const responseDeadline = (c: Courier) => new Date(Date.parse(c.createdAt) + COURIER_RESPONSE_MINUTES * 60_000).toISOString();
  const courierExpired = (c: Courier) => c.status === 'waiting' && deps.now().toISOString() > responseDeadline(c);

  function courierView(actor: GateActor, c: Courier, labels: Map<string, string>) {
    const expired = courierExpired(c);
    const desk = actor.kind !== 'resident';
    return {
      courierId: c.courierId,
      unitId: c.unitId,
      unitLabel: labels.get(c.unitId) ?? 'Bağımsız bölüm',
      ...(c.company ? { company: c.company } : {}),
      ...(c.note ? { note: c.note } : {}),
      status: c.status,
      expired,
      respondBy: responseDeadline(c),
      ...(c.respondedAt ? { respondedAt: c.respondedAt } : {}),
      ...(c.responseNote ? { responseNote: c.responseNote } : {}),
      ...(c.enteredAt ? { enteredAt: c.enteredAt } : {}),
      ...(c.exitedAt ? { exitedAt: c.exitedAt } : {}),
      createdAt: c.createdAt,
      canRespond: !desk && c.status === 'waiting' && !expired,
      canEnter: desk && c.status === 'approved' && !c.enteredAt,
      canExit: desk && !!c.enteredAt && !c.exitedAt,
      canCancel: desk && (c.status === 'waiting' || c.status === 'approved') && !c.enteredAt,
      version: c.version,
    };
  }

  async function requireCourier(actor: GateActor, courierId: string): Promise<Courier> {
    assertId(courierId, 'courierId');
    const c = await repo.get<Courier>(actor.apartmentId, gateKeys.courier(actor.apartmentId, courierId).SK);
    if (!c || c.apartmentId !== actor.apartmentId || (actor.kind === 'resident' && !actor.unitIds.includes(c.unitId))) throw new GateError('not_found', 'Kurye kaydı bulunamadı');
    return c;
  }

  /** Gorevli gelen kuryeyi bolum icin kaydeder; sakin portalda onaylar / reddeder. */
  async function createCourier(ctx: GateContext, body: unknown) {
    const actor = await actorAs(ctx, 'manager', 'guard');
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const unitId = await requireUnit(actor, o.unitId);
    const company = optText(o, 'company', 40);
    const note = optText(o, 'note', 200);
    const fp = fingerprint({ unitId, company, note, by: ctx.userId });
    const replay = async () => {
      const idem = await replayOf(ctx, key, 'courier', fp);
      if (!idem) return undefined;
      const c = await requireCourier(actor, idem.refId);
      return { courier: courierView(actor, c, await labelsFor(ctx.apartmentId, [unitId])), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    const ts = stamp();
    const courierId = sortableId(ts);
    const courier: Courier = {
      ...gateKeys.courier(ctx.apartmentId, courierId),
      entityType: 'GATE_COURIER',
      apartmentId: ctx.apartmentId,
      courierId,
      unitId,
      ...(company ? { company } : {}),
      ...(note ? { note } : {}),
      status: 'waiting',
      createdAt: ts,
      createdBy: ctx.userId,
      createdByRole: ctx.role,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.write(ctx.apartmentId, {
        puts: [
          { item: idemItem(ctx, key, 'courier', courierId, fp, ts), condition: { kind: 'new' }, reason: 'duplicate' },
          { item: courier, condition: { kind: 'new' }, reason: 'exists' },
          { item: pointer(gateKeys.courierUnit(ctx.apartmentId, unitId, courierId), ctx.apartmentId, unitId, courierId, ts), condition: { kind: 'new' }, reason: 'exists' },
        ],
      });
    } catch (err) {
      if (err instanceof GateConflictError && err.reason === 'duplicate') {
        const r = await replay();
        if (r) return r;
      }
      if (err instanceof GateConflictError) throw new GateError('conflict', 'Kurye kaydı oluşturulamadı; tekrar deneyin');
      throw err;
    }
    return { courier: courierView(actor, courier, await labelsFor(ctx.apartmentId, [unitId])), replayed: false };
  }

  /** Gorevli: son 50 kurye (`status=open`: sonuclanmamislar). Sakin: oturdugu bolumlerin son kuryeleri. */
  async function listCouriers(ctx: GateContext, q: Record<string, string | undefined> = {}) {
    const actor = await actorAs(ctx, 'manager', 'guard', 'resident');
    let couriers: Courier[];
    if (actor.kind === 'resident') {
      const refs = (await Promise.all(actor.unitIds.map((u) => repo.query<UnitPointer>(ctx.apartmentId, { prefix: gateKeys.courierUnitPrefix(u), desc: true, limit: 20 })))).flatMap((r) => r.items.map((p) => p.refId));
      couriers = (await repo.getMany<Courier>(ctx.apartmentId, refs.map((id) => gateKeys.courier(ctx.apartmentId, id).SK))).filter((c) => actor.unitIds.includes(c.unitId));
    } else {
      couriers = (await repo.query<Courier>(ctx.apartmentId, { prefix: 'GCOUR#', desc: true, limit: 50 })).items.filter((c) => c.entityType === 'GATE_COURIER');
    }
    const open = (c: Courier) => (c.status === 'waiting' && !courierExpired(c)) || (c.status === 'approved' && !c.exitedAt);
    const list = couriers.filter((c) => q.status !== 'open' || open(c)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const labels = await labelsFor(ctx.apartmentId, list.map((c) => c.unitId));
    return { items: list.map((c) => courierView(actor, c, labels)), pollSeconds: 15 };
  }

  async function saveCourier(ctx: GateContext, current: Courier, next: Courier, extra: GatePut[] = []) {
    try {
      await repo.write(ctx.apartmentId, { puts: [...extra, { item: next, condition: { kind: 'match', fields: { version: current.version, status: current.status } }, reason: 'version' }] });
    } catch (err) {
      if (err instanceof GateConflictError && err.reason === 'version') throw new GateError('conflict', 'Kurye kaydı başka bir işlemle değişti; sayfayı yenileyin');
      throw err;
    }
  }

  async function respondCourier(ctx: GateContext, courierId: string, body: unknown) {
    const actor = await actorAs(ctx, 'resident');
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const decision = reqEnum(o, 'decision', ['approve', 'decline'] as const);
    const note = optText(o, 'note', 200);
    const c = await requireCourier(actor, courierId);
    if (c.status !== 'waiting') throw new GateError('invalid_state', c.status === 'cancelled' ? 'Görevli bu kaydı kapattı' : 'Bu kuryeye zaten yanıt verildi');
    if (courierExpired(c)) throw new GateError('response_expired', `Yanıt süresi (${COURIER_RESPONSE_MINUTES} dk) doldu; güvenlikle iletişime geçin`);
    if (c.version !== version) throw new GateError('conflict', 'Kurye kaydı başka bir işlemle değişti; sayfayı yenileyin');
    const ts = stamp();
    const next: Courier = { ...c, status: decision === 'approve' ? 'approved' : 'declined', respondedAt: ts, respondedBy: ctx.userId, ...(note ? { responseNote: note } : {}), updatedAt: ts, updatedBy: ctx.userId, version: c.version + 1 };
    await saveCourier(ctx, c, next);
    return { courier: courierView(actor, next, await labelsFor(ctx.apartmentId, [c.unitId])) };
  }

  async function cancelCourier(ctx: GateContext, courierId: string, body: unknown) {
    const actor = await actorAs(ctx, 'manager', 'guard');
    const version = reqInt(asObject(body), 'version', 1, Number.MAX_SAFE_INTEGER);
    const c = await requireCourier(actor, courierId);
    if (c.status === 'cancelled') return { courier: courierView(actor, c, await labelsFor(ctx.apartmentId, [c.unitId])) };
    if (!(c.status === 'waiting' || c.status === 'approved') || c.enteredAt) throw new GateError('invalid_state', 'Bu kurye kaydı kapatılamaz');
    if (c.version !== version) throw new GateError('conflict', 'Kurye kaydı başka bir işlemle değişti; sayfayı yenileyin');
    const ts = stamp();
    const next: Courier = { ...c, status: 'cancelled', updatedAt: ts, updatedBy: ctx.userId, version: c.version + 1 };
    await saveCourier(ctx, c, next);
    return { courier: courierView(actor, next, await labelsFor(ctx.apartmentId, [c.unitId])) };
  }

  /** Onaylanan kuryenin girisi / cikisi (gunluge yazilir; idempotent). */
  async function courierMove(ctx: GateContext, courierId: string, body: unknown, direction: GateDirection) {
    const actor = await actorAs(ctx, 'manager', 'guard');
    const key = assertId(asObject(body).idempotencyKey, 'idempotencyKey');
    const fp = fingerprint({ courierId, direction });
    const c = await requireCourier(actor, courierId);
    const labels = await labelsFor(ctx.apartmentId, [c.unitId]);
    if (await replayOf(ctx, key, direction, fp)) return { courier: courierView(actor, c, labels), replayed: true };
    if (direction === 'entry') {
      if (c.status === 'waiting') throw new GateError('invalid_state', 'Daire sakini henüz onaylamadı');
      if (c.status !== 'approved') throw new GateError('invalid_state', c.status === 'declined' ? 'Daire sakini kuryeyi reddetti' : 'Kurye kaydı kapatıldı');
      if (c.enteredAt) throw new GateError('invalid_state', 'Kurye girişi zaten kaydedildi');
    } else if (!c.enteredAt || c.exitedAt) {
      throw new GateError('not_inside', 'Bu kurye için açık bir giriş kaydı yok');
    }
    const ts = stamp();
    const next: Courier = { ...c, ...(direction === 'entry' ? { enteredAt: ts } : { exitedAt: ts }), updatedAt: ts, updatedBy: ctx.userId, version: c.version + 1 };
    const log = logItems(ctx, ts, { direction, kind: 'courier', unitId: c.unitId, courierId, ...(c.company ? { company: c.company } : {}) });
    try {
      await saveCourier(ctx, c, next, [{ item: idemItem(ctx, key, direction, courierId, fp, ts, log.entry.logId), condition: { kind: 'new' }, reason: 'duplicate' }, ...log.puts]);
    } catch (err) {
      if (err instanceof GateConflictError && err.reason === 'duplicate') return { courier: courierView(actor, c, labels), replayed: true };
      throw err;
    }
    return { courier: courierView(actor, next, labels), log: logView(actor, log.entry, labels, new Map()), replayed: false };
  }

  // =========================================================================
  // Kapi gunlugu
  // =========================================================================

  function logView(actor: GateActor, e: GateLogEntry, labels: Map<string, string>, people: Map<string, string>) {
    return {
      logId: e.logId,
      at: e.at,
      direction: e.direction,
      kind: e.kind,
      ...(e.unitId ? { unitId: e.unitId, unitLabel: labels.get(e.unitId) ?? 'Bağımsız bölüm' } : {}),
      ...(e.passId ? { passId: e.passId } : {}),
      ...(e.courierId ? { courierId: e.courierId } : {}),
      ...(e.visitorName ? { visitorName: e.visitorName } : {}),
      ...(e.company ? { company: e.company } : {}),
      ...(e.plate ? { plate: e.plate, plateDisplay: formatPlate(e.plate) } : {}),
      ...(e.note ? { note: e.note } : {}),
      // Sakine kaydi yapan gorevlinin kimligi donmez.
      ...(actor.kind === 'resident' ? {} : { recordedBy: e.recordedBy, recordedByName: people.get(e.recordedBy) ?? ROLE_TEXT[e.recordedByRole] ?? 'Görevli' }),
    };
  }

  /** Elle giris / cikis (QR'siz ziyaretci, servis araci...). */
  async function recordManual(ctx: GateContext, body: unknown) {
    const actor = await actorAs(ctx, 'manager', 'guard');
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const direction = reqEnum(o, 'direction', ['entry', 'exit'] as const);
    const visitorName = reqString(o, 'visitorName', 80, 2);
    const unitId = o.unitId == null || o.unitId === '' ? undefined : await requireUnit(actor, o.unitId);
    const plate = loosePlate(o, 'plate');
    const note = optText(o, 'note', 200);
    const fp = fingerprint({ direction, visitorName, unitId, plate, note, by: ctx.userId });
    const labels = await labelsFor(ctx.apartmentId, unitId ? [unitId] : []);
    const people = await names(ctx.apartmentId);
    const replayLog = async () => {
      const idem = await replayOf(ctx, key, 'log', fp);
      if (!idem) return undefined;
      const entry = await repo.get<GateLogEntry>(ctx.apartmentId, idem.refId);
      if (!entry) throw new GateError('conflict', 'Kayıt sürüyor; tekrar deneyin');
      return { log: logView(actor, entry, labels, people), replayed: true };
    };
    const prior = await replayLog();
    if (prior) return prior;
    const ts = stamp();
    const log = logItems(ctx, ts, { direction, kind: 'manual', ...(unitId ? { unitId } : {}), visitorName, ...(plate ? { plate } : {}), ...(note ? { note } : {}) });
    try {
      await repo.write(ctx.apartmentId, { puts: [{ item: idemItem(ctx, key, 'log', log.entry.SK, fp, ts, log.entry.logId), condition: { kind: 'new' }, reason: 'duplicate' }, ...log.puts] });
    } catch (err) {
      if (err instanceof GateConflictError && err.reason === 'duplicate') {
        const r = await replayLog();
        if (r) return r;
      }
      throw err;
    }
    return { log: logView(actor, log.entry, labels, people), replayed: false };
  }

  /**
   * Kapi gunlugu, en yeni once. Yonetici: tarih araligi (varsayilan son 7 gun), `kind`, `unitId`.
   * Gorevli: yalnizca dun ve bugun. Sakin: yalnizca oturdugu bolumun kayitlari (bolum kopyasindan).
   */
  async function listLog(ctx: GateContext, q: Record<string, string | undefined> = {}) {
    const actor = await actorOf(ctx);
    const d = today();
    let from = q.from || addDays(d, -6);
    const to = q.to || d;
    if (!isIsoDate(from)) throw new ValidationError('from YYYY-MM-DD olmalıdır', 'from');
    if (!isIsoDate(to)) throw new ValidationError('to YYYY-MM-DD olmalıdır', 'to');
    if (to < from) throw new ValidationError('Bitiş tarihi başlangıçtan önce olamaz', 'to');
    if (daySpan(from, to) > LOG_MAX_RANGE_DAYS) throw new ValidationError(`Tarih aralığı en fazla ${LOG_MAX_RANGE_DAYS} gün olabilir`, 'from');
    if (actor.kind === 'guard' && from < addDays(d, -1)) from = addDays(d, -1);
    const kind = q.kind ? (GATE_LOG_KINDS as readonly string[]).includes(q.kind) ? (q.kind as GateLogKind) : undefined : undefined;
    if (q.kind && !kind) throw new ValidationError('kind geçersiz', 'kind');
    let unitId = q.unitId || undefined;
    if (actor.kind === 'resident') {
      unitId ??= actor.unitIds[0];
      if (!unitId) return { items: [], from, to };
      if (!actor.unitIds.includes(unitId)) throw new GateError('forbidden', 'Yalnızca oturduğunuz bağımsız bölümün kayıtlarını görebilirsiniz');
    } else if (unitId) assertId(unitId, 'unitId');
    if (to < from) return { items: [], from, to };
    const limit = Math.min(Math.max(Number(q.limit) || LOG_PAGE, 1), LOG_MAX_PAGE);
    const prefix = unitId ? gateKeys.logUnitPrefix(unitId) : gateKeys.logPrefix;
    const page = await repo.query<GateLogEntry>(ctx.apartmentId, {
      from: `${prefix}${istanbulDayStart(from)}`,
      to: `${prefix}${istanbulDayStart(addDays(to, 1))}`,
      desc: true,
      limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const rows = page.items.filter((e) => e.apartmentId === ctx.apartmentId && (!kind || e.kind === kind));
    const [labels, people] = await Promise.all([labelsFor(ctx.apartmentId, rows.flatMap((e) => (e.unitId ? [e.unitId] : []))), actor.kind === 'resident' ? new Map<string, string>() : names(ctx.apartmentId)]);
    return { items: rows.map((e) => logView(actor, e, labels, people)), from, to, ...(page.cursor ? { nextCursor: page.cursor } : {}) };
  }

  // =========================================================================
  // Bolum secici
  // =========================================================================

  /** Gorevli / yonetici: kurye ve elle giris icin bolum secici (yalnizca etiket; kisi bilgisi yok). */
  async function listUnits(ctx: GateContext, q: string | undefined) {
    const actor = await actorAs(ctx, 'manager', 'guard', 'resident');
    if (actor.kind === 'resident') {
      const labels = await labelsFor(ctx.apartmentId, actor.unitIds);
      return { items: actor.unitIds.map((unitId) => ({ unitId, label: labels.get(unitId) ?? 'Bağımsız bölüm' })) };
    }
    const [units, blocks] = await Promise.all([deps.core.listUnits(ctx.apartmentId), deps.core.listBlocks(ctx.apartmentId)]);
    const byBlock = new Map(blocks.map((b) => [b.blockId, b]));
    const term = (q ?? '').trim().toLocaleLowerCase('tr');
    const collator = new Intl.Collator('tr', { numeric: true });
    const items = units
      .filter((u) => u.status === 'active')
      .map((u) => ({ unitId: u.unitId, label: labelOf(u, byBlock.get(u.blockId), u.unitId) }))
      .filter((u) => !term || u.label.toLocaleLowerCase('tr').includes(term))
      .sort((a, b) => collator.compare(a.label, b.label));
    return { items: items.slice(0, 50), total: items.length };
  }

  /** Sakin portali acilis bilgisi: oturdugu bolumler ve sinirlar. */
  async function portalOverview(ctx: GateContext) {
    const { items } = await listUnits(ctx, undefined);
    return { units: items, limits: { maxVehiclesPerUnit: MAX_VEHICLES_PER_UNIT, maxPassDays: MAX_PASS_DAYS, maxPassLeadDays: MAX_PASS_LEAD_DAYS, courierResponseMinutes: COURIER_RESPONSE_MINUTES } };
  }

  return {
    portalOverview,
    listUnits,
    listVehicles,
    createVehicle,
    updateVehicle,
    lookupPlate,
    createPass,
    listPasses,
    revokePass,
    verifyPass,
    passEntry: (ctx: GateContext, passId: string, body: unknown) => passMove(ctx, passId, body, 'entry'),
    passExit: (ctx: GateContext, passId: string, body: unknown) => passMove(ctx, passId, body, 'exit'),
    createCourier,
    listCouriers,
    respondCourier,
    cancelCourier,
    courierEntry: (ctx: GateContext, courierId: string, body: unknown) => courierMove(ctx, courierId, body, 'entry'),
    courierExit: (ctx: GateContext, courierId: string, body: unknown) => courierMove(ctx, courierId, body, 'exit'),
    recordManual,
    listLog,
  };
}

export type GateService = ReturnType<typeof createGateService>;
