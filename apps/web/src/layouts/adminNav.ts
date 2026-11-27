import { ArrowLeftRight, Briefcase, Building, CalendarDays, ClipboardPen, Contact, CreditCard, DoorOpen, FileText, FileUp, Gauge, Landmark, LayoutDashboard, ListChecks, Megaphone, Scale, ScrollText, Settings, ShieldCheck, Tag, UserCog, Users, Vote, Wallet, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';
import { AUDIT_ROLES, EQUIPMENT_ROLES, GATE_ROLES, METER_READING_ROLES, METER_ROLES, MY_TASKS_ROLES, OFFICE_ROLES, PORTFOLIO_ROLES, type Role, SECURITY_ROLES, TEAM_ROLES, TICKET_ROLES, isPlatformRole } from '@/types/roles';

export type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  /** Verilirse yalnizca bu rollere gorunur (yetki kontrolu yine API'de). */
  roles?: readonly Role[];
  /** Sakin menusu: yalnizca aktif apartmanda malik uyeligi olana gorunur (yetki kontrolu yine API'de). */
  ownersOnly?: boolean;
  /**
   * Yonetim portfoyu: yalnizca en az iki apartmanda yonetici / yonetim firmasi / denetci olana
   * gorunur (`usePortfolioAccess`; yetki kontrolu yine API'de).
   */
  portfolioOnly?: boolean;
};

/** Apartmana ozel yonetim menusu (aktif apartman baglami gerektirir). */
export const APARTMENT_NAV: readonly NavItem[] = [
  // Apartmanlar arasi ozet: tek apartmanin menusunden once.
  { to: '/admin/portfolio', label: 'Portföy', icon: Briefcase, roles: PORTFOLIO_ROLES, portfolioOnly: true },
  { to: '/admin', label: 'Genel Bakış', icon: LayoutDashboard, end: true },
  { to: '/admin/my-tasks', label: 'İşlerim', icon: ListChecks, roles: MY_TASKS_ROLES },
  { to: '/admin/gate', label: 'Güvenlik Kapısı', icon: DoorOpen, roles: GATE_ROLES },
  { to: '/admin/units', label: 'Daireler', icon: Users, roles: OFFICE_ROLES },
  { to: '/admin/finance', label: 'Finans', icon: Wallet, roles: OFFICE_ROLES },
  { to: '/admin/tickets', label: 'Arıza & Bakım', icon: Wrench, roles: TICKET_ROLES },
  { to: '/admin/equipment', label: 'Ekipman', icon: Tag, roles: EQUIPMENT_ROLES },
  { to: '/admin/reservations', label: 'Rezervasyonlar', icon: CalendarDays, roles: OFFICE_ROLES },
  { to: '/admin/tenders', label: 'İhaleler', icon: Scale, roles: OFFICE_ROLES },
  { to: '/admin/meters', label: 'Sayaç Dağıtımı', icon: Gauge, roles: METER_ROLES },
  { to: '/admin/meter-readings', label: 'Sayaç Okuma', icon: ClipboardPen, roles: METER_READING_ROLES },
  { to: '/admin/team', label: 'Ekip', icon: Contact, roles: TEAM_ROLES },
  { to: '/admin/announcements', label: 'Duyurular', icon: Megaphone, roles: OFFICE_ROLES },
  { to: '/admin/polls', label: 'Oylamalar', icon: Vote, roles: OFFICE_ROLES },
  { to: '/admin/assemblies', label: 'Genel Kurul', icon: Landmark, roles: OFFICE_ROLES },
  { to: '/admin/import', label: 'Toplu Aktarım', icon: FileUp, roles: OFFICE_ROLES },
  { to: '/admin/settings', label: 'Ayarlar', icon: Settings, roles: OFFICE_ROLES },
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

/**
 * Rol menusu. `roles` verilmeyen oge yalnizca Genel Bakis'tir (tum apartman rolleri); diger
 * her oge acik rol listesi tasir, boylece yeni eklenen bir ekran varsayilan olarak bina gorevlisi /
 * guvenlige acilmaz (router'daki `RequireRole` ayni listeleri kullanir).
 */
export function navItemsFor(role: Role | undefined, portfolio = false): readonly NavItem[] {
  const items = isPlatformRole(role) ? PLATFORM_NAV : APARTMENT_NAV;
  return items.filter((i) => (!i.roles || (!!role && i.roles.includes(role))) && (!i.portfolioOnly || portfolio));
}

export function panelTitleFor(role: Role | undefined): string {
  return isPlatformRole(role) ? 'Platform Yönetimi' : 'Yönetim Paneli';
}
