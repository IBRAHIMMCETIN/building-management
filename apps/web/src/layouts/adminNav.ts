import { Building, CreditCard, FileUp, LayoutDashboard, Megaphone, ScrollText, Settings, ShieldCheck, UserCog, Users, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';
import { AUDIT_ROLES, type Role, SECURITY_ROLES, isPlatformRole } from '@/types/roles';

export type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  /** Verilirse yalnizca bu rollere gorunur (yetki kontrolu yine API'de). */
  roles?: readonly Role[];
};

/** Apartmana ozel yonetim menusu (aktif apartman baglami gerektirir). */
export const APARTMENT_NAV: readonly NavItem[] = [
  { to: '/admin', label: 'Genel Bakış', icon: LayoutDashboard, end: true },
  { to: '/admin/units', label: 'Daireler', icon: Users },
  { to: '/admin/finance', label: 'Finans', icon: Wallet },
  { to: '/admin/announcements', label: 'Duyurular', icon: Megaphone },
  { to: '/admin/import', label: 'Toplu Aktarım', icon: FileUp },
  { to: '/admin/settings', label: 'Ayarlar', icon: Settings },
  { to: '/admin/audit', label: 'Denetim Günlüğü', icon: ScrollText, roles: AUDIT_ROLES },
  { to: '/admin/security', label: 'Güvenlik', icon: ShieldCheck, roles: SECURITY_ROLES },
];

/** Platform geneli menu: apartman ici ekran yoktur (API de platform rolune apartman verisi acmaz). */
export const PLATFORM_NAV: readonly NavItem[] = [
  { to: '/admin/apartments', label: 'Apartmanlar', icon: Building },
  { to: '/admin/payments', label: 'Ödeme Hesapları', icon: CreditCard },
  { to: '/admin/users', label: 'Kullanıcılar', icon: UserCog },
  { to: '/admin/audit', label: 'Denetim Günlüğü', icon: ScrollText },
];

export function navItemsFor(role: Role | undefined): readonly NavItem[] {
  const items = isPlatformRole(role) ? PLATFORM_NAV : APARTMENT_NAV;
  return items.filter((i) => !i.roles || (!!role && i.roles.includes(role)));
}

export function panelTitleFor(role: Role | undefined): string {
  return isPlatformRole(role) ? 'Platform Yönetimi' : 'Yönetim Paneli';
}
