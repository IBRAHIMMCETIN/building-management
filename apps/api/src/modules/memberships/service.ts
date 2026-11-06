import { DataAccessError } from '../../config/dynamodb.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { CoreError, isAtMostOne, sumLandShares } from '../core/service.js';
import type { IsoDate } from '../core/types.js';
import {
  type Obj,
  ValidationError,
  asObject,
  assertId,
  isIsoDate,
  optBool,
  optEnum,
  reqEnum,
  reqInt,
  reqString,
} from '../core/validation.js';
import { type UnitMembership, type UnitRelation, visibleParties } from '../portal/types.js';
import { type MembershipRepository, membershipKeys, membershipRepository } from './repository.js';

/**
 * Yonetici tarafi daire uyeligi yonetimi (malik / kiraci atama, giris-cikis tarihleri).
 *
 * Is kurallari:
 *  - Daire, JWT'deki apartmana ait ve aktif olmalidir; apartman daima claim'den gelir.
 *  - Kiraci daima dairede oturur (`residesInUnit = true`) ve hisse payi tasimaz.
 *  - Ayni donemde "dairede oturan malik" ile "kiraci" birlikte bulunamaz: ikisi de sakin
 *    (`occupant`) carisini gorur; cakisma, kiracinin hareketlerinin malike sizmasi demektir.
 *    Ayni hanedeki birden fazla kiraci (es, ev arkadasi) ise serbesttir.
 *  - Cakisan donemlerdeki maliklerin hisse paylari toplami 1'i asamaz.
 *  - `relation` sonradan degistirilemez (malik -> kiraci gibi gecisler yeni donem demektir).
 *  - Silme yok: hatali kayit `status: 'inactive'` ile iptal edilir; tasinma `endDate` ile.
 */

const RELATIONS = ['owner', 'tenant'] as const satisfies readonly UnitRelation[];
const STATUS_FILTERS = ['active', 'inactive', 'all'] as const;
export type MembershipStatusFilter = (typeof STATUS_FILTERS)[number];

export type MembershipContext = { apartmentId: string; userId: string };

export type MembershipServiceDeps = {
  repository: MembershipRepository;
  core: Pick<CoreRepository, 'getUnit'>;
  now: () => Date;
};

export type MembershipView = UnitMembership & {
  /** Bugun (Europe/Istanbul) gecerli mi? */
  isCurrent: boolean;
  visibleParties: ReturnType<typeof visibleParties>;
};

// ---------------------------------------------------------------------------
// Saf yardimcilar
// ---------------------------------------------------------------------------

type Period = Pick<UnitMembership, 'startDate' | 'endDate'>;

/** Iki donem ortak en az bir gun iceriyor mu? (bitis tarihi dahil) */
export function periodsOverlap(a: Period, b: Period): boolean {
  return a.startDate <= (b.endDate ?? '9999-12-31') && b.startDate <= (a.endDate ?? '9999-12-31');
}

function reqDate(o: Obj, key: string): IsoDate {
  const v = reqString(o, key, 10, 10);
  if (!isIsoDate(v)) throw new ValidationError(`${key} YYYY-MM-DD biciminde gecerli bir tarih olmalidir`, key);
  return v;
}

function parseShare(value: unknown): { numerator: number; denominator: number } {
  const o = asObject(value, 'ownershipShare');
  const numerator = reqInt(o, 'numerator', 1, 1_000_000);
  const denominator = reqInt(o, 'denominator', 1, 1_000_000);
  if (numerator > denominator) {
    throw new ValidationError('ownershipShare payi paydadan buyuk olamaz', 'ownershipShare');
  }
  return { numerator, denominator };
}

/** Kiraci/malik alan kurallari (yapisal). */
function assertShape(m: Pick<UnitMembership, 'relation' | 'residesInUnit' | 'ownershipShare' | 'startDate' | 'endDate'>) {
  if (m.relation === 'tenant' && !m.residesInUnit) {
    throw new ValidationError('Kiraci icin residesInUnit false olamaz', 'residesInUnit');
  }
  if (m.relation === 'tenant' && m.ownershipShare) {
    throw new ValidationError('Kiraciya hisse payi tanimlanamaz', 'ownershipShare');
  }
  if (m.endDate && m.endDate < m.startDate) {
    throw new ValidationError('endDate, startDate tarihinden once olamaz', 'endDate');
  }
}

