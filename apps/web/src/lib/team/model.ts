import type { ApartmentRoleView, StaffRole } from '@/lib/api/apartmentRoles';
import type { Role } from '@/types/roles';

/**
 * Ekip ekrani saf kurallari (API ile ayni: apps/api/src/modules/apartment-roles/types.ts).
 * Yetki kontrolu her zaman API'dedir; bunlar yalnizca arayuzu yonlendirir.
 */
export const GRANTABLE_BY: Partial<Record<Role, readonly StaffRole[]>> = {
  management_company: ['apartment_manager', 'management_company', 'observer', 'building_staff', 'security_guard'],
  apartment_manager: ['apartment_manager', 'observer', 'building_staff', 'security_guard'],
};
export const MANAGING_ROLES: readonly string[] = ['apartment_manager', 'management_company'];

export const TEAM_ROLE_HINTS: Record<StaffRole, string> = {
  apartment_manager: 'Tüm idari ve finansal işlemler',
  management_company: 'Profesyonel yönetim firması',
  observer: 'Denetim kurulu: kasa, banka ve raporları salt okunur görür',
  building_staff: 'Sayaç okuma ve kendisine atanan işler',
  security_guard: 'Ziyaretçi ve araç girişleri',
};

export type TeamStatus = 'current' | 'scheduled' | 'ending' | 'ended';

export function teamStatus(r: ApartmentRoleView, today: string): TeamStatus {
  if (r.status !== 'active' || (r.endDate && r.endDate < today)) return 'ended';
  if (r.startDate && r.startDate > today) return 'scheduled';
  if (r.endDate) return 'ending';
  return 'current';
}

export const TEAM_STATUS_META: Record<TeamStatus, { label: string; tone: 'success' | 'accent' | 'warning' | 'neutral' }> = {
  current: { label: 'Aktif', tone: 'success' },
  scheduled: { label: 'Başlayacak', tone: 'accent' },
  ending: { label: 'Bitiş planlı', tone: 'warning' },
  ended: { label: 'Sona erdi', tone: 'neutral' },
};

/** Islemi yapan bu kaydi yonetebilir mi (rol hiyerarsisi + kendi kaydi korumasi). */
export function canManageRecord(actor: { role?: Role; userId?: string }, r: Pick<ApartmentRoleView, 'role' | 'userId'>): boolean {
  if (!actor.role || r.userId === actor.userId) return false;
  return (GRANTABLE_BY[actor.role] ?? []).includes(r.role as StaffRole);
}

/**
 * Son yonetici korumasinin arayuz tahmini: bu kayit bitirilirse apartmanda bugun gecerli ve
 * bitissiz (ya da daha uzun) baska bir yonetici kalir mi? Kesin karari API verir (409).
 */
export function isLastManager(records: readonly ApartmentRoleView[], target: Pick<ApartmentRoleView, 'userId' | 'role'>, today: string): boolean {
  if (!MANAGING_ROLES.includes(target.role)) return false;
  return !records.some(
    (r) =>
      MANAGING_ROLES.includes(r.role) &&
      !(r.userId === target.userId && r.role === target.role) &&
      teamStatus(r, today) !== 'ended' &&
      teamStatus(r, today) !== 'scheduled' &&
      (!r.endDate || r.endDate > today),
  );
}

export const personName = (r: ApartmentRoleView) => r.fullName ?? r.displayName ?? 'İsimsiz kullanıcı';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export type InviteDraft = { fullName: string; email: string; role: StaffRole | ''; startDate: string; endDate: string };

export function inviteErrors(d: InviteDraft): Partial<Record<keyof InviteDraft, string>> {
  const e: Partial<Record<keyof InviteDraft, string>> = {};
  if (d.fullName.trim().length < 2) e.fullName = 'Ad soyad en az 2 karakter olmalı';
  if (!EMAIL_RE.test(d.email.trim())) e.email = 'Geçerli bir e-posta adresi girin';
  if (!d.role) e.role = 'Rol seçin';
  if (!d.startDate) e.startDate = 'Başlangıç tarihi seçin';
  if (d.endDate && d.startDate && d.endDate < d.startDate) e.endDate = 'Bitiş, başlangıçtan önce olamaz';
  return e;
}

export function endReasonError(reason: string): string | undefined {
  const n = reason.trim().length;
  if (n < 5) return 'Gerekçe en az 5 karakter olmalı';
  if (n > 300) return 'Gerekçe en fazla 300 karakter olabilir';
  return undefined;
}
