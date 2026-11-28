import type { OwnerRow, Share, ShareMove, TransferKind } from '@/lib/api/ownership';

/*
 * Hisse (pay / payda) yardimcilari - saf fonksiyonlar. API ile ayni kurallar
 * (apps/api/src/modules/ownership/shares.ts): kesir kaynak, BigInt rasyonel, bps yalnizca
 * gosterim ve en buyuk kalan yontemiyle toplam tam 10.000.
 */

export const BPS_TOTAL = 10_000;
export const MAX_SHARE_TERM = 1_000_000;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

type Frac = { n: bigint; d: bigint };
const norm = (f: Frac): Frac => {
  const g = gcd(f.n, f.d) || 1n;
  return { n: f.n / g, d: f.d / g };
};
const toFrac = (s: Share): Frac => norm({ n: BigInt(s.numerator), d: BigInt(s.denominator) });
const fromFrac = (f: Frac): Share => ({ numerator: Number(f.n), denominator: Number(f.d) });
const add = (a: Frac, b: Frac): Frac => norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a: Frac, b: Frac): Frac => norm({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const cmp = (a: Frac, b: Frac) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l === r ? 0 : l < r ? -1 : 1;
};

/** "1/3", "1 / 3", "1" (=1/1) -> kesir; gecersizse null. Pay > 0, pay <= payda <= 1.000.000. */
export function parseShare(input: string): Share | null {
  const t = input.trim();
  const m = /^(\d{1,7})\s*(?:\/\s*(\d{1,7}))?$/.exec(t);
  if (!m) return null;
  const numerator = Number(m[1]);
  const denominator = m[2] === undefined ? 1 : Number(m[2]);
  if (numerator < 1 || denominator < 1 || numerator > denominator || denominator > MAX_SHARE_TERM) return null;
  return fromFrac(toFrac({ numerator, denominator }));
}

export const formatShare = (s: Share) => `${s.numerator}/${s.denominator}`;

/** Paylarin toplami (sadelestirilmis). */
export function totalShare(shares: readonly Share[]): Share {
  let t: Frac = { n: 0n, d: 1n };
  for (const s of shares) t = add(t, toFrac(s));
  return t.n === 0n ? { numerator: 0, denominator: 1 } : fromFrac(t);
}

export function isCompleteTable(shares: readonly Share[]): boolean {
  const t = totalShare(shares);
  return t.numerator === t.denominator && t.numerator > 0;
}

/**
 * Baz puan (gosterim). Toplam tam 1 ise en buyuk kalan yontemiyle toplam tam 10.000
 * (1/3 -> 3334, 3333, 3333); degilse her pay kendi basina yarim yukari yuvarlanir.
 */
export function sharesToBps(shares: readonly Share[]): number[] {
  if (shares.length === 0) return [];
  if (!isCompleteTable(shares)) {
    return shares.map((s) => Number((BigInt(s.numerator) * BigInt(BPS_TOTAL) * 2n + BigInt(s.denominator)) / (2n * BigInt(s.denominator))));
  }
  const fracs = shares.map(toFrac);
  let lcm = 1n;
  for (const f of fracs) lcm = (lcm * f.d) / gcd(lcm, f.d);
  const weights = fracs.map((f) => f.n * (lcm / f.d));
  const sum = weights.reduce((s, w) => s + w, 0n);
  const total = BigInt(BPS_TOTAL);
  const base = weights.map((w) => (total * w) / sum);
  let remaining = total - base.reduce((s, b) => s + b, 0n);
  const order = weights.map((w, i) => ({ i, r: (total * w) % sum })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (remaining <= 0n) break;
    base[i] = (base[i] as bigint) + 1n;
    remaining -= 1n;
  }
  return base.map((b) => Number(b));
}

/** 3334 -> "%33,34" (tek tanim: packages/shared/src/api/polls.ts, web + mobil ortak). */
export { formatBps } from '@bm/shared/api/polls';

export const TRANSFER_KIND_LABELS: Record<TransferKind, string> = {
  sale_full: 'Tam satış',
  share_partial: 'Kısmi hisse devri',
  inheritance: 'Miras (intikal)',
};

export const TRANSFER_KIND_HINTS: Record<TransferKind, string> = {
  sale_full: 'Tüm malikler paylarının tamamını yeni malik(ler)e devreder.',
  share_partial: 'Bir veya birkaç paydaş payının bir kısmını ya da tamamını başkasına devreder.',
  inheritance: 'Vefat eden malikin payının tamamı mirasçılara geçer.',
};

export const BILLING_LABELS = { joint: 'Ortak cari', split: 'Paydaş carileri' } as const;
export const BILLING_HINTS = {
  joint: 'Malik borçları tek ortak cariye yazılır; paydaşlar birlikte sorumludur.',
  split: 'Malik tahakkukları paylara göre bölünür; her paydaş kendi carisini görür ve öder.',
} as const;

export type DraftMove = { fromUserId: string; toUserId: string; share: string };

/**
 * Taslak hareketleri dogrular ve sonuc tablosunu hesaplar (API'ye gitmeden geri bildirim; nihai
 * dogrulama API'de). Hata metni ya da { moves, after } doner.
 */
export function applyDraftMoves(
  before: readonly OwnerRow[],
  drafts: readonly DraftMove[],
  kind: TransferKind,
): { error: string } | { moves: ShareMove[]; after: { userId: string; share: Share }[] } {
  if (drafts.length === 0) return { error: 'En az bir pay hareketi ekleyin.' };
  const table = new Map<string, Frac>(before.map((o) => [o.userId, toFrac(o.share)]));
  const original = new Set(before.map((o) => o.userId));
  const moves: ShareMove[] = [];
  for (const [i, d] of drafts.entries()) {
    const n = i + 1;
    if (!d.fromUserId || !d.toUserId) return { error: `${n}. harekette devreden ve devralan seçilmeli.` };
    if (d.fromUserId === d.toUserId) return { error: `${n}. harekette devreden ile devralan aynı kişi olamaz.` };
    if (!original.has(d.fromUserId)) return { error: `${n}. harekette devreden mevcut bir paydaş olmalı.` };
    const share = parseShare(d.share);
    if (!share) return { error: `${n}. hareketin payı geçersiz (örn. 1/4).` };
    const cur = table.get(d.fromUserId) ?? { n: 0n, d: 1n };
    if (cmp(toFrac(share), cur) > 0) return { error: `${n}. harekette devredilen pay devredenin payını aşıyor.` };
    table.set(d.fromUserId, sub(cur, toFrac(share)));
    table.set(d.toUserId, add(table.get(d.toUserId) ?? { n: 0n, d: 1n }, toFrac(share)));
    moves.push({ fromUserId: d.fromUserId, toUserId: d.toUserId, share });
  }
  const after = [...table.entries()]
    .filter(([, f]) => f.n > 0n)
    .map(([userId, f]) => ({ userId, share: fromFrac(f) }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
  if (kind === 'sale_full' && after.some((o) => original.has(o.userId))) {
    return { error: 'Tam satışta mevcut maliklerin tüm payları devredilmeli.' };
  }
  if (kind === 'inheritance') {
    const givers = new Set(moves.map((m) => m.fromUserId));
    if (givers.size !== 1) return { error: 'Miras devrinde tek bir murisin payı devredilir.' };
    if (after.some((o) => givers.has(o.userId))) return { error: 'Murisin payının tamamı mirasçılara geçmeli.' };
  }
  return { moves, after };
}

/** Tam satis / miras icin hazir taslak: secilen devredenlerin TUM paylari tek devralana. */
export function fullShareDrafts(before: readonly OwnerRow[], fromUserIds: readonly string[], toUserId: string): DraftMove[] {
  return before.filter((o) => fromUserIds.includes(o.userId)).map((o) => ({ fromUserId: o.userId, toUserId, share: formatShare(o.share) }));
}
