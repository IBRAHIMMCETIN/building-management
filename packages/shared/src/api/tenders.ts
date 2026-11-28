import { z } from 'zod';

/*
 * Ihale / teklif toplama (apps/api/src/modules/tenders): web + mobil ortak semalar, tipler ve saf
 * yardimcilar. API istemcisine bagimli DEGILDIR.
 *  - Yonetim: /api/tenders (yazma: yonetici + yonetim firmasi; okuma: + denetci, denetci yalnizca
 *    yayinlanmis ihaleleri gorur)
 *  - Sakin:   /api/portal/tenders (yalnizca yayinlanmis ihaleler; teklif belgeleri 5 dk imzali link)
 * Tutarlar kurus; `totalKurus` KDV dahil normalize toplamdir (karsilastirma bunun uzerinden).
 * Web uclari: apps/web/src/lib/api/tenders.ts; ekran yardimcilari web'de lib/tenders/model.ts
 * (bu dosyayi yeniden disa aktarir); mobil uclar: apps/mobile/src/lib/api/tenders.ts.
 *
 * KDV normalizasyonu API ile birebir aynidir (apps/api/src/modules/tenders/model.ts): kurus tam
 * sayi, yarim yukari yuvarlama; form onizlemesi kaydedilecek toplamla ayni cikar.
 */

export const TENDER_STATUSES = ['draft', 'collecting', 'published', 'decided', 'cancelled'] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];
export const TENDER_CATEGORIES = ['mantolama', 'asansor', 'cati', 'boya', 'tesisat', 'elektrik', 'peyzaj', 'other'] as const;
export type TenderCategory = (typeof TENDER_CATEGORIES)[number];

const amounts = { netKurus: z.number(), vatKurus: z.number(), totalKurus: z.number() };

export const quoteSchema = z.object({
  quoteId: z.string(),
  supplierName: z.string(),
  amountKurus: z.number(),
  vatIncluded: z.boolean(),
  vatRate: z.number(),
  validUntil: z.string().optional(),
  deliveryDays: z.number().optional(),
  warrantyMonths: z.number().optional(),
  notes: z.string().optional(),
  document: z.object({ fileName: z.string(), contentType: z.string(), size: z.number() }).optional(),
  /** Yalnizca yonetim: yerine yenisi yuklenen onceki belgeler (eskiden yeniye). */
  documentHistory: z.array(z.object({ fileName: z.string(), contentType: z.string(), size: z.number(), replacedAt: z.string(), replacedBy: z.string() })).optional(),
  status: z.enum(['active', 'withdrawn']),
  withdrawnAt: z.string().optional(),
  withdrawReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ...amounts,
});
export type Quote = z.infer<typeof quoteSchema>;

export const decisionSchema = z.object({
  quoteId: z.string(),
  reason: z.string(),
  reference: z.string().optional(),
  supplierName: z.string(),
  ...amounts,
  decidedAt: z.string(),
  decidedBy: z.string().optional(),
});
export type TenderDecision = z.infer<typeof decisionSchema>;

const ticketLinkSchema = z.object({ ticketId: z.string(), number: z.string(), title: z.string() });

