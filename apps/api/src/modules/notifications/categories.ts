/**
 * Bildirim kategorileri: kullanici e-posta tercihlerini kategori bazinda kapatabilir
 * (`/api/me/notification-preferences`, `email.<kategori>: false`). Web'deki liste ayni kimlikleri
 * kullanir (apps/web/src/lib/api/notificationPreferences.ts).
 *
 *   finance        aidat / tahsilat: tahakkuk, toplu ozet, geri alma, makbuz, gecikme tazminati, hatirlatma
 *   announcements  duyurular
 *   tickets        ariza / talep ve gunluk operasyon ozeti
 *   gate           ziyaretci / kurye (kurye onay istegi, misafir girisi)
 *   reservations   ortak alan rezervasyonu (onay, ret, yonetim iptali)
 *   polls          anket / oylama
 *   assemblies     genel kurul (kat malikleri kurulu toplanti cagrisi). Anketten ayri: anket
 *                  e-postalarini kapatan malik toplanti cagrisini almaya devam edebilmeli (ve tersi).
 *   tenders        ihale / teklif toplama: sakinlerle paylasim, karar, yayindan sonra iptal ve sakinin
 *                  sorusuna yonetim yaniti. Duyurulardan ayri: ihale ortak gider kararidir (seffaflik);
 *                  duyurulari kapatan sakin ihale e-postalarini almaya devam edebilmeli (ve tersi).
 *
 * Kategori once olay turunden (worker), yoksa sablon adindan cozulur. Yeni olay / sablon, ait
 * oldugu kategorinin on ekiyle adlandirilmalidir; kategorisi cozulemeyen bildirim yalnizca ana
 * anahtara (`email.enabled`) tabidir.
 */
export const NOTIFICATION_CATEGORIES = ['finance', 'announcements', 'tickets', 'gate', 'reservations', 'polls', 'assemblies', 'tenders'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const EVENT_PREFIXES: [prefix: string, category: NotificationCategory][] = [
  ['DUE_', 'finance'],
  ['DUES_', 'finance'],
  ['PAYMENT_', 'finance'],
  ['LATE_FEE_', 'finance'],
  ['METER_PERIOD_', 'finance'],
  ['ANNOUNCEMENT_', 'announcements'],
  ['TICKET_', 'tickets'],
  ['OPERATIONS_DIGEST', 'tickets'],
  ['GATE_', 'gate'],
  ['RESERVATION_', 'reservations'],
  ['POLL_', 'polls'],
  ['ASSEMBLY_', 'assemblies'],
  ['TENDER_', 'tenders'],
];

const TEMPLATE_PREFIXES: [prefix: string, category: NotificationCategory][] = [
  ['due_', 'finance'],
  ['dues_', 'finance'],
  ['payment_', 'finance'],
  ['late_fee_', 'finance'],
  ['announcement_', 'announcements'],
  ['ticket_', 'tickets'],
  ['operations_digest', 'tickets'],
  ['gate_', 'gate'],
  ['reservation_', 'reservations'],
  ['poll_', 'polls'],
  ['assembly_', 'assemblies'],
  ['tender_', 'tenders'],
];

const byPrefix = (table: [string, NotificationCategory][], value: string) => table.find(([p]) => value.startsWith(p))?.[1];

export const categoryOfEvent = (eventType: string): NotificationCategory | undefined => byPrefix(EVENT_PREFIXES, eventType);
export const categoryOfTemplate = (template: string): NotificationCategory | undefined => byPrefix(TEMPLATE_PREFIXES, template);

export const isNotificationCategory = (v: string): v is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly string[]).includes(v);
