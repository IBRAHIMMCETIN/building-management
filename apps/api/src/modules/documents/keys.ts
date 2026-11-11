import type { IsoDate } from '../core/types.js';

/*
 * S3 anahtar duzeni (proje kurali: her sey `apartments/{apartmentId}/...` altinda, private).
 *   apartments/{apt}/receipts/{yyyy}/{mm}/{paymentId}.v{N}.pdf        tahsilat makbuzu (onbellek)
 *   apartments/{apt}/receipts/{yyyy}/{mm}/{paymentId}-iptal.v{N}.pdf  ters kayitla iptal edilmis hali
 *   apartments/{apt}/invoices/{yyyy}/{mm}/{expenseId}.{ext}        gider faturasi
 *   tmp/{apt}/invoice-uploads/{uploadId}                           tarayicidan yuklenen, henuz
 *                                                                  gidere baglanmamis dosya
 *                                                                  (S3 yasam dongusu 1 gunde siler)
 * `tmp/` ayri bir kok onektir: yasam dongusu kurali onek ile calisir ve apartman kimligi
 * joker karakterle eslenemez.
 */

export const PENDING_UPLOAD_PREFIX = 'tmp/';

const ym = (date: IsoDate) => `${date.slice(0, 4)}/${date.slice(5, 7)}`;

/**
 * Makbuz sablon surumu. Sablon (metin/duzen) degistiginde artirilir: onbellekteki eski PDF'ler
 * yeni anahtarla eslesmez, makbuzlar ilk istekte yeni sablonla yeniden uretilir. Eski dosyalar
 * kayit olarak kalir.
 *   v1: ilk surum   v2: "Bagimsiz bolum" -> "Blok / Daire"
 */
export const RECEIPT_TEMPLATE_VERSION = 2;

export function receiptKey(apartmentId: string, paidAt: IsoDate, paymentId: string, reversed: boolean): string {
  return `apartments/${apartmentId}/receipts/${ym(paidAt)}/${paymentId}${reversed ? '-iptal' : ''}.v${RECEIPT_TEMPLATE_VERSION}.pdf`;
}

export function pendingUploadKey(apartmentId: string, uploadId: string): string {
  return `${PENDING_UPLOAD_PREFIX}${apartmentId}/invoice-uploads/${uploadId}`;
}

export function invoiceKey(apartmentId: string, date: IsoDate, expenseId: string, extension: string): string {
  return `apartments/${apartmentId}/invoices/${ym(date)}/${expenseId}.${extension}`;
}

/** Fatura olarak kabul edilen dosya turleri (icerik turu -> uzanti). */
export const INVOICE_CONTENT_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
} as const;
export type InvoiceContentType = keyof typeof INVOICE_CONTENT_TYPES;

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;

export const isInvoiceContentType = (v: unknown): v is InvoiceContentType =>
  typeof v === 'string' && Object.hasOwn(INVOICE_CONTENT_TYPES, v);

/**
 * Indirme adi olarak gosterilecek guvenli dosya adi: yol, kontrol karakteri ve tirnak
 * temizlenir; Turkce harfler korunur; en fazla 120 karakter.
 */
export function safeFileName(name: string, fallback = 'dosya'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: kontrol karakterleri bilerek temizleniyor
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["<>|*?:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** RFC 6266: ASCII yedek ad + UTF-8 ad (tarayicilar Turkce adi dogru gosterir). */
export function contentDisposition(fileName: string, disposition: 'inline' | 'attachment' = 'inline'): string {
  const ascii = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim() || 'dosya';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
