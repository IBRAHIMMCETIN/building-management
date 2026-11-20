/**
 * Odeme secimi (saf fonksiyonlar). API kurali (Karar A): secili kalem odemesinde, her alt cari
 * icin secilen kalemler en eski vadeden baslayan KESINTISIZ bir dizi olmalidir (defter tahsilati
 * en eski anaparaya mahsup eder). Bu yuzden secim, alt cari basina "ilk N kalem" olarak tutulur:
 * bir kalemi secmek ondan eskileri de secer, birakmak ondan yenileri de birakir. Kullanici gecersiz
 * bir secim yapamaz.
 */
import type { LiableParty, PaymentQuote } from '@/lib/api/payments';

/** Alt cari basina secili (en eskiden) kalem sayisi. */
export type ItemSelection = Partial<Record<LiableParty, number>>;

export const isSelected = (sel: ItemSelection, party: LiableParty, index: number) => index < (sel[party] ?? 0);

/** `index`. kalemin onay kutusu degisti: secilirse ondan eskiler de, birakilirsa ondan yeniler de. */
export function toggleItem(sel: ItemSelection, party: LiableParty, index: number, checked: boolean): ItemSelection {
  const count = sel[party] ?? 0;
  const next = checked ? Math.max(count, index + 1) : Math.min(count, index);
  return { ...sel, [party]: next };
}

/** API'ye gidecek secim (alt cari sirasi korunur). */
export function selectedItems(quote: PaymentQuote, sel: ItemSelection) {
  return quote.parties.flatMap((p) =>
    p.items.slice(0, sel[p.liableParty] ?? 0).map((it) => ({ liableParty: p.liableParty, transactionId: it.transactionId })),
  );
}

/** Secili kalemlerin kalan tutarlari toplami (kurus). Tazminat eklenmez. */
export function selectedTotal(quote: PaymentQuote, sel: ItemSelection): number {
  return quote.parties.reduce(
    (sum, p) => sum + p.items.slice(0, sel[p.liableParty] ?? 0).reduce((s, it) => s + it.remaining, 0),
    0,
  );
}

/** Odenecek alt cari sayisi: birden fazlaysa her biri icin ayri makbuz duzenlenir. */
export function receiptCount(quote: PaymentQuote, mode: 'total' | 'items', sel: ItemSelection): number {
  if (mode === 'total') return quote.parties.filter((p) => p.totalDue > 0).length;
  return quote.parties.filter((p) => (sel[p.liableParty] ?? 0) > 0).length;
}

// ---------------------------------------------------------------------------
// Alici bilgisi (yalnizca canli saglayicida istenir; saklanmaz)
// ---------------------------------------------------------------------------

/** API ile ayni kural: 05xx / 5xx / +905xx -> +905xxxxxxxxx; gecersizse null. */
export function normalizeGsm(value: string): string | null {
  const digits = value.replace(/[\s()-]/g, '');
  const m = /^(?:\+?90|0)?(5\d{9})$/.exec(digits);
  return m ? `+90${m[1]}` : null;
}

/** T.C. kimlik numarasi: 11 hane, ilk hane 0 degil, resmi kontrol haneleri. */
export function isValidTckn(value: string): boolean {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const d = value.split('').map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = d.slice(0, 10).reduce((s, x) => s + x, 0) % 10;
  return d[9] === d10 && d[10] === d11;
}
