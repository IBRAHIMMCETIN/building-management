import { CalendarDays, DoorOpen, Gauge, Home, Megaphone, Receipt, Scale, Vote, Wrench } from 'lucide-react';
import type { NavItem } from './adminNav';

/**
 * Sakin portali menusu. Ilk PRIMARY_TABS oge alt sekme cubugunda; kalanlar "Diğer"
 * cekmecesinde (dar telefonda sekmeler sigsin, etiketler okunur kalsin).
 */
export const RESIDENT_NAV: readonly NavItem[] = [
  { to: '/app', label: 'Ana Sayfa', icon: Home, end: true },
  { to: '/app/dues', label: 'Borçlarım', icon: Receipt },
  { to: '/app/talepler', label: 'Talepler', icon: Wrench },
  { to: '/app/announcements', label: 'Duyurular', icon: Megaphone },
  { to: '/app/ziyaretci', label: 'Ziyaretçi', icon: DoorOpen },
  { to: '/app/rezervasyon', label: 'Rezervasyon', icon: CalendarDays },
  { to: '/app/oylamalar', label: 'Oylamalar', icon: Vote },
  { to: '/app/tuketim', label: 'Tüketimim', icon: Gauge },
  { to: '/app/ihale', label: 'İhaleler', icon: Scale },
];

export const PRIMARY_TABS = 4;

export function splitResidentNav(items: readonly NavItem[] = RESIDENT_NAV, primaryCount = PRIMARY_TABS) {
  // Tek bir oge cekmeceye kalacaksa cekmece yerine onu da cubukta goster.
  const count = items.length - primaryCount <= 1 ? items.length : primaryCount;
  return { primary: items.slice(0, count), more: items.slice(count) };
}

/** "Diğer" sekmesi, cekmecedeki sayfalardan biri (veya alt sayfasi) aciksa aktif gorunur. */
export function isMoreActive(pathname: string, more: readonly NavItem[]): boolean {
  return more.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`));
}
