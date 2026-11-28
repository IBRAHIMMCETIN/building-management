import { z } from 'zod';

/*
 * Duyuru veri modeli: semalar, tipler ve saf yardimcilar. API istemcisine (ve dolayisiyla
 * ortam yapilandirmasina) bagimli DEGILDIR; testler ve formlar buradan import eder.
 * Web uclari icin bkz. apps/web/src/lib/api/announcements.ts.
 *
 * Duyurular (apps/api/src/modules/announcements + portal).
 *   Yonetici:  GET  /api/announcements?status=draft|published|archived|all
 *              POST /api/announcements                 -> taslak
 *              PATCH /api/announcements/:id            { version, ... } (yalnizca taslak)
 *              POST /api/announcements/:id/approve     { version } -> yayinda
 *              POST /api/announcements/:id/archive     { version }
 *   Sakin:     GET  /api/portal/announcements?unitId   (yalnizca yayin penceresindekiler)
 * Yayinlanan duyuru degistirilemez; duzeltme icin arsivlenip yenisi olusturulur.
 */

export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];
export type AnnouncementStatusFilter = AnnouncementStatus | 'all';

export const announcementSchema = z.object({
  announcementId: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(ANNOUNCEMENT_STATUSES),
  blockIds: z.array(z.string()).optional(),
  publishAt: z.string(),
  expiresAt: z.string().optional(),
  approvedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});

export const portalAnnouncementSchema = z.object({
  announcementId: z.string(),
  title: z.string(),
  body: z.string(),
  publishAt: z.string(),
  expiresAt: z.string().optional(),
});

export type Announcement = z.infer<typeof announcementSchema>;
export type PortalAnnouncement = z.infer<typeof portalAnnouncementSchema>;

/** Olusturma: bos alanlar gonderilmez (publishAt yoksa onay ani yayin zamani olur). */
export type CreateAnnouncementInput = {
  title: string;
  body: string;
  blockIds?: string[];
  publishAt?: string;
  expiresAt?: string;
};

/** Guncelleme: `null` alani temizler (blockIds -> tum apartman, expiresAt -> suresiz). */
export type UpdateAnnouncementInput = {
  version: number;
  title: string;
  body: string;
  blockIds: string[] | null;
  publishAt: string;
  expiresAt: string | null;
};

/** Ekranda gosterilen durum: yayindaki duyurunun zamanlamasi da hesaba katilir. */
export type AnnouncementDisplayStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'archived';

export function displayStatus(a: Pick<Announcement, 'status' | 'publishAt' | 'expiresAt'>, now: Date = new Date()): AnnouncementDisplayStatus {
  if (a.status !== 'published') return a.status;
  const t = now.getTime();
  if (Date.parse(a.publishAt) > t) return 'scheduled';
  if (a.expiresAt && Date.parse(a.expiresAt) <= t) return 'expired';
  return 'published';
}

export const DISPLAY_STATUS_LABELS: Record<AnnouncementDisplayStatus, string> = {
  draft: 'Taslak',
  scheduled: 'Planlandı',
  published: 'Yayında',
  expired: 'Süresi doldu',
  archived: 'Arşivlendi',
};
