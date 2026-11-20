import { Building, CreditCard, FileUp, LayoutDashboard, Megaphone, Settings, Users, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';
import { type Role, isPlatformRole } from '@/types/roles';

export type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
};

/** Apartmana ozel yonetim menusu (aktif apartman baglami gerektirir). */
export const APARTMENT_NAV: readonly NavItem[] = [
  { to: '/admin', label: 'Genel Bakış', icon: LayoutDashboard, end: true },
  { to: '/admin/units', label: 'Daireler', icon: Users },
  { to: '/admin/finance', label: 'Finans', icon: Wallet },
  { to: '/admin/announcements', label: 'Duyurular', icon: Megaphone },
  { to: '/admin/import', label: 'Toplu Aktarım', icon: FileUp },
  { to: '/admin/settings', label: 'Ayarlar', icon: Settings },
];

/** Platform geneli menu: apartman ici ekran yoktur (API de platform rolune apartman verisi acmaz). */
export const PLATFORM_NAV: readonly NavItem[] = [
  { to: '/admin/apartments', label: 'Apartmanlar', icon: Building },
  { to: '/admin/payments', label: 'Ödeme Hesapları', icon: CreditCard },
];

export function navItemsFor(role: Role | undefined): readonly NavItem[] {
  return isPlatformRole(role) ? PLATFORM_NAV : APARTMENT_NAV;
}

export function panelTitleFor(role: Role | undefined): string {
  return isPlatformRole(role) ? 'Platform Yönetimi' : 'Yönetim Paneli';
}
