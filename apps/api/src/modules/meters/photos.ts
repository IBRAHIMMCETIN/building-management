/**
 * Finans 2.3 - Sayac fotograf kaniti (okuma, degisim, emeklilik). Dosyalar private S3'te
 * `apartments/{apartmentId}/meters/{yyyy}/{mm}/{unitId}/` altinda; istemci yalnizca kisa omurlu
 * imzali URL ile yukler / goruntuler. Yetki API'de kontrol edilir.
 */
import type { IsoDate } from '../core/types.js';
import { type Obj, ValidationError, reqInt } from '../core/validation.js';
import { contentDisposition, safeFileName } from '../documents/keys.js';
import { type DocumentStore, URL_TTL_SECONDS } from '../documents/store.js';
import { MAX_PHOTO_BYTES, isPhotoContentType, meterPhotoPrefix, photoContentTypeOf } from './common.js';
import { MeterError } from './errors.js';

export function meterPhotos(store: DocumentStore | undefined, now: () => Date) {
  const expiresAt = () => new Date(now().getTime() + URL_TTL_SECONDS * 1000).toISOString();

  function requireStore(): DocumentStore {
    if (!store) throw new MeterError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return store;
  }

  /** Anahtar bu kayda (apartman / ay / daire / ad on eki) ait mi ve depoda var mi? */
  async function assertPhoto(apartmentId: string, key: string, date: IsoDate, unitId: string, namePrefix: string): Promise<void> {
    const prefix = `${meterPhotoPrefix(apartmentId, date, unitId)}${namePrefix}`;
    if (!key.startsWith(prefix) || key.includes('..')) throw new ValidationError('photoKey bu kayda ait değil', 'photoKey');
    const head = await requireStore().head(key);
    if (!head) throw new MeterError('unprocessable', 'Fotoğraf yüklenmemiş (önce yükleme bağlantısıyla gönderin)');
    if (head.size > MAX_PHOTO_BYTES) throw new MeterError('unprocessable', 'Fotoğraf en fazla 10 MB olabilir');
  }

  /** Tarayicidan dogrudan yukleme; tur ve boyut imzalanir. */
  async function presignUpload(key: string, body: Obj) {
    const s = requireStore();
    const contentType = body.contentType;
    if (!isPhotoContentType(contentType)) throw new MeterError('unprocessable', 'Desteklenmeyen dosya türü. İzin verilenler: JPEG, PNG, WEBP, HEIC');
    const size = reqInt(body, 'size', 1, Number.MAX_SAFE_INTEGER);
    if (size > MAX_PHOTO_BYTES) throw new MeterError('unprocessable', 'Fotoğraf en fazla 10 MB olabilir');
    const uploadUrl = await s.presignPut(key, { contentType, contentLength: size, expiresIn: URL_TTL_SECONDS });
    return { photoKey: key, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': contentType }, maxBytes: MAX_PHOTO_BYTES, expiresAt: expiresAt() };
  }

  async function presignDownload(key: string, fileName: string) {
    const contentType = photoContentTypeOf(key);
    const name = safeFileName(`${fileName}${key.slice(key.lastIndexOf('.'))}`, 'sayac-fotografi');
    const url = await requireStore().presignGet(key, { contentDisposition: contentDisposition(name, 'inline'), contentType, expiresIn: URL_TTL_SECONDS });
    return { url, fileName: name, contentType, expiresAt: expiresAt() };
  }

  return { requireStore, assertPhoto, presignUpload, presignDownload };
}
