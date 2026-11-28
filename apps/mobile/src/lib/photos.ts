import { ApiError, errorMessage } from '@bm/shared/api/errors';
import { MAX_PHOTOS_PER_EVENT, type PhotoUpload, photoError } from '@bm/shared/api/portalTickets';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

/*
 * Talep fotograflari: kamera veya galeri (expo-image-picker), yuklemeden once kucultme + JPEG
 * sikistirma (expo-image-manipulator; uzun kenar en fazla 1920 px, kalite 0.7) ve API siniri
 * kontrolu (JPEG/PNG/WEBP/HEIC, 10 MB; olay basina 6). Dosya API'den gecmez: `upload-url` ile alinan
 * imzali linke PUT edilir (web: components/tickets/PhotoPicker.tsx + lib/api/tickets.ts putPhoto).
 */

export const MAX_PHOTOS = MAX_PHOTOS_PER_EVENT;
const MAX_EDGE = 1920;
const QUALITY = 0.7;

export type PreparedPhoto = { uri: string; width: number; height: number; type: string; size: number; blob: Blob };

type Fetch = typeof fetch;
type Asset = { uri: string; width: number; height: number };

/** Kullaniciya gosterilecek fotograf hatasi (izin, tur, boyut). */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

/** Fotograf / yukleme hatasinin Turkce metni. */
export const photoErrorMessage = (err: unknown) => (err instanceof PhotoError ? err.message : errorMessage(err));

/** Secilen gorseli kucultup JPEG olarak kaydeder; boyutu olcer ve API kurallarina gore dogrular. */
export async function preparePhoto(asset: Asset, fetchImpl: Fetch = fetch): Promise<PreparedPhoto> {
  let out: { uri: string; width: number; height: number };
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    if (Math.max(asset.width, asset.height) > MAX_EDGE) ctx.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
    const image = await ctx.renderAsync();
    out = await image.saveAsync({ compress: QUALITY, format: SaveFormat.JPEG });
  } catch {
    throw new PhotoError('Fotoğraf hazırlanamadı. Başka bir fotoğraf deneyin.');
  }
  const blob = await (await fetchImpl(out.uri)).blob();
  const type = 'image/jpeg';
  const problem = photoError({ type, size: blob.size });
  if (problem) throw new PhotoError(problem);
  return { uri: out.uri, width: out.width, height: out.height, type, size: blob.size, blob };
}

/** Galeriden en fazla `room` fotograf (iptalde bos liste). Secici izin istemez (sistem secicisi). */
export async function pickFromLibrary(room: number, fetchImpl?: Fetch): Promise<PreparedPhoto[]> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: room > 1, selectionLimit: room, quality: 1, exif: false });
  if (result.canceled) return [];
  const out: PreparedPhoto[] = [];
  for (const asset of result.assets.slice(0, room)) out.push(await preparePhoto(asset, fetchImpl));
  return out;
}

/** Kamerayla tek fotograf; izin reddinde aciklayici hata. */
export async function takePhoto(fetchImpl?: Fetch): Promise<PreparedPhoto | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new PhotoError('Kamera izni verilmedi. Ayarlar’dan izin verebilir veya galeriden seçebilirsiniz.');
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  return asset ? preparePhoto(asset, fetchImpl) : null;
}

/** Imzali S3 linkine dogrudan PUT (Authorization yok; basliklar API'nin verdikleri). */
export async function putToSignedUrl(upload: PhotoUpload, body: Blob, fetchImpl: Fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body });
  } catch {
    throw new ApiError(0, { error: 'upload_failed', message: 'Fotoğraf yüklenemedi: bağlantı hatası.' });
  }
  if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Fotoğraf yüklenemedi (${res.status}).` });
  return upload.uploadId;
}

/** Ayni fotograf tekrar gonderimde (ag hatasi sonrasi) yeniden yuklenmez. */
const uploaded = new WeakMap<PreparedPhoto, string>();

/** Fotograflari sirayla yukler; yukleme kimliklerini dondurur. */
export async function uploadPhotos(photos: readonly PreparedPhoto[], upload: (p: PreparedPhoto) => Promise<string>): Promise<string[]> {
  const ids: string[] = [];
  for (const p of photos) {
    const id = uploaded.get(p) ?? (await upload(p));
    uploaded.set(p, id);
    ids.push(id);
  }
  return ids;
}
