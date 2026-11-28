import type { IsoDate } from '../core/types.js';

/*
 * S3 anahtar duzeni (proje kurali: her sey `apartments/{apartmentId}/...` altinda, private).
 *   apartments/{apt}/receipts/{yyyy}/{mm}/{paymentId}.v{N}.pdf        tahsilat makbuzu (onbellek)
 *   apartments/{apt}/receipts/{yyyy}/{mm}/{paymentId}-iptal.v{N}.pdf  ters kayitla iptal edilmis hali
 *   apartments/{apt}/invoices/{yyyy}/{mm}/{expenseId}.{ext}        gider faturasi
 *   apartments/{apt}/reports/{yyyy}/{mm}/bank-recon-...-{hash}.pdf  banka mutabakat raporu (B3.5)
 *   apartments/{apt}/tenders/{tenderId}/quotes/{quoteId}/{uploadId}.{ext}  ihale teklif belgesi
 *                                                                  (yukleme basina ayri anahtar:
 *                                                                  degistirilen belge kayit olarak kalir)
 *   tmp/{apt}/invoice-uploads/{uploadId}                           tarayicidan yuklenen, henuz
 *                                                                  gidere / teklife baglanmamis dosya
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

/**
 * Faz B3.5: donemsel banka mutabakat raporu (onbellek). `dataHash` rapor verisinin ve sablon
 * surumunun ozetidir: veri degisince yeni dosya uretilir, eskisi kayit olarak kalir.
 *   apartments/{apt}/reports/{yyyy}/{mm}/bank-recon-{bankAccountId}-{from}-{to}-{hash}.pdf
 */
export function bankReconReportKey(
  apartmentId: string,
  asOf: IsoDate,
  bankAccountId: string,
  range: { from?: IsoDate; to?: IsoDate },
  dataHash: string,
): string {
  const from = range.from ? range.from.replaceAll('-', '') : 'start';
  const to = range.to ? range.to.replaceAll('-', '') : 'latest';
  return `apartments/${apartmentId}/reports/${ym(asOf)}/bank-recon-${bankAccountId}-${from}-${to}-${dataHash.slice(0, 16)}.pdf`;
}

export function pendingUploadKey(apartmentId: string, uploadId: string): string {
  return `${PENDING_UPLOAD_PREFIX}${apartmentId}/invoice-uploads/${uploadId}`;
}

export function invoiceKey(apartmentId: string, date: IsoDate, expenseId: string, extension: string): string {
  return `apartments/${apartmentId}/invoices/${ym(date)}/${expenseId}.${extension}`;
}

/** Ihale teklif belgesi (fatura yuklemesiyle ayni gecici alan ve sinirlar). */
export function tenderQuoteKey(apartmentId: string, tenderId: string, quoteId: string, uploadId: string, extension: string): string {
  return `apartments/${apartmentId}/tenders/${tenderId}/quotes/${quoteId}/${uploadId}.${extension}`;
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

/**
 * Finans 2.3-5a: sayac dagitim dokumu (daire basina, onbellek). `dataHash` satir verisi ve sablon
 * surumunun ozetidir: donem geri alinip duzeltilirse yeni donem yeni dosya uretir.
 *   apartments/{apt}/reports/{yyyy}/{mm}/meter-statement-{periodId}-{unitId}-{hash}.pdf
 */
export function meterStatementKey(apartmentId: string, endDate: IsoDate, periodId: string, unitId: string, dataHash: string): string {
  return `apartments/${apartmentId}/reports/${ym(endDate)}/meter-statement-${periodId}-${unitId}-${dataHash.slice(0, 16)}.pdf`;
}

/**
 * Finans 2.4-3: finans raporu PDF'i (mizan, gelir-gider, butce-gerceklesen, kesin hesap, borclu
 * listesi, hesap dokumu). `dataHash` rapor verisi + sablon surumu ozetidir: veri degismedikce ayni
 * dosya yeniden kullanilir, degisince yeni dosya uretilir.
 *   apartments/{apt}/reports/{yyyy}/{mm}/finance-{kind}-{slug}-{hash}.pdf
 */
export function financeReportKey(apartmentId: string, generatedOn: IsoDate, kind: string, slug: string, dataHash: string): string {
  const safeSlug = slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  return `apartments/${apartmentId}/reports/${ym(generatedOn)}/finance-${kind}-${safeSlug}-${dataHash.slice(0, 16)}.pdf`;
}

/**
 * Y1-3: kat malikleri kurulu hazirun cetveli. `dataHash` oy listesi + katilim + sablon ozetidir:
 * katilim degistikce yeni dosya uretilir.
 *   apartments/{apt}/reports/{yyyy}/{mm}/assembly-hazirun-{assemblyId}-{hash}.pdf
 */
export function assemblySheetKey(apartmentId: string, meetingDate: IsoDate, assemblyId: string, dataHash: string): string {
  return `apartments/${apartmentId}/reports/${ym(meetingDate)}/assembly-hazirun-${assemblyId}-${dataHash.slice(0, 16)}.pdf`;
}

/**
 * Genel kurul devami: toplanti tutanagi. `dataHash` toplanti + yeter sayi + kararlar + divan /
 * notlar + sablon ozetidir: tutanak veya karar (duzeltme) degisince yeni dosya uretilir.
 *   apartments/{apt}/reports/{yyyy}/{mm}/assembly-minutes-{assemblyId}-{hash}.pdf
 */
export function assemblyMinutesKey(apartmentId: string, meetingDate: IsoDate, assemblyId: string, dataHash: string): string {
  return `apartments/${apartmentId}/reports/${ym(meetingDate)}/assembly-minutes-${assemblyId}-${dataHash.slice(0, 16)}.pdf`;
}

/**
 * Genel kurul devami: apartmanin karar defteri (tum kararlar, tarih sirasi). Ay klasoru son
 * toplantinin gunu; `dataHash` tum karar kayitlari + sablon ozeti.
 *   apartments/{apt}/reports/{yyyy}/{mm}/assembly-decision-book-{hash}.pdf
 */
export function assemblyDecisionBookKey(apartmentId: string, asOf: IsoDate, dataHash: string): string {
  return `apartments/${apartmentId}/reports/${ym(asOf)}/assembly-decision-book-${dataHash.slice(0, 16)}.pdf`;
}

/**
 * Genel kurul sonrasi: toplanti disinda yazili riza sonuc tutanagi. `dataHash` talep + riza kayitlari +
 * sonuc + sablon ozetidir: yeni riza / duzeltme yeni dosya uretir.
 *   apartments/{apt}/reports/{yyyy}/{mm}/assembly-consent-{consentId}-{hash}.pdf
 */
export function assemblyConsentReportKey(apartmentId: string, rollDate: IsoDate, consentId: string, dataHash: string): string {
  return `apartments/${apartmentId}/reports/${ym(rollDate)}/assembly-consent-${consentId}-${dataHash.slice(0, 16)}.pdf`;
}

/** Yazili riza belgesi taramasi (fatura yuklemesiyle ayni gecici alan ve sinirlar). */
export function assemblyConsentDocumentKey(apartmentId: string, consentId: string, unitId: string, uploadId: string, extension: string): string {
  return `apartments/${apartmentId}/assemblies/consents/${consentId}/${unitId}/${uploadId}.${extension}`;
}
