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
import { type UserDirectory, createDirectoryFromEnv } from '../residents/directory.js';
import { EMAIL_RE, cognitoErrorToResidents, maskEmail } from '../residents/service.js';
import { type ApartmentRoleRepository, apartmentRoleKeys, apartmentRoleRepository } from './repository.js';
import { type ApartmentRole, GRANTABLE_BY, MANAGING_ROLES, STAFF_ROLES, type StaffRole } from './types.js';

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
 *  - Faz 1 (Ekip): e-postayla davet (`invite`, Cognito kullanicisini bulur/olusturur), gerekceli
 *    rol bitirme (`end`) ve davet yenileme (`resendInvite`).
 *  - Son yonetici korumasi: apartmanda guncel `apartment_manager` / `management_company`
 *    kaydi kalmayacaksa bitirme / pasife alma / bitis tarihini one cekme reddedilir (409).
 * Not: degisiklikler kullanicinin bir sonraki token yenilemesinde (en gec access/id token
 * omru kadar) etkili olur.
 */

const STATUS_FILTERS = ['active', 'inactive', 'all'] as const;

export type ApartmentRoleContext = { apartmentId: string; userId: string; role: Role };

export type ApartmentRoleServiceDeps = {
  repository: ApartmentRoleRepository;
  core: Pick<CoreRepository, 'getSite'>;
  /** Cognito kullanici dizini (davet). Verilmezse ortamdan secilir (bkz. residents/directory). */
  directory: UserDirectory;
  now: () => Date;
};

export type ApartmentRoleView = ApartmentRole & { isCurrent: boolean };

export type RoleInviteResult = {
  role: ApartmentRoleView;
  /** sent: yeni hesap + gecici sifre e-postasi; existing_user: hesap vardi (e-posta gitmez). */
  invitation: 'sent' | 'existing_user';
  /** Pasif (bitirilmis) kayit yeniden etkinlestirildi mi? */
  reactivated: boolean;
  /** Yalnizca yerel mock dizinde: ilk giris icin gecici sifre. */
  mock?: { temporaryPassword?: string };
};

const REASON_MIN = 5;
const REASON_MAX = 300;

function reqDate(o: Obj, key: string): IsoDate {
  const v = reqString(o, key, 10, 10);
  if (!isIsoDate(v)) throw new ValidationError(`${key} YYYY-MM-DD biciminde gecerli bir tarih olmalidir`, key);
  return v;
}

