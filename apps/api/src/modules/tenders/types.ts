/**
 * Ihale / teklif toplama - kayitlar. Tek tablo, `PK = APT#<apartmentId>`:
 *
 *   TENDER#<tenderId>                          ihale (surumlu; teklifler kaydin icinde, en fazla
 *                                              MAX_QUOTES). Silinmez: `status` alanı (iptal dahil)
 *   TCMT#<tenderId>#<createdAtIso>#<commentId> sakin sorusu / yonetim yaniti (yalnizca eklenir)
 *   TIDEM#<idempotencyKey>                     olusturma idempotency kaydi (ihale, teklif, yorum)
 *
 * Durumlar: draft -> collecting -> published (sakinlerle paylasildi) -> decided; draft / collecting /
 * published -> cancelled. Yayindan sonra teklifler donar (sakinlerin gordugu ile karar ayni kalir).
 *
 * Teklif belgesi private S3'te: tarayici gider faturasi akisiyla (`POST /api/documents/invoice-uploads`)
 * `tmp/{apt}/invoice-uploads/{uploadId}` altina yukler; teklif kaydinda dosya
 * `apartments/{apt}/tenders/{tenderId}/quotes/{quoteId}/{uploadId}.{ext}` anahtarina kopyalanir.
 * Erisim yalnizca kisa omurlu imzali URL ile; sakin / denetci yalnizca yayinlanmis ihalede.
 *
 * Tutarlar kurus (tam sayi). Teklif tutari KDV dahil ya da haric girilir; karsilastirma KDV dahil
 * toplam (normalize) uzerinden yapilir (bkz. model.ts).
 */
import type { AuditFields, IsoDate, IsoDateTime, TableKeys } from '../core/types.js';

export const TENDER_CATEGORIES = ['mantolama', 'asansor', 'cati', 'boya', 'tesisat', 'elektrik', 'peyzaj', 'other'] as const;
export type TenderCategory = (typeof TENDER_CATEGORIES)[number];

export const TENDER_STATUSES = ['draft', 'collecting', 'published', 'decided', 'cancelled'] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];
/** Teklif eklenebilen / duzenlenebilen durumlar (yayindan sonra teklifler donar). */
export const EDITABLE_STATUSES: readonly TenderStatus[] = ['draft', 'collecting'];
export const CANCELLABLE_STATUSES: readonly TenderStatus[] = ['draft', 'collecting', 'published'];

export const DEFAULT_MIN_QUOTES = 3;
export const MAX_MIN_QUOTES = 10;
/** Bir ihaledeki teklif sayisi ust siniri: geri cekilenler de sayilir (silinmez, kayit boyutu sinirli kalir). */
export const MAX_QUOTES = 12;
/** API ve web ile ayni ust sinir: 999.999.999,99 TL. */
export const MAX_QUOTE_KURUS = 99_999_999_999;
export const MAX_VAT_RATE = 100;
export const MAX_DELIVERY_DAYS = 3650;
export const MAX_WARRANTY_MONTHS = 600;
/** Yorum: kisa soru / yanit. Kullanici basina ihale icinde ust sinir. */
export const MAX_COMMENT_LENGTH = 500;
/** Sakin basina ihale icinde mesaj siniri (yonetim yanitlarina uygulanmaz; onlar MAX_MANAGEMENT_COMMENTS ile sinirli). */
export const MAX_COMMENTS_PER_USER = 20;
export const MAX_MANAGEMENT_COMMENTS = 500;
/** Degistirilen teklif belgelerinin kaydi (teklif basina; en eskisi dusmez, yeni degisim reddedilir). */
export const MAX_DOCUMENT_HISTORY = 10;

export type QuoteDocument = { key: string; fileName: string; contentType: string; size: number };
/** Yerine yenisi yuklenen belge: S3'te kalir, yonetim ayni imzali link yoluyla acabilir. */
export type ReplacedQuoteDocument = QuoteDocument & { replacedAt: IsoDateTime; replacedBy: string };

export type TenderQuote = {
  quoteId: string;
  supplierName: string;
  /** Girilen tutar (kurus); `vatIncluded` ile KDV dahil mi haric mi oldugu. */
  amountKurus: number;
  vatIncluded: boolean;
  /** KDV orani (yuzde, tam sayi: 0, 1, 10, 20). */
  vatRate: number;
  validUntil?: IsoDate;
  /** Is / teslim suresi (gun). */
  deliveryDays?: number;
  warrantyMonths?: number;
  notes?: string;
  document?: QuoteDocument;
  /** Eskiden yeniye degistirilen belgeler (yalnizca yonetim gorur). */
  documentHistory?: ReplacedQuoteDocument[];
  status: 'active' | 'withdrawn';
  withdrawnAt?: IsoDateTime;
  withdrawnBy?: string;
  withdrawReason?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
};

