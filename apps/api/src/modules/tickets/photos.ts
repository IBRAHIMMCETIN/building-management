/**
 * Faz 3 (O1-2) - Talep fotograflari. Dosyalar private S3'te; istemci yalnizca kisa omurlu imzali
 * URL ile yukler / goruntuler.
 *
 *  1. Yukleme: `tmp/{apartmentId}/ticket-uploads/{userId}/{uploadId}.{ext}` (gecici; S3 yasam
 *     dongusu `tmp/` altini temizler). Anahtar kullaniciya baglidir: baskasinin yuklemesi
 *     iliştirilemez. `uploadId` = `<hex>_<ext>`.
 *  2. Iliştirme (talep olusturma, yorum, durum gecisi): gecici dosya varlik / boyut kontrolunden
 *     sonra `apartments/{apartmentId}/tickets/{ticketId}/{uploadId}.{ext}` altina kopyalanir; olay
 *     kalici anahtari tasir. Kopya defter yaziminden once yapilir; yazim basarisiz olursa sahipsiz
 *     kalir (zararsiz).
 *  3. Goruntuleme: fotografi tasiyan olay aktore gorunur olmali (ic nottaki fotografi sakin acamaz).
 */
import { randomBytes } from 'node:crypto';
import { ValidationError, asObject, reqInt } from '../core/validation.js';
import { contentDisposition, safeFileName } from '../documents/keys.js';
import { type DocumentStore, URL_TTL_SECONDS } from '../documents/store.js';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES, isPhotoContentType, photoContentTypeOf } from '../meters/common.js';
import { TicketError } from './errors.js';

/** Olay basina ve talep basina ust sinirlar. */
export const MAX_PHOTOS_PER_EVENT = 6;
export const MAX_PHOTOS_PER_TICKET = 30;

const UPLOAD_ID = /^[a-f0-9]{24}_(jpg|png|webp|heic)$/;

export const ticketPhotoKeys = {
  pending: (apartmentId: string, userId: string, uploadId: string) => `tmp/${apartmentId}/ticket-uploads/${userId}/${uploadId.replace('_', '.')}`,
  final: (apartmentId: string, ticketId: string, uploadId: string) => `apartments/${apartmentId}/tickets/${ticketId}/${uploadId.replace('_', '.')}`,
  prefix: (apartmentId: string, ticketId: string) => `apartments/${apartmentId}/tickets/${ticketId}/`,
};

/** Kalici anahtardan fotograf kimligi (`<hex>_<ext>`). */
export const photoIdOf = (key: string) => key.slice(key.lastIndexOf('/') + 1).replace('.', '_');

export function parseUploadIds(value: unknown, field = 'photos'): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} bir dizi olmalı`, field);
  if (value.length > MAX_PHOTOS_PER_EVENT) throw new ValidationError(`Tek seferde en fazla ${MAX_PHOTOS_PER_EVENT} fotoğraf eklenebilir`, field);
  const ids = value.map((v, i) => {
    if (typeof v !== 'string' || !UPLOAD_ID.test(v)) throw new ValidationError(`${field}[${i}] geçersiz`, field);
    return v;
  });
  return [...new Set(ids)];
}

export function ticketPhotos(store: DocumentStore | undefined, now: () => Date) {
  const expiresAt = () => new Date(now().getTime() + URL_TTL_SECONDS * 1000).toISOString();

  function requireStore(): DocumentStore {
    if (!store) throw new TicketError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return store;
  }

  /** Tarayicidan dogrudan yukleme; tur ve boyut imzalanir. */
  async function presignUpload(apartmentId: string, userId: string, body: unknown) {
    const s = requireStore();
    const o = asObject(body);
    if (!isPhotoContentType(o.contentType)) throw new TicketError('unprocessable', 'Desteklenmeyen dosya türü. İzin verilenler: JPEG, PNG, WEBP, HEIC');
    const size = reqInt(o, 'size', 1, Number.MAX_SAFE_INTEGER);
    if (size > MAX_PHOTO_BYTES) throw new TicketError('unprocessable', 'Fotoğraf en fazla 10 MB olabilir');
    const uploadId = `${randomBytes(12).toString('hex')}_${PHOTO_CONTENT_TYPES[o.contentType]}`;
    const key = ticketPhotoKeys.pending(apartmentId, userId, uploadId);
    const uploadUrl = await s.presignPut(key, { contentType: o.contentType, contentLength: size, expiresIn: URL_TTL_SECONDS });
    return { uploadId, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': o.contentType }, maxBytes: MAX_PHOTO_BYTES, expiresAt: expiresAt() };
  }

  /** Gecici yuklemeleri talebe tasir; kalici anahtarlari dondurur. */
  async function attach(apartmentId: string, userId: string, ticketId: string, uploadIds: readonly string[]): Promise<string[]> {
    if (!uploadIds.length) return [];
    const s = requireStore();
    const keys: string[] = [];
    for (const id of uploadIds) {
      const from = ticketPhotoKeys.pending(apartmentId, userId, id);
      const head = await s.head(from);
      if (!head) throw new TicketError('unprocessable', 'Fotoğraf yüklenmemiş veya süresi dolmuş; yeniden yükleyin');
      if (head.size > MAX_PHOTO_BYTES) throw new TicketError('unprocessable', 'Fotoğraf en fazla 10 MB olabilir');
      const to = ticketPhotoKeys.final(apartmentId, ticketId, id);
      await s.copy(from, to);
      keys.push(to);
    }
    return keys;
  }

  async function presignDownload(key: string, fileName: string) {
    const contentType = photoContentTypeOf(key);
    const name = safeFileName(`${fileName}${key.slice(key.lastIndexOf('.'))}`, 'talep-fotografi');
    const url = await requireStore().presignGet(key, { contentDisposition: contentDisposition(name, 'inline'), contentType, expiresIn: URL_TTL_SECONDS });
    return { url, fileName: name, contentType, expiresAt: expiresAt() };
  }

  return { presignUpload, attach, presignDownload };
}

export type TicketPhotos = ReturnType<typeof ticketPhotos>;
