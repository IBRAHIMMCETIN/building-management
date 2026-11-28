import { z } from 'zod';
import { ROLE_LABELS, isRole } from '../roles';
import { EVENT_LABELS, STATUS_LABELS, type TicketCategory } from '../tickets/model';
import { type TicketEvent, type photoUploadSchema, ticketEventSchema, ticketSchema } from './tickets';

/*
 * Sakin portali ariza / talep - /api/portal/tickets (yalnizca `resident`; apps/api/src/modules/tickets/portalRoutes.ts):
 * actigim + dairemin talepleri, yalnizca herkese acik olaylar; onay (1-5 puan), yeniden acma, geri cekme,
 * yorum ve fotograf. Olay / ayrinti / benzer talep / yukleme semalari ./tickets.ts'te (web ayni
 * dosyayi kullanir); burada sakin istek / yanit tipleri, fotograf ve form kurallari, gosterim
 * yardimcilari. Fotograf kurallari API ile ayni (apps/api/src/modules/meters/common.ts, tickets/photos.ts).
 */

/** Imzali S3 yukleme linki: dosya API'den gecmez, `uploadUrl`'e PUT edilir; olaya `uploadId` verilir. */
export type PhotoUpload = z.infer<typeof photoUploadSchema>;

export const createdTicketSchema = z.object({ ticket: ticketSchema, replayed: z.boolean() });
export const ticketOneSchema = z.object({ ticket: ticketSchema });
export const ticketCommentResultSchema = z.object({ event: ticketEventSchema });

export type PortalCreateTicketInput = {
  idempotencyKey: string;
  title: string;
  description: string;
  category: TicketCategory;
  location: { kind: 'unit'; unitId: string } | { kind: 'common'; area: string };
  photos?: string[];
};

// --- Fotograflar ---------------------------------------------------------

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** API siniri: olay (talep / yorum) basina en fazla 6 fotograf. */
export const MAX_PHOTOS_PER_EVENT = 6;

/** Tur ve boyut kontrolu (web PhotoPicker ile ayni metinler); gecerliyse null. */
export function photoError(file: { type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return 'Fotoğraf JPEG, PNG, WEBP veya HEIC olmalı.';
  if (file.size <= 0) return 'Dosya boş.';
  if (file.size > MAX_PHOTO_BYTES) return 'Fotoğraf en fazla 10 MB olabilir.';
  return null;
}

// --- Gosterim ------------------------------------------------------------

/** Zaman cizelgesi satir basligi (web TicketTimeline `titleOf`). */
export function ticketEventTitle(e: Pick<TicketEvent, 'kind' | 'from' | 'to' | 'assigneeId'>): string {
  if (e.kind === 'status_changed' && e.to) return `${e.from ? `${STATUS_LABELS[e.from]} → ` : ''}${STATUS_LABELS[e.to]}`;
  if (e.kind === 'assigned') return e.assigneeId === undefined ? 'Atama kaldırıldı' : 'Görevli atandı';
  return EVENT_LABELS[e.kind] ?? e.kind;
}

/** Olayi kim yazdi: kendisi "Siz", digerleri rol adi (sakin gorunumunde kisi adi yoktur). */
export function ticketEventAuthor(e: Pick<TicketEvent, 'mine' | 'byRole'>): string | undefined {
  if (e.mine) return 'Siz';
  return e.byRole && isRole(e.byRole) ? ROLE_LABELS[e.byRole] : undefined;
}

// --- Form kurallari (sakin) -----------------------------------------------

/** Yeni talep: baslik 3-120, aciklama 1-4000; ortak alan adi 2-80 karakter (API ile ayni sinirlar). */
export const newTicketTextSchema = z.object({
  title: z.string().trim().min(3, 'Başlık en az 3 karakter olmalı.').max(120, 'Başlık en fazla 120 karakter olabilir.'),
  description: z.string().trim().min(1, 'Sorunu kısaca anlatın.').max(4000, 'Açıklama en fazla 4000 karakter olabilir.'),
});
export const commonAreaSchema = z.string().trim().min(2, 'Alanı yazın (en az 2 karakter).').max(80, 'Alan en fazla 80 karakter olabilir.');
/** Talebe mesaj (yorum): 1-2000 karakter. */
export const ticketCommentSchema = z.string().trim().min(1, 'Mesajınızı yazın.').max(2000, 'Mesaj en fazla 2000 karakter olabilir.');
/** Yeniden acma gerekcesi (web: en az 3 karakter yazilmadan dugme kapali). */
export const reopenNoteSchema = z.string().trim().min(3, 'Sorunun neden devam ettiğini yazın (en az 3 karakter).').max(2000, 'Not en fazla 2000 karakter olabilir.');
