import { z } from 'zod';

/*
 * Belge modeli ve saf yardimcilar: API istemcisine (ve ortam yapilandirmasina) bagimli
 * DEGILDIR; testler buradan import eder. Uclar icin bkz. ./documents.ts.
 */

export const signedDownloadSchema = z.object({
  url: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  expiresAt: z.string(),
});
export type SignedDownload = z.infer<typeof signedDownloadSchema>;

/** API ile ayni kurallar (keys.ts): PDF / gorsel, en fazla 10 MB. */
export const INVOICE_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic';
export const INVOICE_TYPES = INVOICE_ACCEPT.split(',');
export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;

export function invoiceFileError(file: File): string | null {
  if (!INVOICE_TYPES.includes(file.type)) return 'Yalnızca PDF, JPEG, PNG, WEBP veya HEIC dosyası yükleyebilirsiniz.';
  if (file.size > MAX_INVOICE_BYTES) return 'Dosya en fazla 10 MB olabilir.';
  if (file.size === 0) return 'Dosya boş.';
  return null;
}

/**
 * Imzali linki yeni sekmede acar. Sekme TIKLAMA ANINDA acilir (aksi halde await sonrasi
 * tarayicinin acilir pencere engelleyicisine takilir), link gelince yonlendirilir.
 */
export async function openSignedDocument(load: () => Promise<SignedDownload>): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const { url } = await load();
    if (win) {
      win.opener = null;
      win.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (err) {
    win?.close();
    throw err;
  }
}
