import { z } from 'zod';
import { apiClient } from './client';

/**
 * GET|PUT /api/me/notification-preferences (kayit yoksa varsayilan: e-posta acik). Rol claim'i gerektirmez.
 * Kategori bazli e-posta (API ile ayni kimlikler: apps/api/src/modules/notifications/categories.ts):
 * yalnizca acikca secilen kategori doner, verilmeyen ACIK sayilir; ana anahtar kapaliysa hicbiri gitmez.
 * PUT yalnizca degisen kategoriyi gonderebilir: sunucu digerlerinde onceki secimi korur.
 */
export const NOTIFICATION_CATEGORIES = ['finance', 'announcements', 'tickets', 'gate', 'reservations', 'polls'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const optionalFlag = z.boolean().optional();

export const notificationPreferencesSchema = z.object({
  email: z.object({
    enabled: z.boolean(),
    finance: optionalFlag,
    announcements: optionalFlag,
    tickets: optionalFlag,
    gate: optionalFlag,
    reservations: optionalFlag,
    polls: optionalFlag,
  }),
  updatedAt: z.string().optional(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
/** PUT govdesi: ana anahtar zorunlu, kategoriler istege bagli. */
export type NotificationPreferencesInput = { email: { enabled: boolean } & Partial<Record<NotificationCategory, boolean>> };

/** Kategori e-postalari: kayitli tercih yoksa acik. */
export const categoryEnabled = (p: NotificationPreferences, category: NotificationCategory) => p.email[category] !== false;

/** Ariza e-postalari: kayitli tercih yoksa acik. */
export const ticketEmailsEnabled = (p: NotificationPreferences) => categoryEnabled(p, 'tickets');

/** Hesabim ekranindaki kategori satirlari (Turkce etiket + aciklama). */
export const NOTIFICATION_CATEGORY_META: Record<NotificationCategory, { label: string; description: string }> = {
  finance: { label: 'Aidat ve tahsilat', description: 'Tahakkuk, toplu aidat özeti, tahsilat makbuzu, gecikme tazminatı ve ödeme hatırlatmaları.' },
  announcements: { label: 'Duyurular', description: 'Yönetimin yayınladığı duyurular.' },
  tickets: { label: 'Arıza ve talepler', description: 'Arıza / talep açılması, atanması, çözülmesi ve yorum bildirimleri ile günlük operasyon özeti.' },
  gate: { label: 'Ziyaretçi ve kurye', description: 'Kapıdaki kurye için onay isteği ve misafir geçişinizle yapılan girişler. Ziyaretçi ekranı açıkken kurye istekleri ayrıca kendiliğinden yenilenir.' },
  reservations: { label: 'Rezervasyon', description: 'Ortak alan rezervasyonunuzun onaylanması, reddedilmesi ve yönetim tarafından iptali (ücret iadesi dahil).' },
  polls: { label: 'Anket ve oylama', description: 'Yeni anket / oylama ve sonuç bildirimleri.' },
};

export const notificationPreferencesApi = {
  get: (signal?: AbortSignal) => apiClient.get('/api/me/notification-preferences', { signal, schema: notificationPreferencesSchema }),
  put: (prefs: NotificationPreferencesInput) => apiClient.put('/api/me/notification-preferences', prefs, { schema: notificationPreferencesSchema }),
};
