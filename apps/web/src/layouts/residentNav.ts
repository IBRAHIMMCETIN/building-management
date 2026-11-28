import { CalendarDays, DoorOpen, Gauge, Home, Landmark, Megaphone, Receipt, Scale, Vote, Wrench } from 'lucide-react';
import type { NavItem } from './adminNav';

/**
 * Sakin portali menusu. Ilk PRIMARY_TABS oge alt sekme cubugunda; kalanlar "Diğer"
 * cekmecesinde (dar telefonda sekmeler sigsin, etiketler okunur kalsin).
 *
 * Genel Kurul ayri oge (yonetim menusundeki Oylamalar / Genel Kurul ayrimi gibi): oylamalar daire
 * bazinda ve kiraciya da acik olabilir, genel kurul apartman geneli ve yalnizca kat maliklerine:
 * malik uyeligi olmayan kullanicida menude hic gorunmez (`ownersOnly`).
 */
export const RESIDENT_NAV: readonly NavItem[] = [
  { to: '/app', label: 'Ana Sayfa', icon: Home, end: true },
  { to: '/app/dues', label: 'Borçlarım', icon: Receipt },
  { to: '/app/talepler', label: 'Talepler', icon: Wrench },
  { to: '/app/announcements', label: 'Duyurular', icon: Megaphone },
  { to: '/app/ziyaretci', label: 'Ziyaretçi', icon: DoorOpen },
  { to: '/app/rezervasyon', label: 'Rezervasyon', icon: CalendarDays },
  { to: '/app/oylamalar', label: 'Oylamalar', icon: Vote },
  { to: '/app/genel-kurul', label: 'Genel Kurul', icon: Landmark, ownersOnly: true, feature: 'admin.assemblies' },
  { to: '/app/tuketim', label: 'Tüketimim', icon: Gauge },
  { to: '/app/ihale', label: 'İhaleler', icon: Scale, feature: 'admin.tenders' },
];

export const PRIMARY_TABS = 4;

/** Kullaniciya gorunen ogeler: malik degilse yalnizca maliklere ait ogeler (Genel Kurul) cikar. */
export const residentNavFor = (isOwner: boolean, items: readonly NavItem[] = RESIDENT_NAV) => items.filter((n) => !n.ownersOnly || isOwner);

export function splitResidentNav(items: readonly NavItem[] = RESIDENT_NAV, primaryCount = PRIMARY_TABS) {
  // Tek bir oge cekmeceye kalacaksa cekmece yerine onu da cubukta goster.
  const count = items.length - primaryCount <= 1 ? items.length : primaryCount;
  return { primary: items.slice(0, count), more: items.slice(count) };
}

/** "Diğer" sekmesi, cekmecedeki sayfalardan biri (veya alt sayfasi) aciksa aktif gorunur. */
export function isMoreActive(pathname: string, more: readonly NavItem[]): boolean {
  return more.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`));
}
