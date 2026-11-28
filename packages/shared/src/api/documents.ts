import { z } from 'zod';

/*
 * Belgeler (apps/api/src/modules/documents). Dosyaya YALNIZCA API'nin urettigi 5 dakikalik
 * imzali S3 linkiyle erisilir; link istenince alinip hemen acilir, saklanmaz.
 * Tarayiciya ozel yardimcilar (yeni sekmede acma, fatura dosyasi kontrolu) web'dedir:
 * apps/web/src/lib/api/documentModel.ts.
 */
export const signedDownloadSchema = z.object({
  url: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  expiresAt: z.string(),
});
export type SignedDownload = z.infer<typeof signedDownloadSchema>;
