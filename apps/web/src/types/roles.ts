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
  return role === 'resident' ? '/app' : '/admin';
}
