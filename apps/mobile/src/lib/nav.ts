import { CalendarDays, DoorOpen, Gauge, Landmark, type LucideIcon, Scale, Vote, Wrench } from '@/components/icons';

/*
 * Mobilde henuz olmayan (M2/M3) ekranlar ve web'deki karsiliklari. Sakin "Diğer" listesi web
 * menusuyle ayni sirada ve ayni kuralla (Genel Kurul yalnizca maliklere): apps/web/src/layouts/residentNav.ts.
 * Mekanik tasinamadi (web dosyasi lucide-react ikonlari ve web NavItem tipini kullanir).
 */
export type WebFeature = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Web uygulamasindaki yol (EXPO_PUBLIC_WEB_URL'e eklenir). */
  webPath: string;
  description: string;
  ownersOnly?: boolean;
};

export const TICKETS_FEATURE: WebFeature = {
  key: 'talepler',
  label: 'Talepler',
  icon: Wrench,
  webPath: '/app/talepler',
  description: 'Arıza / talep bildirme, taleplerinizi izleme ve çözülen talebi onaylama.',
};

export const RESIDENT_MORE: readonly WebFeature[] = [
  { key: 'ziyaretci', label: 'Ziyaretçi', icon: DoorOpen, webPath: '/app/ziyaretci', description: 'Misafir geçişi oluşturma ve kapıdaki kurye için onay.' },
  { key: 'rezervasyon', label: 'Rezervasyon', icon: CalendarDays, webPath: '/app/rezervasyon', description: 'Ortak alan (salon, havuz, spor alanı) rezervasyonu.' },
  { key: 'oylamalar', label: 'Oylamalar', icon: Vote, webPath: '/app/oylamalar', description: 'Yönetimin başlattığı anket ve oylamalar.' },
  { key: 'genel-kurul', label: 'Genel Kurul', icon: Landmark, webPath: '/app/genel-kurul', description: 'Kat malikleri kurulu toplantıları ve gündem.', ownersOnly: true },
  { key: 'tuketim', label: 'Tüketimim', icon: Gauge, webPath: '/app/tuketim', description: 'Sayaç okumaları ve tüketim payınız.' },
  { key: 'ihale', label: 'İhaleler', icon: Scale, webPath: '/app/ihale', description: 'Yönetimin sakinlerle paylaştığı teklifler ve ihaleler.' },
];

/** Kullaniciya gorunen ogeler: malik degilse maliklere ozel ogeler (Genel Kurul) cikar. */
export const residentMoreFor = (isOwner: boolean, items: readonly WebFeature[] = RESIDENT_MORE) => items.filter((n) => !n.ownersOnly || isOwner);

/** Online odeme: web odeme sayfasi uygulama ici tarayicida (kart bilgisi uygulamaya girmez). */
export const PAYMENT_WEB_PATH = '/app/odeme';