/**
 * Ayni dairedeki diger aktif uyeliklerle cakisma kurallari (bkz. modul aciklamasi).
 * `others` adayin kendisini icermemelidir.
 */
export function assertNoConflicts(candidate: UnitMembership, others: UnitMembership[]): void {
  if (candidate.status !== 'active') return;
  const overlapping = others.filter(
    (m) => m.status === 'active' && m.unitId === candidate.unitId && periodsOverlap(m, candidate),
  );

  const isResidentOwner = (m: UnitMembership) => m.relation === 'owner' && m.residesInUnit;
  const clash = overlapping.find(
    (m) =>
      (candidate.relation === 'tenant' && isResidentOwner(m)) ||
      (isResidentOwner(candidate) && m.relation === 'tenant'),
  );
  if (clash) {
    throw new CoreError(
      'conflict',
      'Ayni donemde dairede oturan malik ve kiraci birlikte tanimlanamaz (sakin carisi paylasilir). ' +
        'Kiraci donemini bitirin veya malikin residesInUnit alanini false yapin.',
    );
  }

  if (candidate.relation === 'owner' && candidate.ownershipShare) {
    const shares = overlapping
      .filter((m) => m.relation === 'owner' && m.ownershipShare)
      .map((m) => m.ownershipShare as { numerator: number; denominator: number });
    shares.push(candidate.ownershipShare);
    if (!isAtMostOne(sumLandShares(shares))) {
      throw new CoreError('conflict', "Ayni donemdeki maliklerin hisse paylari toplami 1'i asamaz");
    }
  }
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export function createMembershipService(overrides: Partial<MembershipServiceDeps> = {}) {
  const deps: MembershipServiceDeps = {
    repository: membershipRepository,
    core: coreRepository,
    now: () => new Date(),
    ...overrides,
  };
  const repo = deps.repository;

  const today = (): IsoDate =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const stamp = () => deps.now().toISOString();

  function view(m: UnitMembership): MembershipView {
    const day = today();
    return {
      ...m,
      isCurrent: m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day),
      visibleParties: visibleParties(m),
    };
  }

  async function requireMembership(ctx: MembershipContext, userId: string, unitId: string): Promise<UnitMembership> {
    assertId(userId, 'userId');
    assertId(unitId, 'unitId');
    const m = await repo.get(ctx.apartmentId, userId, unitId);
    if (!m) throw new CoreError('not_found', 'Uyelik bulunamadi');
    return m;
  }

  async function checkConflicts(ctx: MembershipContext, candidate: UnitMembership): Promise<void> {
    const others = (await repo.list(ctx.apartmentId, { unitId: candidate.unitId })).filter(
      (m) => m.userId !== candidate.userId,
    );
    assertNoConflicts(candidate, others);
  }

  function mapWriteError(err: unknown, onConflict: string): unknown {
    if (err instanceof DataAccessError && err.code === 'conflict') return new CoreError('conflict', onConflict);
    return err;
  }

  // ----- Olustur -----

  async function create(ctx: MembershipContext, body: unknown): Promise<MembershipView> {
    const o = asObject(body);
    const userId = assertId(o.userId, 'userId');
    const unitId = assertId(o.unitId, 'unitId');
    const relation = reqEnum(o, 'relation', RELATIONS);
    const residesInUnit = optBool(o, 'residesInUnit') ?? relation === 'tenant';
    const ownershipShare = o.ownershipShare == null ? undefined : parseShare(o.ownershipShare);
    const startDate = reqDate(o, 'startDate');
    const endDate = o.endDate == null ? undefined : reqDate(o, 'endDate');
    assertShape({ relation, residesInUnit, ownershipShare, startDate, endDate });

    const unit = await deps.core.getUnit(ctx.apartmentId, unitId);
    if (!unit || unit.status !== 'active') throw new CoreError('not_found', 'Bagimsiz bolum bulunamadi veya pasif');

    const ts = stamp();
    const membership: UnitMembership = {
      ...membershipKeys.membership(ctx.apartmentId, userId, unitId),
      entityType: 'UNIT_MEMBERSHIP',
      userId,
      apartmentId: ctx.apartmentId,
      unitId,
      relation,
      residesInUnit,
      ownershipShare,
      status: 'active',
      startDate,
      endDate,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };

    await checkConflicts(ctx, membership);
    try {
      await repo.create(membership);
    } catch (err) {
      throw mapWriteError(err, 'Bu kullanici bu daireye zaten atanmis; mevcut kaydi guncelleyin');
    }
    return view(membership);
  }

  // ----- Oku -----

  async function list(
    ctx: MembershipContext,
    filter: { unitId?: string; userId?: string; status?: string; current?: string } = {},
  ): Promise<MembershipView[]> {
    const unitId = filter.unitId ? assertId(filter.unitId, 'unitId') : undefined;
    const userId = filter.userId ? assertId(filter.userId, 'userId') : undefined;
    const status: MembershipStatusFilter =
      optEnum({ status: filter.status }, 'status', STATUS_FILTERS) ?? 'active';
    const onlyCurrent = filter.current === 'true';

    const items = (await repo.list(ctx.apartmentId, { unitId }))
      .filter(
        (m) =>
          m.apartmentId === ctx.apartmentId &&
          (!unitId || m.unitId === unitId) &&
          (!userId || m.userId === userId) &&
          (status === 'all' || m.status === status),
      )
      .map(view)
      .filter((m) => !onlyCurrent || m.isCurrent);

    return items.sort(
      (a, b) =>
        a.unitId.localeCompare(b.unitId) ||
        a.relation.localeCompare(b.relation) ||
        b.startDate.localeCompare(a.startDate) ||
        a.userId.localeCompare(b.userId),
    );
  }

  async function get(ctx: MembershipContext, userId: string, unitId: string): Promise<MembershipView> {
    return view(await requireMembership(ctx, userId, unitId));
  }

  // ----- Guncelle (giris/cikis tarihleri, oturma durumu, hisse) -----

  async function update(ctx: MembershipContext, userId: string, unitId: string, body: unknown): Promise<MembershipView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireMembership(ctx, userId, unitId);
    if (current.version !== version) {
      throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
    }
    if (o.relation !== undefined && o.relation !== current.relation) {
      throw new ValidationError(
        'relation degistirilemez; mevcut donemi bitirip yeni uyelik olusturun',
        'relation',
      );
    }
    if (o.status !== undefined) {
      throw new ValidationError('status bu uc noktadan degistirilemez (iptal icin DELETE)', 'status');
    }

    const next: UnitMembership = {
      ...current,
      startDate: o.startDate === undefined ? current.startDate : reqDate(o, 'startDate'),
      endDate: o.endDate === undefined ? current.endDate : o.endDate === null ? undefined : reqDate(o, 'endDate'),
      residesInUnit: optBool(o, 'residesInUnit') ?? current.residesInUnit,
      ownershipShare:
        o.ownershipShare === undefined
          ? current.ownershipShare
          : o.ownershipShare === null
            ? undefined
            : parseShare(o.ownershipShare),
      updatedAt: stamp(),
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    assertShape(next);
    await checkConflicts(ctx, next);

    try {
      await repo.update(next, current.version);
    } catch (err) {
      throw mapWriteError(err, 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
    }
    return view(next);
  }

  // ----- Iptal (silme yok) -----

  async function deactivate(ctx: MembershipContext, userId: string, unitId: string): Promise<MembershipView> {
    const current = await requireMembership(ctx, userId, unitId);
    if (current.status === 'inactive') return view(current);
    const next: UnitMembership = {
      ...current,
      status: 'inactive',
      updatedAt: stamp(),
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    try {
      await repo.update(next, current.version);
    } catch (err) {
      throw mapWriteError(err, 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
    }
    return view(next);
  }

  return { create, list, get, update, deactivate };
}

export type MembershipService = ReturnType<typeof createMembershipService>;
