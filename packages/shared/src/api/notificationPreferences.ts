import { z } from 'zod';

/**
 * GET|PUT /api/me/notification-preferences (kayit yoksa varsayilan: e-posta ve mobil bildirim acik). Rol claim'i gerektirmez.
 * Kategori bazli e-posta (API ile ayni kimlikler: apps/api/src/modules/notifications/categories.ts):
 * yalnizca acikca secilen kategori doner, verilmeyen ACIK sayilir; ana anahtar kapaliysa hicbiri gitmez.
 * PUT yalnizca DEGISEN alani gonderir (ana anahtar dahil istege bagli): sunucu okumadan yalnizca o
 * alani yazar, iki cihaz / eski sekme birbirinin secimini ezmez.
 * Semalar ve etiketler web + mobil ortak; uclar: apps/web/src/lib/api/notificationPreferences.ts.
 */
export const NOTIFICATION_CATEGORIES = ['finance', 'announcements', 'tickets', 'gate', 'reservations', 'polls', 'assemblies', 'tenders'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Yalnizca yonetim rollerine (yonetici, yonetim firmasi) giden kategoriler: abonelik / lisans
 * bildirimleri. Sakin ve saha ekranlari (mobil dahil) `NOTIFICATION_CATEGORIES` listesini gosterir.
 */
export const MANAGEMENT_NOTIFICATION_CATEGORIES = ['billing'] as const;
export type ManagementNotificationCategory = (typeof MANAGEMENT_NOTIFICATION_CATEGORIES)[number];
export type AnyNotificationCategory = NotificationCategory | ManagementNotificationCategory;

const optionalFlag = z.boolean().optional();

const channelSchema = z.object({
  enabled: z.boolean(),
  finance: optionalFlag,
  announcements: optionalFlag,
  tickets: optionalFlag,
  gate: optionalFlag,
  reservations: optionalFlag,
  polls: optionalFlag,
  assemblies: optionalFlag,
  tenders: optionalFlag,
  billing: optionalFlag,
});

/** Kanallar: e-posta ve mobil bildirim (Expo push). Birbirinden bagimsiz; ayni kategoriler. */
export type NotificationChannel = 'email' | 'push';

export const notificationPreferencesSchema = z.object({
  email: channelSchema,
  /** Mobil bildirim tercihi (push altyapisindan once yazilmis API yanitinda yok: varsayilan acik). */
  push: channelSchema.optional(),
  updatedAt: z.string().optional(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type ChannelPreferencesInput = { enabled?: boolean } & Partial<Record<AnyNotificationCategory, boolean>>;
/** PUT govdesi: yalnizca degisen alan (en az bir alan; `email` ve/veya `push`). */
export type NotificationPreferencesInput = { email?: ChannelPreferencesInput; push?: ChannelPreferencesInput };

/** Kanalin ana anahtari: kayitli tercih yoksa acik. */
export const channelEnabled = (p: NotificationPreferences, channel: NotificationChannel = 'email') => p[channel]?.enabled !== false;

/** Kategori bildirimleri (varsayilan e-posta): kayitli tercih yoksa acik. */
export const categoryEnabled = (p: NotificationPreferences, category: AnyNotificationCategory, channel: NotificationChannel = 'email') =>
  p[channel]?.[category] !== false;

/** Ariza e-postalari: kayitli tercih yoksa acik. */
export const ticketEmailsEnabled = (p: NotificationPreferences) => categoryEnabled(p, 'tickets');

/** Hesabim ekranindaki kategori satirlari (Turkce etiket + aciklama). */
export const NOTIFICATION_CATEGORY_META: Record<AnyNotificationCategory, { label: string; description: string }> = {
  finance: { label: 'Aidat ve tahsilat', description: 'Tahakkuk, toplu aidat özeti, tahsilat makbuzu, gecikme tazminatı ve ödeme hatırlatmaları.' },
  announcements: { label: 'Duyurular', description: 'Yönetimin yayınladığı duyurular.' },
  tickets: { label: 'Arıza ve talepler', description: 'Arıza / talep açılması, atanması, çözülmesi ve yorum bildirimleri ile günlük operasyon özeti.' },
  gate: { label: 'Ziyaretçi ve kurye', description: 'Kapıdaki kurye için onay isteği ve misafir geçişinizle yapılan girişler. Ziyaretçi ekranı açıkken kurye istekleri ayrıca kendiliğinden yenilenir.' },
  reservations: { label: 'Rezervasyon', description: 'Ortak alan rezervasyonunuzun onaylanması, reddedilmesi ve yönetim tarafından iptali (ücret iadesi dahil).' },
  polls: { label: 'Anket ve oylama', description: 'Yönetimin başlattığı yeni anket ve oylamalar.' },
  assemblies: {
    label: 'Genel kurul',
    description: 'Kat malikleri kurulu toplantı çağrıları (kat maliklerine). Bilgilendirme amaçlıdır; yasal çağrı yönetiminizce ayrıca yapılır.',
  },
  tenders: { label: 'İhale ve teklifler', description: 'Yönetimin teklifleri sakinlerle paylaşması, ihalenin karara bağlanması veya iptali ve ihaleye yazdığınız soruların yanıtlanması.' },
  billing: { label: 'Abonelik ve faturalar', description: 'Deneme süresinin bitmesi, abonelik faturası, geciken ödeme, askıya alma ve yeniden açılma. Yalnızca yönetime gönderilir.' },
};
