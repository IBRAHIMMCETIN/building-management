/** API ile ayni rol listesi (apps/api/src/auth/claims.ts). */
export const ROLES = [
  'platform_admin',
  'management_company',
  'apartment_manager',
  'resident',
  'building_staff',
  'security_guard',
  'observer',
] as const;

export type Role = (typeof ROLES)[number];

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/** Yonetim paneline (AdminLayout) giren roller. Saha rolleri ileride kendi layout'larini alacak. */
export const ADMIN_ROLES = [
  'platform_admin',
  'management_company',
  'apartment_manager',
  'observer',
  'building_staff',
  'security_guard',
] as const satisfies readonly Role[];

export const RESIDENT_ROLES = ['resident'] as const satisfies readonly Role[];

/** Yalnizca platform ekibinin ekranlari (/admin/apartments, /admin/payments). */
export const PLATFORM_ROLES = ['platform_admin'] as const satisfies readonly Role[];

/**
 * Apartmana ozel yonetim ekranlari (genel bakis, daireler, finans, duyurular, aktarim, ayarlar).
 * `platform_admin` apartman baglami tasimaz ve API apartman verisini ona acmaz.
 */
export const APARTMENT_ADMIN_ROLES = ADMIN_ROLES.filter((r) => r !== 'platform_admin') as readonly Role[];

/**
 * Apartman ofis ekranlari (daireler, finans, duyurular, toplu aktarim, ayarlar): yonetim rolleri ve
 * salt okur denetci. Bina gorevlisi ve guvenlik bu ekranlari GORMEZ (menu + dogrudan URL korumasi);
 * yetkinin asli yine API'dedir.
 */
export const OFFICE_ROLES = ['apartment_manager', 'management_company', 'observer'] as const satisfies readonly Role[];

export const isPlatformRole = (role: Role | undefined): role is 'platform_admin' => role === 'platform_admin';

/** Denetim gunlugu (/admin/audit): apartman rolleri kendi zincirini, platform yoneticisi platform zincirini. */
export const AUDIT_ROLES = ['apartment_manager', 'management_company', 'observer', 'platform_admin'] as const satisfies readonly Role[];

/** Guvenlik / MFA sifirlama (/admin/security): apartman yoneticisi ve yonetim firmasi. */
/** Sayac dagitimi (Finans 2.3): sicil / sablon / donem ekranlari (denetci salt okur). */
export const METER_ROLES = ['apartment_manager', 'management_company', 'observer'] as const satisfies readonly Role[];
/** Hizli sayac okuma girisi (bina gorevlisi dahil). */
export const METER_READING_ROLES = ['apartment_manager', 'management_company', 'building_staff'] as const satisfies readonly Role[];

/** Ekip (/admin/team): yonetici + yonetim firmasi yazar, denetci salt okur. */
export const TEAM_ROLES = ['apartment_manager', 'management_company', 'observer'] as const satisfies readonly Role[];

export const SECURITY_ROLES = ['apartment_manager', 'management_company'] as const satisfies readonly Role[];

/** Faz 3 (O1) Ariza & Bakim (/admin/tickets): guvenlik yalnizca kendi talepleri; denetci salt okur. */
export const TICKET_ROLES = ['apartment_manager', 'management_company', 'building_staff', 'security_guard', 'observer'] as const satisfies readonly Role[];
/** Guvenlik kapisi (/admin/gate): guvenlik gorevlisi + yonetim. Denetci ve bina gorevlisi gormez (KVKK: en az erisim). */
export const GATE_ROLES = ['apartment_manager', 'management_company', 'security_guard'] as const satisfies readonly Role[];
/** Arac sicili, misafir gecisi listesi ve tum kapi gunlugu: yalnizca yonetim. */
export const GATE_MANAGE_ROLES = ['apartment_manager', 'management_company'] as const satisfies readonly Role[];
/** Ariza & bakim v2 ekipman sicili (/admin/equipment): yonetim yazar; denetci ve bina gorevlisi okur. */
export const EQUIPMENT_ROLES = ['apartment_manager', 'management_company', 'building_staff', 'observer'] as const satisfies readonly Role[];
/** Gorevli "Islerim" (/admin/my-tasks). */
export const MY_TASKS_ROLES = ['building_staff'] as const satisfies readonly Role[];

/** Platform yoneticisinin acilis sayfasi. */
export const PLATFORM_HOME = '/admin/apartments';

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: 'Platform Yöneticisi',
  management_company: 'Yönetim Firması',
  apartment_manager: 'Apartman Yöneticisi',
  resident: 'Daire Sakini',
  building_staff: 'Bina Görevlisi',
  security_guard: 'Güvenlik',
  observer: 'Denetçi',
};

/** Giris sonrasi role gore varsayilan sayfa. */
export function homePathForRole(role: Role): string {
  if (role === 'resident') return '/app';
  if (role === 'platform_admin') return PLATFORM_HOME;
  return '/admin';
}
