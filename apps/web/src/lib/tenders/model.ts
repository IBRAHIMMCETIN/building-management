import type { Quote, QuoteComparison, Tender, TenderCategory, TenderStatus } from '@/lib/api/tenders';

/*
 * Ihale ekranlarinin saf yardimcilari. KDV normalizasyonu API ile birebir aynidir
 * (apps/api/src/modules/tenders/model.ts): kurus tam sayi, yarim yukari yuvarlama; form onizlemesi
 * kaydedilecek toplamla ayni cikar.
 */

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
