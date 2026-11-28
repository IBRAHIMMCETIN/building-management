import { ApiError } from '@bm/shared/api/errors';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '@bm/shared/api/work';
import * as ImagePicker from 'expo-image-picker';

/*
 * Fotograf kaniti (ariza, bakim, sayac okumasi): kamera veya galeriden secilir, API'den alinan
 * kisa omurlu imzali S3 linkine dogrudan PUT edilir (dosya API'den gecmez; web: putPhoto).
 * Secilen goruntu JPEG'e sikistirilir (iOS HEIC de JPEG'e doner); en fazla 10 MB.
 */

export type LocalPhoto = { uri: string; mimeType: string; fileSize?: number };

export type PickResult = { kind: 'picked'; photo: LocalPhoto } | { kind: 'cancelled' } | { kind: 'denied'; canAskAgain: boolean };

const EXT_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

/** Seciciden gelen turu API'nin kabul ettigi ture cevirir (`image/jpg` -> `image/jpeg`, uzantidan tahmin). */
export function photoContentType(asset: { mimeType?: string | null; uri: string }): string {
  const raw = (asset.mimeType ?? '').toLowerCase();
  if (raw === 'image/jpg') return 'image/jpeg';
  if (raw) return raw;
  const ext = /\.([a-z0-9]+)(?:$|\?)/i.exec(asset.uri)?.[1]?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? 'image/jpeg';
}

/** Gonderimden once dosya kontrolu: hata metni veya null. */
export function photoError(photo: { mimeType: string; fileSize?: number }): string | null {
  if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(photo.mimeType)) return 'Desteklenmeyen dosya türü. İzin verilenler: JPEG, PNG, WEBP, HEIC';
  if (photo.fileSize !== undefined && photo.fileSize > MAX_PHOTO_BYTES) return 'Fotoğraf en fazla 10 MB olabilir';
  return null;
}

/** Kamera veya galeri; izin reddinde `denied` (ayarlardan acilmasi gerekiyorsa canAskAgain false). */
export async function pickPhoto(source: 'camera' | 'library'): Promise<PickResult> {
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { kind: 'denied', canAskAgain: perm.canAskAgain };
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6, exif: false, allowsMultipleSelection: false };
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return { kind: 'cancelled' };
  return { kind: 'picked', photo: { uri: asset.uri, mimeType: photoContentType(asset), ...(asset.fileSize ? { fileSize: asset.fileSize } : {}) } };
}

export type UploadTarget = { id: string; uploadUrl: string; headers: Record<string, string> };

export type UploadDeps = {
  /** API'den imzali link ister (dosya turu + boyut). */
  request: (input: { contentType: string; size: number }) => Promise<UploadTarget>;
  /** Imzali linke PUT (demo modunda sahte API). */
  put: typeof fetch;
  /** Yerel dosyayi okur (test icin degistirilebilir). */
  read?: (uri: string) => Promise<Blob>;
};

const readLocal = async (uri: string) => (await fetch(uri)).blob();

/** Tek fotografi yukler; API'nin verdigi kimligi (uploadId / photoKey) dondurur. */
export async function uploadPhoto(photo: LocalPhoto, deps: UploadDeps): Promise<string> {
  const invalid = photoError(photo);
  if (invalid) throw new ApiError(422, { error: 'unprocessable', message: invalid });
  let blob: Blob;
  try {
    blob = await (deps.read ?? readLocal)(photo.uri);
  } catch {
    throw new ApiError(0, { error: 'upload_failed', message: 'Fotoğraf okunamadı. Yeniden çekip tekrar deneyin.' });
  }
  if (blob.size > MAX_PHOTO_BYTES) throw new ApiError(422, { error: 'unprocessable', message: 'Fotoğraf en fazla 10 MB olabilir' });
  const target = await deps.request({ contentType: photo.mimeType, size: blob.size });
  let res: Response;
  try {
    res = await deps.put(target.uploadUrl, { method: 'PUT', headers: target.headers, body: blob });
  } catch {
    throw new ApiError(0, { error: 'upload_failed', message: 'Fotoğraf yüklenemedi: bağlantı hatası.' });
  }
  if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Fotoğraf yüklenemedi (${res.status}).` });
  return target.id;
}

/** Sirayla yukler (zayif saha baglantisinda paralel yukleme hepsini bozar). */
export async function uploadPhotos(photos: readonly LocalPhoto[], deps: UploadDeps): Promise<string[]> {
  const ids: string[] = [];
  for (const p of photos) ids.push(await uploadPhoto(p, deps));
  return ids;
}
