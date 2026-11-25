import { ArrowLeftRight, Building, ClipboardPen, Contact, CreditCard, Gauge, FileText, FileUp, LayoutDashboard, ListChecks, Megaphone, ScrollText, Settings, ShieldCheck, UserCog, Users, Wallet, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';
import { AUDIT_ROLES, METER_READING_ROLES, METER_ROLES, MY_TASKS_ROLES, type Role, SECURITY_ROLES, TEAM_ROLES, TICKET_ROLES, isPlatformRole } from '@/types/roles';

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
  { to: '/admin/my-tasks', label: 'İşlerim', icon: ListChecks, roles: MY_TASKS_ROLES },
  { to: '/admin/units', label: 'Daireler', icon: Users },
  { to: '/admin/finance', label: 'Finans', icon: Wallet },
  { to: '/admin/tickets', label: 'Arıza & Bakım', icon: Wrench, roles: TICKET_ROLES },
  { to: '/admin/meters', label: 'Sayaç Dağıtımı', icon: Gauge, roles: METER_ROLES },
  { to: '/admin/meter-readings', label: 'Sayaç Okuma', icon: ClipboardPen, roles: METER_READING_ROLES },
  { to: '/admin/team', label: 'Ekip', icon: Contact, roles: TEAM_ROLES },
  { to: '/admin/announcements', label: 'Duyurular', icon: Megaphone },
  { to: '/admin/import', label: 'Toplu Aktarım', icon: FileUp },
  { to: '/admin/settings', label: 'Ayarlar', icon: Settings },
  { to: '/admin/audit', label: 'Denetim Günlüğü', icon: ScrollText, roles: AUDIT_ROLES },
  { to: '/admin/security', label: 'Güvenlik', icon: ShieldCheck, roles: SECURITY_ROLES },
];

/** Platform geneli menu: apartman ici ekran yoktur (API de platform rolune apartman verisi acmaz). */
export const PLATFORM_NAV: readonly NavItem[] = [
  { to: '/admin/apartments', label: 'Apartmanlar', icon: Building },
  { to: '/admin/payments', label: 'Ödeme Hesapları', icon: CreditCard, end: true },
  { to: '/admin/payments/transfers', label: 'Aktarımlar', icon: ArrowLeftRight },
  { to: '/admin/payments/invoices', label: 'Komisyon Faturaları', icon: FileText },
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
