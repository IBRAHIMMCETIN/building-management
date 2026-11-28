import type { FeatureKey } from '@bm/shared/features/catalog';
import { CalendarDays, DoorOpen, Gauge, Landmark, type LucideIcon, Scale, Vote } from '@/components/icons';

/*
 * "Diğer" ozellikleri ve web'deki karsiliklari; mobilde yerel ekrani olanlar `route` tasir (M2a:
 * Ziyaretçi, Rezervasyon; M2b: Oylamalar, Genel Kurul, Tüketimim, İhaleler), digerleri yer tutucuya
 * gider. Sakin "Diğer" listesi web menusuyle ayni sirada ve ayni kuralla (Genel Kurul yalnizca
 * maliklere): apps/web/src/layouts/residentNav.ts.
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
  /**
   * Adim 1: yalnizca bu site ozelligi acikken (GET /api/site-features). Kapaliysa "Diğer"de gorunmez;
   * ekranina (bildirim / derin baglanti) gelinirse "Bu özellik sitenizde kapalı" notu (ResidentRouteGate).
   * Modul anahtarlari: Genel Kurul `admin.assemblies`, İhaleler `admin.tenders` (web menusuyle ayni).
   * Oylamalar icin katalogda anahtar yok (her zaman acik).
   */
  feature?: FeatureKey;
  /** Mobildeki yerel ekran; yoksa "Diğer" yer tutucuyu (web'de ac) acar. */
  route?: '/resident/gate' | '/resident/reservations' | '/resident/polls' | '/resident/assemblies' | '/resident/consumption' | '/resident/tenders';
};

export const RESIDENT_MORE: readonly WebFeature[] = [
  { key: 'ziyaretci', label: 'Ziyaretçi', icon: DoorOpen, webPath: '/app/ziyaretci', description: 'Misafir geçişi oluşturma ve kapıdaki kurye için onay.', route: '/resident/gate' },
  { key: 'rezervasyon', label: 'Rezervasyon', icon: CalendarDays, webPath: '/app/rezervasyon', description: 'Ortak alan (salon, havuz, spor alanı) rezervasyonu.', route: '/resident/reservations' },
  { key: 'oylamalar', label: 'Oylamalar', icon: Vote, webPath: '/app/oylamalar', description: 'Yönetimin başlattığı anket ve oylamalar.', route: '/resident/polls' },
  { key: 'genel-kurul', label: 'Genel Kurul', icon: Landmark, webPath: '/app/genel-kurul', description: 'Kat malikleri kurulu toplantıları ve gündem.', ownersOnly: true, feature: 'admin.assemblies', route: '/resident/assemblies' },
  { key: 'tuketim', label: 'Tüketimim', icon: Gauge, webPath: '/app/tuketim', description: 'Sayaç okumaları ve tüketim payınız.', route: '/resident/consumption' },
  { key: 'ihale', label: 'İhaleler', icon: Scale, webPath: '/app/ihale', description: 'Yönetimin sakinlerle paylaştığı teklifler ve ihaleler.', feature: 'admin.tenders', route: '/resident/tenders' },
];

/**
 * Kullaniciya gorunen ogeler: malik degilse maliklere ozel ogeler (Genel Kurul), site ozelligi
 * kapaliysa o ozellige bagli ogeler cikar.
 */
export const residentMoreFor = (isOwner: boolean, items: readonly WebFeature[] = RESIDENT_MORE, isEnabled: (key: FeatureKey) => boolean = () => true) =>
  items.filter((n) => (!n.ownersOnly || isOwner) && (!n.feature || isEnabled(n.feature)));

/**
 * Sakin yiginindaki bir ekranin bagli oldugu "Diğer" ogesi (ozellik kapisi icin): yerel ekran yolu
 * (`polls/[id]` -> `/resident/polls`) veya web yer tutucusu (`web/[feature]`, `feature` parametresi).
 */
export function moreItemForRoute(routeName: string, params: object | undefined, items: readonly WebFeature[] = RESIDENT_MORE): WebFeature | undefined {
  if (routeName === 'web/[feature]') return items.find((i) => i.key === (params as { feature?: unknown } | undefined)?.feature);
  const path = `/resident/${routeName.replace(/\/index$/, '')}`;
  return items.find((i) => i.route && (path === i.route || path.startsWith(`${i.route}/`)));
}

/** Online odeme: web odeme sayfasi uygulama ici tarayicida (kart bilgisi uygulamaya girmez). */
export const PAYMENT_WEB_PATH = '/app/odeme';
