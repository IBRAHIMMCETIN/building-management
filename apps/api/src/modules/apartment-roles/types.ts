/**
 * Faz 5 - Apartman yetki kayitlari (yonetici, yonetim firmasi, denetci, personel).
 *
 * Sakinler (malik/kiraci) `UnitMembership` ile, diger roller bu kayitla tanimlanir.
 * Pre Token Generation Lambda her ikisini de GSI1'den tek sorguda okur.
 *
 *   PK     = `APT#<apartmentId>`, SK     = `ROLE#<userId>#<role>`
 *   GSI1PK = `USER#<userId>`,     GSI1SK = `APT#<apartmentId>#ROLE#<role>`
 *
 * `platform_admin` burada tanimlanamaz: yalnizca Cognito group'undan gelir.
 */
import type { AuditFields, EntityStatus, IsoDate, TableKeys } from '../core/types.js';

export const STAFF_ROLES = [
  'apartment_manager',
  'management_company',
  'observer',
  'building_staff',
  'security_guard',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type ApartmentRole = TableKeys &
  AuditFields & {
    entityType: 'APARTMENT_ROLE';
    userId: string;
    apartmentId: string;
    role: StaffRole;
    /** `management_company` icin sitenin bagli oldugu yonetim firmasi (JWT organizationId). */
    organizationId?: string;
    /** Listelerde gosterim icin (ornegin "Ahmet Yilmaz - Kapici"); kimlik dogrulamada kullanilmaz. */
    displayName?: string;
    /** Faz 1 (Ekip): e-postayla davet edilen kisinin adi ve e-postasi (davet yenileme bunu kullanir). */
    fullName?: string;
    email?: string;
    /** Rol bitirme gerekcesi (denetim kaydinda da tutulur). */
    endReason?: string;
    status: EntityStatus;
    startDate: IsoDate;
    endDate?: IsoDate;
  };

/**
 * Hangi rol hangi rolleri atayabilir/degistirebilir (yetki yukseltmeyi engeller):
 *  - management_company: tum personel rolleri
 *  - apartment_manager : yonetim firmasi DISINDAKI roller
 */
export const GRANTABLE_BY: Readonly<Partial<Record<string, readonly StaffRole[]>>> = {
  management_company: STAFF_ROLES,
  apartment_manager: ['apartment_manager', 'observer', 'building_staff', 'security_guard'],
};

/** Apartmani yoneten roller: en az biri guncel kalmali (son yonetici korumasi). */
export const MANAGING_ROLES: readonly StaffRole[] = ['apartment_manager', 'management_company'];