/**
 * Kategoriden onerilen Finans gider hesabi (hazir hesaplar; yonetici gider penceresinde degistirebilir).
 */
export const TENDER_EXPENSE_ACCOUNT: Record<TenderCategory, string> = {
  mantolama: 'exp-repair',
  asansor: 'exp-elevator',
  cati: 'exp-repair',
  boya: 'exp-repair',
  tesisat: 'exp-repair',
  elektrik: 'exp-repair',
  peyzaj: 'exp-garden',
  other: 'exp-repair',
};

/** Karar: secilen teklif ve gerekce; karar aninda teklifin ozeti saklanir (Finans'a aktarim icin). */
export type TenderDecision = {
  quoteId: string;
  reason: string;
  /** Genel kurul / anket karari gibi serbest referans (ornek Y1 anket kimligi, karar defteri no). */
  reference?: string;
  supplierName: string;
  netKurus: number;
  vatKurus: number;
  totalKurus: number;
  decidedAt: IsoDateTime;
  decidedBy: string;
};

export type TenderTicketLink = { ticketId: string; number: string; title: string };

/**
 * Karardan Finans'a aktarim: mevcut Finans gider servisiyle (`recordExpense`) kaydedilen gider. Gider,
 * defter islemi, ihale guncellemesi ve denetim kaydi TEK atomik yazimdir; ihale basina bir gider.
 */
export type TenderExpenseLink = {
  expenseId: string;
  transactionId: string;
  amountKurus: number;
  date: IsoDate;
  /** Ayni istegin tekrari (yanit kayboldu) ayni sonucu doner. */
  idempotencyKey: string;
  linkedAt: IsoDateTime;
  linkedBy: string;
};

export type Tender = TableKeys &
  AuditFields & {
    entityType: 'TENDER';
    apartmentId: string;
    tenderId: string;
    title: string;
    description: string;
    category: TenderCategory;
    /** Ilgili ariza / bakim talebi (O1), varsa. KVKK: yalnizca yonetim / denetci gorur (talepler daireye ozeldir). */
    ticket?: TenderTicketLink;
    /** Asgari teklif sayisi: taslaktan cikinca kilitlenir (yayin gerekcesi kurali bu sayiyla). */
    minQuotes: number;
    /** Teklif toplama son gunu (Europe/Istanbul takvim gunu). */
    deadline: IsoDate;
    status: TenderStatus;
    quotes: TenderQuote[];
    collectingAt?: IsoDateTime;
    publishedAt?: IsoDateTime;
    publishedBy?: string;
    /** Asgari teklif sayisina ulasilmadan yayinlandiysa gerekce (sakinler de gorur). */
    shortfallReason?: string;
    decision?: TenderDecision;
    cancelledAt?: IsoDateTime;
    cancelledBy?: string;
    cancelReason?: string;
    cancelledFrom?: TenderStatus;
    /** Karardan kaydedilen Finans gideri (yalnizca `decided`). */
    expense?: TenderExpenseLink;
  };

export type TenderComment = TableKeys & {
  entityType: 'TENDER_COMMENT';
  apartmentId: string;
  tenderId: string;
  commentId: string;
  body: string;
  authorId: string;
  authorRole: string;
  authorKind: 'resident' | 'management';
  createdAt: IsoDateTime;
};

export type TenderIdempotency = TableKeys & {
  entityType: 'TENDER_IDEMPOTENCY';
  apartmentId: string;
  kind: 'tender' | 'quote' | 'comment';
  tenderId: string;
  targetId: string;
  fingerprint: string;
  createdAt: IsoDateTime;
};

const pk = (apartmentId: string) => `APT#${apartmentId}`;
export const tenderKeys = {
  tender: (apt: string, tenderId: string): TableKeys => ({ PK: pk(apt), SK: `TENDER#${tenderId}` }),
  tenderPrefix: 'TENDER#',
  comment: (apt: string, tenderId: string, createdAt: IsoDateTime, commentId: string): TableKeys => ({ PK: pk(apt), SK: `TCMT#${tenderId}#${createdAt}#${commentId}` }),
  commentPrefix: (tenderId: string) => `TCMT#${tenderId}#`,
  idempotency: (apt: string, key: string): TableKeys => ({ PK: pk(apt), SK: `TIDEM#${key}` }),
};