export const tenderSummarySchema = z.object({
  tenderId: z.string(),
  title: z.string(),
  category: z.enum(TENDER_CATEGORIES),
  status: z.enum(TENDER_STATUSES),
  deadline: z.string(),
  deadlinePassed: z.boolean(),
  minQuotes: z.number(),
  quoteCount: z.number(),
  lowestTotalKurus: z.number().optional(),
  ticket: ticketLinkSchema.optional(),
  publishedAt: z.string().optional(),
  decision: decisionSchema.optional(),
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
export type TenderSummary = z.infer<typeof tenderSummarySchema>;

export const comparisonSchema = z.object({
  rows: z.array(z.object({ quoteId: z.string(), ...amounts, rank: z.number(), isLowest: z.boolean(), diffKurus: z.number(), diffBps: z.number() })),
  lowestQuoteIds: z.array(z.string()),
  lowestTotalKurus: z.number().optional(),
  highestTotalKurus: z.number().optional(),
  lowestNetQuoteIds: z.array(z.string()),
});
export type QuoteComparison = z.infer<typeof comparisonSchema>;

export const commentSchema = z.object({
  commentId: z.string(),
  body: z.string(),
  authorKind: z.enum(['resident', 'management']),
  mine: z.boolean(),
  createdAt: z.string(),
  authorId: z.string().optional(),
  authorRole: z.string().optional(),
});
export type TenderComment = z.infer<typeof commentSchema>;

export const tenderSchema = tenderSummarySchema.extend({
  description: z.string(),
  shortfallReason: z.string().optional(),
  cancelReason: z.string().optional(),
  cancelledFrom: z.enum(TENDER_STATUSES).optional(),
  quotes: z.array(quoteSchema),
  comparison: comparisonSchema,
  comments: z.array(commentSchema),
  canComment: z.boolean(),
  readiness: z.object({ activeQuotes: z.number(), minQuotes: z.number(), missingDocuments: z.array(z.string()), shortfall: z.boolean() }).optional(),
  /** Karardan kaydedilen Finans gideri (yonetim + denetci). */
  expense: z
    .object({ expenseId: z.string(), transactionId: z.string(), amountKurus: z.number(), date: z.string(), linkedAt: z.string(), linkedBy: z.string().optional(), reversed: z.boolean().optional() })
    .optional(),
  /** Yalnizca yonetim, karara baglanmis ve gideri olmayan ihale: gider penceresinin on dolumu. */
  expenseDraft: z.object({ amountKurus: z.number(), supplier: z.string(), description: z.string(), expenseAccountId: z.string(), date: z.string() }).optional(),
});
export type Tender = z.infer<typeof tenderSchema>;

/** Tekil ihale yaniti; yazimlarda `replayed` (ayni idempotency anahtari ayni sonuc). */
export const tenderResponseSchema = z.object({ tender: tenderSchema });
export const tenderWriteSchema = tenderResponseSchema.extend({ replayed: z.boolean() });

export type TenderInput = { title: string; description: string; category: TenderCategory; deadline: string; minQuotes: number; ticketId?: string | null };
export type QuoteInput = {
  supplierName: string;
  amountKurus: number;
  vatIncluded: boolean;
  vatRate: number;
  validUntil?: string | null;
  deliveryDays?: number | null;
  warrantyMonths?: number | null;
  notes?: string | null;
  document?: { uploadId: string; fileName: string };
};

// ---------------------------------------------------------------------------
// Etiketler ve saf yardimcilar
// ---------------------------------------------------------------------------

export const TENDER_STATUS_LABELS: Record<TenderStatus, string> = {
  draft: 'Taslak',
  collecting: 'Teklif toplanıyor',
  published: 'Sakinlerle paylaşıldı',
  decided: 'Karara bağlandı',
  cancelled: 'İptal edildi',
};

export const TENDER_STATUS_TONES: Record<TenderStatus, 'neutral' | 'warning' | 'accent' | 'success' | 'danger'> = {
  draft: 'neutral',
  collecting: 'warning',
  published: 'accent',
  decided: 'success',
  cancelled: 'danger',
};

export const TENDER_CATEGORY_LABELS: Record<TenderCategory, string> = {
  mantolama: 'Mantolama / dış cephe',
  asansor: 'Asansör',
  cati: 'Çatı',
  boya: 'Boya / badana',
  tesisat: 'Su / ısıtma tesisatı',
  elektrik: 'Elektrik',
  peyzaj: 'Bahçe / peyzaj',
  other: 'Diğer',
};

/** Turkiye'de uygulanan KDV oranlari (formdaki secenekler; API 0-100 arasi tam sayi kabul eder). */
export const VAT_RATES = [20, 10, 1, 0] as const;

/** Sakin sorusu / yonetim yaniti: en az 3, en fazla 500 karakter (API ile ayni). */
export const COMMENT_MIN = 3;
export const COMMENT_MAX = 500;

function divRound(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export type QuoteAmounts = { netKurus: number; vatKurus: number; totalKurus: number };

/** Girilen tutari KDV dahil toplama cevirir (API ile ayni kural). */
export function normalizeQuote(amountKurus: number, vatIncluded: boolean, vatRate: number): QuoteAmounts {
  if (vatIncluded) {
    const netKurus = divRound(amountKurus * 100, 100 + vatRate);
    return { netKurus, vatKurus: amountKurus - netKurus, totalKurus: amountKurus };
  }
  const vatKurus = divRound(amountKurus * vatRate, 100);
  return { netKurus: amountKurus, vatKurus, totalKurus: amountKurus + vatKurus };
}

/** Baz puan -> "%12,5" (fark orani). */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `%${pct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
}

export type TenderAction = 'collect' | 'publish' | 'decide' | 'cancel';

/** API'deki gecis tablosuyla ayni: hangi dugmeler gosterilir. */
export function allowedActions(status: TenderStatus): TenderAction[] {
  switch (status) {
    case 'draft':
      return ['collect', 'cancel'];
    case 'collecting':
      return ['publish', 'cancel'];
    case 'published':
      return ['decide', 'cancel'];
    default:
      return [];
  }
}

export const canEditQuotes = (status: TenderStatus) => status === 'draft' || status === 'collecting';

export type ComparisonColumn = { quote: Quote; row: QuoteComparison['rows'][number] };

/**
 * Yan yana karsilastirma sutunlari: aktif teklifler KDV dahil toplama gore artan (API siralamasi),
 * geri cekilenler ayri listede (seffaflik: gerekceyle gosterilir).
 */
export function comparisonColumns(t: Pick<Tender, 'quotes' | 'comparison'>): { columns: ComparisonColumn[]; withdrawn: Quote[] } {
  const byId = new Map(t.quotes.map((q) => [q.quoteId, q]));
  const columns = t.comparison.rows.flatMap((row) => {
    const quote = byId.get(row.quoteId);
    return quote ? [{ quote, row }] : [];
  });
  return { columns, withdrawn: t.quotes.filter((q) => q.status === 'withdrawn') };
}

/** Yayin icin eksikler (yonetici ekrani): bos dizi = yayinlanabilir (asgari sayi alti gerekceyle). */
export function publishBlockers(t: Pick<Tender, 'readiness' | 'quotes'>): string[] {
  const r = t.readiness;
  if (!r) return [];
  const out: string[] = [];
  if (!r.activeQuotes) out.push('En az bir teklif ekleyin.');
  if (r.missingDocuments.length) {
    const names = r.missingDocuments.map((id) => t.quotes.find((q) => q.quoteId === id)?.supplierName ?? id);
    out.push(`Belgesi yüklenmemiş teklif: ${names.join(', ')}.`);
  }
  return out;
}

/** "Son gün: 15 Ara" yaninda kalan sure metni (Istanbul takvim gunleriyle). */
export function deadlineText(deadline: string, today: string): string {
  const days = Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return 'Süresi doldu';
  if (days === 0) return 'Son gün bugün';
  return `${days} gün kaldı`;
}

/** Teklif kosullari ozeti (kart / tablo hucresi). */
export function termsSummary(q: Pick<Quote, 'deliveryDays' | 'warrantyMonths' | 'validUntil'>, formatDate: (d: string) => string): string[] {
  const out: string[] = [];
  if (q.deliveryDays !== undefined) out.push(`İş süresi ${q.deliveryDays} gün`);
  if (q.warrantyMonths !== undefined) out.push(q.warrantyMonths ? `Garanti ${warrantyText(q.warrantyMonths)}` : 'Garanti yok');
  if (q.validUntil) out.push(`Geçerlilik ${formatDate(q.validUntil)}`);
  return out;
}

export function warrantyText(months: number): string {
  if (months % 12 === 0 && months >= 12) return `${months / 12} yıl`;
  return `${months} ay`;
}
