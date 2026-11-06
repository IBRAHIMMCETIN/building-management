import type { Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { AccessDeniedError } from '../../http/errors.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { CoreError } from '../core/service.js';
import type { IsoDate } from '../core/types.js';
import {
  type Obj,
  ValidationError,
  asObject,
  assertId,
  isIsoDate,
  optEnum,
  optString,
  reqEnum,
  reqInt,
  reqString,
} from '../core/validation.js';
import { type ApartmentRoleRepository, apartmentRoleKeys, apartmentRoleRepository } from './repository.js';
import { type ApartmentRole, GRANTABLE_BY, STAFF_ROLES, type StaffRole } from './types.js';

/**
 * Apartman yetki kayitlari (yonetici / yonetim firmasi / denetci / personel).
 *
 * Kurallar:
 *  - Apartman daima JWT claim'inden gelir.
 *  - Yetki yukseltme yok: islemi yapan kisi yalnizca `GRANTABLE_BY[kendi rolu]` icindeki
 *    rolleri atayabilir, degistirebilir veya kaldirabilir (yonetici, yonetim firmasi
 *    kaydina dokunamaz).
 *  - Kilitlenme korumasi: kimse KENDI yetki kaydini degistiremez/kaldiramaz.
 *  - `management_company` kaydi sitenin bagli oldugu firmayi (`organizationId`) tasir.
 *  - Silme yok: `DELETE` kaydi pasife alir. Kayit anahtarinda rol oldugu icin rol degisimi
 *    = eski kaydi kaldir + yeni kayit olustur.
 * Not: degisiklikler kullanicinin bir sonraki token yenilemesinde (en gec access/id token
 * omru kadar) etkili olur.
 */

const STATUS_FILTERS = ['active', 'inactive', 'all'] as const;

export type ApartmentRoleContext = { apartmentId: string; userId: string; role: Role };

export type ApartmentRoleServiceDeps = {
  repository: ApartmentRoleRepository;
  core: Pick<CoreRepository, 'getSite'>;
  now: () => Date;
};

export type ApartmentRoleView = ApartmentRole & { isCurrent: boolean };

function reqDate(o: Obj, key: string): IsoDate {
  const v = reqString(o, key, 10, 10);
  if (!isIsoDate(v)) throw new ValidationError(`${key} YYYY-MM-DD biciminde gecerli bir tarih olmalidir`, key);
  return v;
}

export function createApartmentRoleService(overrides: Partial<ApartmentRoleServiceDeps> = {}) {
  const deps: ApartmentRoleServiceDeps = {
    repository: apartmentRoleRepository,
    core: coreRepository,
    now: () => new Date(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  function view(r: ApartmentRole): ApartmentRoleView {
    const day = today();
    return {
      ...r,
      isCurrent: r.status === 'active' && r.startDate <= day && (!r.endDate || r.endDate >= day),
    };
  }

  function assertCanManage(ctx: ApartmentRoleContext, target: { role: StaffRole; userId: string }): void {
    const allowed = GRANTABLE_BY[ctx.role] ?? [];
    if (!allowed.includes(target.role)) {
      throw new AccessDeniedError(`${ctx.role} rolu ${target.role} yetkisini yonetemez`);
    }
    if (target.userId === ctx.userId) {
      throw new AccessDeniedError('Kendi yetki kaydinizi degistiremezsiniz');
    }
  }

  function assertDates(startDate: IsoDate, endDate: IsoDate | undefined): void {
    if (endDate && endDate < startDate) {
      throw new ValidationError('endDate, startDate tarihinden once olamaz', 'endDate');
    }
  }

  async function requireRecord(ctx: ApartmentRoleContext, userId: string, role: string): Promise<ApartmentRole> {
    assertId(userId, 'userId');
    const r = reqEnum({ role }, 'role', STAFF_ROLES);
    const record = await repo.get(ctx.apartmentId, userId, r);
    if (!record) throw new CoreError('not_found', 'Yetki kaydi bulunamadi');
    return record;
  }

  async function save(next: ApartmentRole, expectedVersion: number): Promise<ApartmentRoleView> {
    try {
      await repo.update(next, expectedVersion);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
      }
      throw err;
    }
    return view(next);
  }

  async function create(ctx: ApartmentRoleContext, body: unknown): Promise<ApartmentRoleView> {
    const o = asObject(body);
    const userId = assertId(o.userId, 'userId');
    const role = reqEnum(o, 'role', STAFF_ROLES);
    const startDate = o.startDate == null ? today() : reqDate(o, 'startDate');
    const endDate = o.endDate == null ? undefined : reqDate(o, 'endDate');
    assertDates(startDate, endDate);
    assertCanManage(ctx, { role, userId });

    const site = await deps.core.getSite(ctx.apartmentId);
    if (!site) throw new CoreError('not_found', 'Site bulunamadi');

    const ts = stamp();
    const record: ApartmentRole = {
      ...apartmentRoleKeys.role(ctx.apartmentId, userId, role),
      entityType: 'APARTMENT_ROLE',
      userId,
      apartmentId: ctx.apartmentId,
      role,
      organizationId: role === 'management_company' ? site.tenantId : undefined,
      displayName: optString(o, 'displayName', 120),
      status: 'active',
      startDate,
      endDate,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.create(record);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        throw new CoreError('conflict', 'Bu kullanici bu rolle zaten tanimli; mevcut kaydi guncelleyin');
      }
      throw err;
    }
    return view(record);
  }

  async function list(
    ctx: ApartmentRoleContext,
    filter: { role?: string; userId?: string; status?: string; current?: string } = {},
  ): Promise<ApartmentRoleView[]> {
    const role = optEnum({ role: filter.role }, 'role', STAFF_ROLES);
    const userId = filter.userId ? assertId(filter.userId, 'userId') : undefined;
    const status = optEnum({ status: filter.status }, 'status', STATUS_FILTERS) ?? 'active';
    return (await repo.list(ctx.apartmentId))
      .filter(
        (r) =>
          r.apartmentId === ctx.apartmentId &&
          (!role || r.role === role) &&
          (!userId || r.userId === userId) &&
          (status === 'all' || r.status === status),
      )
      .map(view)
      .filter((r) => filter.current !== 'true' || r.isCurrent)
      .sort((a, b) => a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId));
  }

  const get = async (ctx: ApartmentRoleContext, userId: string, role: string) =>
    view(await requireRecord(ctx, userId, role));

  async function update(ctx: ApartmentRoleContext, userId: string, role: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireRecord(ctx, userId, role);
    assertCanManage(ctx, current);
    if (current.version !== version) {
      throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
    }
    for (const key of ['role', 'userId', 'status', 'organizationId'] as const) {
      if (o[key] !== undefined) throw new ValidationError(`${key} bu uc noktadan degistirilemez`, key);
    }

    const startDate = o.startDate === undefined ? current.startDate : reqDate(o, 'startDate');
    const endDate =
      o.endDate === undefined ? current.endDate : o.endDate === null ? undefined : reqDate(o, 'endDate');
    assertDates(startDate, endDate);

    return save(
      {
        ...current,
        startDate,
        endDate,
        displayName:
          o.displayName === undefined
            ? current.displayName
            : o.displayName === null
              ? undefined
              : optString(o, 'displayName', 120),
        updatedAt: stamp(),
        updatedBy: ctx.userId,
        version: current.version + 1,
      },
      current.version,
    );
  }

  async function deactivate(ctx: ApartmentRoleContext, userId: string, role: string) {
    const current = await requireRecord(ctx, userId, role);
    assertCanManage(ctx, current);
    if (current.status === 'inactive') return view(current);
    return save(
      { ...current, status: 'inactive', updatedAt: stamp(), updatedBy: ctx.userId, version: current.version + 1 },
      current.version,
    );
  }

  return { create, list, get, update, deactivate };
}

export type ApartmentRoleService = ReturnType<typeof createApartmentRoleService>;