export function createApartmentRoleService(overrides: Partial<ApartmentRoleServiceDeps> = {}) {
  const deps: ApartmentRoleServiceDeps = {
    repository: apartmentRoleRepository,
    core: coreRepository,
    directory: overrides.directory ?? createDirectoryFromEnv(),
    now: () => new Date(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  const isCurrentOn = (r: ApartmentRole, day: IsoDate) => r.status === 'active' && r.startDate <= day && (!r.endDate || r.endDate >= day);

  function view(r: ApartmentRole, viewerRole?: Role): ApartmentRoleView {
    return {
      ...r,
      // Denetci kisilerin e-postasini maskeli gorur (sakin dizinindeki kuralla ayni).
      ...(viewerRole === 'observer' && r.email ? { email: maskEmail(r.email) } : {}),
      isCurrent: isCurrentOn(r, today()),
    };
  }

  /**
   * Son yonetici korumasi: `next` kaydi uygulandiktan sonra apartmanda bugun ve ileride
   * yonetecek biri kalmali. Yalnizca yonetici rolleri icin kontrol edilir.
   */
  async function assertManagerRemains(ctx: ApartmentRoleContext, next: ApartmentRole): Promise<void> {
    if (!MANAGING_ROLES.includes(next.role)) return;
    const day = today();
    const others = (await repo.list(ctx.apartmentId)).filter(
      (r) => r.apartmentId === ctx.apartmentId && MANAGING_ROLES.includes(r.role) && !(r.userId === next.userId && r.role === next.role),
    );
    // Bitis tarihinden sonra da yonetici kalmali: bugun gecerli ve (bitissiz ya da `next`ten uzun) bir kayit.
    const nextEnds = next.status !== 'active' ? day : next.endDate;
    if (!nextEnds) return; // bitissiz aktif kayit: kendisi yonetmeye devam ediyor
    const remains = others.some((r) => isCurrentOn(r, day) && (!r.endDate || r.endDate > nextEnds));
    if (!remains) {
      throw new CoreError('conflict', 'Apartmanda en az bir aktif yönetici kalmalı; önce yeni yöneticiyi atayın');
    }
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

  async function save(next: ApartmentRole, expectedVersion: number, audit?: { action?: string; reason?: string }): Promise<ApartmentRoleView> {
    try {
      await repo.update(next, expectedVersion, audit);
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
      .map((r) => view(r, ctx.role))
      .filter((r) => filter.current !== 'true' || r.isCurrent)
      .sort((a, b) => a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId));
  }

  const get = async (ctx: ApartmentRoleContext, userId: string, role: string) =>
    view(await requireRecord(ctx, userId, role), ctx.role);

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
    if (endDate && (!current.endDate || endDate < current.endDate)) {
      await assertManagerRemains(ctx, { ...current, endDate });
    }

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
    await assertManagerRemains(ctx, { ...current, status: 'inactive' });
    return save(
      { ...current, status: 'inactive', updatedAt: stamp(), updatedBy: ctx.userId, version: current.version + 1 },
      current.version,
    );
  }

  /**
   * E-postayla ekip daveti: Cognito kullanicisi bulunur ya da olusturulur (gecici sifre
   * e-postasi), ardindan yetki kaydi yazilir. Pasif kayit yeniden etkinlestirilir; aktif kayit
   * 409. Gecersiz istek Cognito'ya dokunmadan reddedilir.
   */
  async function invite(ctx: ApartmentRoleContext, body: unknown): Promise<RoleInviteResult> {
    const o = asObject(body);
    const role = reqEnum(o, 'role', STAFF_ROLES);
    const fullName = reqString(o, 'fullName', 100, 2).replace(/\s+/g, ' ');
    const email = reqString(o, 'email', 254, 3).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('email gecerli bir e-posta adresi olmalidir', 'email');
    const startDate = o.startDate == null ? today() : reqDate(o, 'startDate');
    const endDate = o.endDate == null ? undefined : reqDate(o, 'endDate');
    assertDates(startDate, endDate);
    if (!(GRANTABLE_BY[ctx.role] ?? []).includes(role)) {
      throw new AccessDeniedError(`${ctx.role} rolu ${role} yetkisini yonetemez`);
    }
    const site = await deps.core.getSite(ctx.apartmentId);
    if (!site) throw new CoreError('not_found', 'Site bulunamadi');

    let account: Awaited<ReturnType<UserDirectory['findOrCreate']>>;
    try {
      account = await deps.directory.findOrCreate({ email, fullName, sendInvitation: true });
    } catch (err) {
      throw cognitoErrorToResidents(err);
    }
    assertCanManage(ctx, { role, userId: account.userId });

    const ts = stamp();
    const existing = await repo.get(ctx.apartmentId, account.userId, role);
    let saved: ApartmentRoleView;
    if (existing) {
      if (existing.status === 'active') {
        throw new CoreError('conflict', 'Bu kişi bu rolle zaten ekipte; tarihleri kayıttan güncelleyin');
      }
      const { endReason: _r, ...rest } = existing;
      saved = await save(
        {
          ...rest,
          status: 'active',
          startDate,
          endDate,
          fullName,
          email,
          displayName: fullName,
          updatedAt: ts,
          updatedBy: ctx.userId,
          version: existing.version + 1,
        },
        existing.version,
        { action: 'apartment_role.invite' },
      );
    } else {
      const record: ApartmentRole = {
        ...apartmentRoleKeys.role(ctx.apartmentId, account.userId, role),
        entityType: 'APARTMENT_ROLE',
        userId: account.userId,
        apartmentId: ctx.apartmentId,
        role,
        organizationId: role === 'management_company' ? site.tenantId : undefined,
        displayName: fullName,
        fullName,
        email,
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
          throw new CoreError('conflict', 'Bu kişi bu rolle zaten ekipte; tarihleri kayıttan güncelleyin');
        }
        throw err;
      }
      saved = view(record);
    }
    return {
      role: saved,
      invitation: account.created ? 'sent' : 'existing_user',
      reactivated: !!existing,
      ...(deps.directory.kind === 'mock' ? { mock: { temporaryPassword: account.temporaryPassword } } : {}),
    };
  }

  /**
   * Gerekceli rol bitirme. `endDate` (varsayilan bugun) bugun veya oncesiyse kayit hemen
   * pasife alinir; ileri tarihse aktif kalir ve o gun sona erer (pre-token `isCurrent`).
   */
  async function end(ctx: ApartmentRoleContext, userId: string, role: string, body: unknown): Promise<ApartmentRoleView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', REASON_MAX, REASON_MIN).trim();
    const current = await requireRecord(ctx, userId, role);
    assertCanManage(ctx, current);
    if (current.version !== version) {
      throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
    }
    if (current.status === 'inactive') throw new CoreError('conflict', 'Bu rol zaten sona erdirilmiş');
    const day = today();
    const endDate = o.endDate == null ? day : reqDate(o, 'endDate');
    if (endDate < current.startDate) throw new ValidationError('endDate, startDate tarihinden once olamaz', 'endDate');
    const next: ApartmentRole = {
      ...current,
      endDate,
      endReason: reason,
      status: endDate <= day ? 'inactive' : 'active',
      updatedAt: stamp(),
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    await assertManagerRemains(ctx, next);
    return save(next, current.version, { action: 'apartment_role.end', reason });
  }

  /** Ilk girisini yapmamis kullaniciya gecici sifre e-postasini yeniden gonderir. */
  async function resendInvite(ctx: ApartmentRoleContext, userId: string, role: string): Promise<{ result: 'sent' | 'not_pending' }> {
    const current = await requireRecord(ctx, userId, role);
    assertCanManage(ctx, current);
    if (current.status !== 'active') throw new CoreError('conflict', 'Sona ermiş role davet gönderilemez');
    if (!current.email) throw new ValidationError('Bu kayıtta e-posta yok; kişiyi e-postayla yeniden davet edin', 'email');
    try {
      return { result: await deps.directory.resendInvitation(current.email) };
    } catch (err) {
      throw cognitoErrorToResidents(err);
    }
  }

  return { create, list, get, update, deactivate, invite, end, resendInvite };
}

export type ApartmentRoleService = ReturnType<typeof createApartmentRoleService>;
