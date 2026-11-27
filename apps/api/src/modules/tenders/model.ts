/**
 * Ihale - saf kurallar: KDV normalizasyonu (kurus, tam sayi aritmetigi), teklif karsilastirmasi ve
 * durum gecisleri. Depo / HTTP bagimliligi yoktur (testler dogrudan cagirir).
 */
import type { TenderQuote, TenderStatus } from './types.js';

/** Negatif olmayan tam sayilarda yarim yukari yuvarlamali bolme (kayan nokta yok). */
export function divRound(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export type QuoteAmounts = { netKurus: number; vatKurus: number; totalKurus: number };

/**
 * Teklifi KDV dahil toplama cevirir. KDV dahil girilen tutarda matrah geriye hesaplanir
 * (toplam = girilen, KDV = toplam - matrah); haric girilende KDV matrah uzerinden hesaplanir.
 * Kurus yuvarlamasi yarim yukari; `net + vat = total` her zaman tutar.
 */
export function normalizeQuote(q: Pick<TenderQuote, 'amountKurus' | 'vatIncluded' | 'vatRate'>): QuoteAmounts {
  if (q.vatIncluded) {
    const netKurus = divRound(q.amountKurus * 100, 100 + q.vatRate);
    return { netKurus, vatKurus: q.amountKurus - netKurus, totalKurus: q.amountKurus };
  }
  const vatKurus = divRound(q.amountKurus * q.vatRate, 100);
  return { netKurus: q.amountKurus, vatKurus, totalKurus: q.amountKurus + vatKurus };
}

export type ComparisonRow = QuoteAmounts & {
  quoteId: string;
  /** KDV dahil toplama gore sira (1 = en dusuk; esit tutarlar ayni sirayi alir). */
  rank: number;
  isLowest: boolean;
  /** En dusuk toplamdan fark (kurus) ve oran (baz puan: 1250 = %12,50). */
  diffKurus: number;
  diffBps: number;
};

export type QuoteComparison = {
  rows: ComparisonRow[];
  /** En dusuk KDV dahil toplam(lar); esitlikte birden fazla teklif. */
  lowestQuoteIds: string[];
  lowestTotalKurus?: number;
  highestTotalKurus?: number;
  /** En dusuk KDV haric (matrah) teklif: farkli KDV oranlarinda siralama degisebilir. */
  lowestNetQuoteIds: string[];
};

/**
 * Aktif teklifleri KDV dahil toplam uzerinden karsilastirir (geri cekilenler disarida). Satirlar
 * toplam artan, esitlikte giris sirasina gore.
 */
export function compareQuotes(quotes: readonly TenderQuote[]): QuoteComparison {
  const active = quotes.filter((q) => q.status === 'active');
  if (!active.length) return { rows: [], lowestQuoteIds: [], lowestNetQuoteIds: [] };
  const withAmounts = active.map((q, index) => ({ q, index, ...normalizeQuote(q) }));
  withAmounts.sort((a, b) => a.totalKurus - b.totalKurus || a.index - b.index);
  const lowest = withAmounts[0]?.totalKurus ?? 0;
  const highest = withAmounts[withAmounts.length - 1]?.totalKurus ?? 0;
  const lowestNet = Math.min(...withAmounts.map((r) => r.netKurus));
  let rank = 0;
  let prev: number | undefined;
  const rows: ComparisonRow[] = withAmounts.map((r, i) => {
    if (r.totalKurus !== prev) rank = i + 1;
    prev = r.totalKurus;
    const diffKurus = r.totalKurus - lowest;
    return {
      quoteId: r.q.quoteId,
      netKurus: r.netKurus,
      vatKurus: r.vatKurus,
      totalKurus: r.totalKurus,
      rank,
      isLowest: r.totalKurus === lowest,
      diffKurus,
      diffBps: lowest > 0 ? divRound(diffKurus * 10_000, lowest) : 0,
    };
  });
  return {
    rows,
    lowestQuoteIds: rows.filter((r) => r.isLowest).map((r) => r.quoteId),
    lowestTotalKurus: lowest,
    highestTotalKurus: highest,
    lowestNetQuoteIds: withAmounts.filter((r) => r.netKurus === lowestNet).map((r) => r.q.quoteId),
  };
}

export type TenderAction = 'collect' | 'publish' | 'decide' | 'cancel';

const TRANSITIONS: Record<TenderAction, { from: readonly TenderStatus[]; to: TenderStatus }> = {
  collect: { from: ['draft'], to: 'collecting' },
  publish: { from: ['collecting'], to: 'published' },
  decide: { from: ['published'], to: 'decided' },
  cancel: { from: ['draft', 'collecting', 'published'], to: 'cancelled' },
};

/** Gecis gecerliyse hedef durum, degilse undefined. */
export function nextStatus(current: TenderStatus, action: TenderAction): TenderStatus | undefined {
  const t = TRANSITIONS[action];
  return t.from.includes(current) ? t.to : undefined;
}

/** Durumdan izin verilen gecisler (web dugmeleri ile ayni kural). */
export function allowedActions(current: TenderStatus): TenderAction[] {
  return (Object.keys(TRANSITIONS) as TenderAction[]).filter((a) => nextStatus(current, a));
}

/**
 * Sakinlerle paylasilmis mi: bir kez yayinlanan ihale (sonra karara baglansa ya da iptal edilse de)
 * sakin ve denetciye gorunur kalir. Yayindan geri donus yoktur.
 */
export const isShared = (t: { publishedAt?: string }) => Boolean(t.publishedAt);

export type PublishReadiness = {
  activeQuotes: number;
  minQuotes: number;
  /** Belgesi olmayan aktif teklifler (yayin icin her teklifin belgesi gerekir). */
  missingDocuments: string[];
  /** Asgari teklif sayisina ulasilmadi: yayin icin gerekce gerekir. */
  shortfall: boolean;
};

export function publishReadiness(t: { minQuotes: number; quotes: readonly TenderQuote[] }): PublishReadiness {
  const active = t.quotes.filter((q) => q.status === 'active');
  return {
    activeQuotes: active.length,
    minQuotes: t.minQuotes,
    missingDocuments: active.filter((q) => !q.document).map((q) => q.quoteId),
    shortfall: active.length < t.minQuotes,
  };
}
