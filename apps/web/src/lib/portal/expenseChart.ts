import type { ExpenseBreakdown, ExpenseCategory } from '@/lib/api/portal';

/**
 * Adim 3 - gider halka grafigi (saf yardimcilar; DOM yok).
 *
 * Renk kategoriye baglidir, siraya degil (filtre / ay degisince ayni kategori ayni renkte kalir).
 * 7 kategorik renk + notr gri "Diger" (theme.css `--color-series-*`; validate_palette ile dogrulandi).
 */
export const CATEGORY_COLOR: Readonly<Record<ExpenseCategory, string>> = {
  electricity: 'var(--color-series-1)',
  water: 'var(--color-series-2)',
  heating: 'var(--color-series-3)',
  cleaning: 'var(--color-series-4)',
  maintenance: 'var(--color-series-5)',
  security: 'var(--color-series-6)',
  garden: 'var(--color-series-7)',
  other: 'var(--color-series-other)',
};

/** Istanbul saatine gore bu ay (YYYY-AA). */
export function currentIstanbulMonth(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit' }).format(now).slice(0, 7);
}

/** "2026-11" -> "Kasım 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** "%12,5" bicimi (Turkce ondalik virgul; tam sayida ondalik yok). */
export function formatShare(shareBp: number): string {
  const v = shareBp / 100;
  return `%${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(Math.round(v * 10) / 10)}`;
}

export type DonutSegment = {
  category: ExpenseCategory;
  /** Halka uzerindeki baslangic (cevre uzunlugu birimi). */
  offset: number;
  /** Cizilen uzunluk (bosluk dusulmus). */
  length: number;
  color: string;
};

/**
 * Halka dilimleri: `stroke-dasharray` ile cizilir. Dilimler arasinda `gap` kadar bosluk (yuzey
 * rengi gorunur); tek dilimde bosluk yok. Cok kucuk dilim de en az 1 birim gorunur.
 */
export function donutSegments(items: ExpenseBreakdown['items'], circumference: number, gap = 2): DonutSegment[] {
  const total = items.reduce((s, i) => s + i.shareBp, 0);
  if (total <= 0) return [];
  const useGap = items.filter((i) => i.shareBp > 0).length > 1 ? gap : 0;
  let start = 0;
  return items
    .filter((i) => i.shareBp > 0)
    .map((i) => {
      const full = (i.shareBp / total) * circumference;
      const seg = { category: i.category, offset: start, length: Math.max(1, full - useGap), color: CATEGORY_COLOR[i.category] };
      start += full;
      return seg;
    });
}
