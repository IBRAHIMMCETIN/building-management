import { z } from 'zod';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import { ApiError } from './errors';

export * from './documentModel';

/*
 * Belgeler (apps/api/src/modules/documents). Dosyaya YALNIZCA API'nin urettigi 5 dakikalik
 * imzali S3 linkiyle erisilir; link istenince alinip hemen acilir, saklanmaz.
 *   GET  /api/documents/receipts/by-transaction/:txId   yonetici/denetci: makbuz PDF
 *   GET  /api/documents/receipts/by-payment/:paymentId  yonetici/denetci: makbuz (online odemeler)
 *   GET  /api/documents/invoices/by-transaction/:txId   yonetici/denetci: gider faturasi
 *   POST /api/documents/invoice-uploads                 yonetici: fatura yukleme linki
 *   GET  /api/documents/my-receipts/:paymentId?unitId   sakin: kendi makbuzu
 */

const uploadSchema = z.object({
  uploadId: z.string(),
  fileName: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  maxBytes: z.number().int(),
  expiresAt: z.string(),
});

const tx = (id: string) => encodeURIComponent(id);

export const documentsApi = {
  receiptForTransaction: (transactionId: string) =>
    apiClient.get(`/api/documents/receipts/by-transaction/${tx(transactionId)}`, { schema: signedDownloadSchema }),
  receiptForPayment: (paymentId: string) =>
    apiClient.get(`/api/documents/receipts/by-payment/${encodeURIComponent(paymentId)}`, { schema: signedDownloadSchema }),
  invoiceForTransaction: (transactionId: string) =>
    apiClient.get(`/api/documents/invoices/by-transaction/${tx(transactionId)}`, { schema: signedDownloadSchema }),
  myReceipt: (paymentId: string, unitId?: string) =>
    apiClient.get(`/api/documents/my-receipts/${encodeURIComponent(paymentId)}`, {
      query: unitId ? { unitId } : undefined,
      schema: signedDownloadSchema,
    }),

  /**
   * Faturayi tarayicidan dogrudan S3'e yukler (API sunucusundan gecmez): once imzali link
   * alinir, sonra dosya PUT edilir. Donen `uploadId` gider kaydina eklenir.
   */
  async uploadInvoice(file: File): Promise<{ uploadId: string; fileName: string }> {
    const upload = await apiClient.post(
      '/api/documents/invoice-uploads',
      { fileName: file.name, contentType: file.type, size: file.size },
      { schema: uploadSchema },
    );
    let res: Response;
    try {
      res = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: file });
    } catch {
      throw new ApiError(0, { error: 'upload_failed', message: 'Fatura yüklenemedi: bağlantı hatası.' });
    }
    if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Fatura yüklenemedi (${res.status}).` });
    return { uploadId: upload.uploadId, fileName: upload.fileName };
  },
};
