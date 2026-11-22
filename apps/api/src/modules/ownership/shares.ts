/**
 * Finans 2.1 - Hisseli mulkiyet: pay (kesir) aritmetigi. SAF fonksiyonlar, I/O yok.
 *
 * Kurallar:
 *  - Payin kaynagi kesirdir (`pay / payda`, tapudaki gibi). 1/3 gibi paylar tam ifade edilir.
 *  - Hesaplar BigInt rasyonel ile yapilir; kayan nokta kullanilmaz.
 *  - Baz puan (bps, 10.000 = %100) YALNIZCA gosterim icindir ve en buyuk kalan yontemiyle
 *    turetilir: paylarin toplami 1 ise bps toplami her zaman tam 10.000'dir.
 *  - Tutar bolme (tahakkuk) `distributeKurus` ile ayni yontemdir: toplam KURUSUNA KADAR korunur.
 */
import { ValidationError, asObject, reqInt } from '../core/validation.js';

export type Share = { numerator: number; denominator: number };
export type OwnerShare = { userId: string; share: Share };

/** Sicildeki en fazla paydas: bolunmus tahakkuk tek islemde (en fazla 20 satir) yazilir. */
export const MAX_OWNERS = 18;
/** Kesir sinirlari (girdi). */
export const MAX_SHARE_TERM = 1_000_000;
/** Hesap sonucu kesirlerde payda ust siniri (asiri kucuk paylari engeller). */
export const MAX_DENOMINATOR = 1_000_000_000;
export const BPS_TOTAL = 10_000;

type Frac = { n: bigint; d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function norm(f: Frac): Frac {
  if (f.d === 0n) throw new Error('Payda sifir olamaz');
  const sign = f.d < 0n ? -1n : 1n;
  const g = gcd(f.n, f.d) || 1n;
  return { n: (sign * f.n) / g, d: (sign * f.d) / g };
}

const toFrac = (s: Share): Frac => norm({ n: BigInt(s.numerator), d: BigInt(s.denominator) });

function fromFrac(f: Frac): Share {
  const r = norm(f);
  if (r.d > BigInt(MAX_DENOMINATOR) || r.n > BigInt(Number.MAX_SAFE_INTEGER) || r.n < 0n) {
    throw new ValidationError('Pay hesabi cok kucuk parcalara bolunuyor (payda siniri asildi)', 'share');
  }
  return { numerator: Number(r.n), denominator: Number(r.d) };
}

const addF = (a: Frac, b: Frac): Frac => norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const subF = (a: Frac, b: Frac): Frac => norm({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const cmpF = (a: Frac, b: Frac): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l === r ? 0 : l < r ? -1 : 1;
};

/** Sadelestirilmis kesir (2/4 -> 1/2). */
export function reduceShare(s: Share): Share {
  return fromFrac(toFrac(s));
}

export function addShares(a: Share, b: Share): Share {
  return fromFrac(addF(toFrac(a), toFrac(b)));
}

/** a - b (sonuc negatif olamaz). */
export function subtractShare(a: Share, b: Share): Share {
  const r = subF(toFrac(a), toFrac(b));
  if (r.n < 0n) throw new ValidationError('Devredilen pay, devredenin payindan buyuk olamaz', 'share');
  return r.n === 0n ? { numerator: 0, denominator: 1 } : fromFrac(r);
}

export function compareShares(a: Share, b: Share): number {
  return cmpF(toFrac(a), toFrac(b));
}

export const isZeroShare = (s: Share) => s.numerator === 0;

export function sumShares(shares: readonly Share[]): Share {
  let total: Frac = { n: 0n, d: 1n };
  for (const s of shares) total = addF(total, toFrac(s));
  return total.n === 0n ? { numerator: 0, denominator: 1 } : fromFrac(total);
}

/** Toplam tam 1 mi? (tamlik kurali) */
export function isComplete(shares: readonly Share[]): boolean {
  let total: Frac = { n: 0n, d: 1n };
  for (const s of shares) total = addF(total, toFrac(s));
  return total.n === total.d;
}

/** Girdi dogrulamasi: `{ numerator, denominator }`, 1 <= pay <= payda <= 1.000.000. */
export function parseShare(value: unknown, field = 'share'): Share {
  const o = asObject(value, field);
  const numerator = reqInt(o, 'numerator', 1, MAX_SHARE_TERM);
  const denominator = reqInt(o, 'denominator', 1, MAX_SHARE_TERM);
  if (numerator > denominator) throw new ValidationError(`${field}: pay paydadan buyuk olamaz`, field);
  return reduceShare({ numerator, denominator });
}

/**
 * Paylarin ortak paydaya genisletilmis tam sayi agirliklari: oranlar birebir korunur
 * (ornegin 1/2, 1/3, 1/6 -> 3, 2, 1). `distributeKurus` girdisi.
 */
export function shareWeights(shares: readonly Share[]): bigint[] {
  if (shares.length === 0) return [];
  const fracs = shares.map(toFrac);
  let lcm = 1n;
  for (const f of fracs) lcm = (lcm * f.d) / gcd(lcm, f.d);
  return fracs.map((f) => f.n * (lcm / f.d));
}

/**
 * En buyuk kalan yontemi (BigInt): `total` agirliklarla bolunur, toplam KURUSUNA KADAR korunur.
 * Esitlikte dizin sirasi (girdi sirasi) kazanir. (Finans servisindeki `distributeKurus` ile ayni
 * algoritma; bu modul finansa bagimli olmasin diye burada da tanimlidir.)
 */
export function largestRemainder(total: number, weights: readonly bigint[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Gecersiz toplam: ${total}`);
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (weights.length === 0) return [];
  if (sum <= 0n) throw new Error('Agirlik toplami pozitif olmali');
  const t = BigInt(total);
  const base = weights.map((w) => (t * w) / sum);
  let remaining = t - base.reduce((s, b) => s + b, 0n);
  const order = weights.map((w, i) => ({ i, r: (t * w) % sum })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (remaining <= 0n) break;
    base[i] = (base[i] as bigint) + 1n;
    remaining -= 1n;
  }
  return base.map((b) => Number(b));
}

/** Gosterim: paylarin baz puan karsiliklari (toplam tam 1 ise toplam tam 10.000). */
export function toBps(shares: readonly Share[]): number[] {
  if (shares.length === 0) return [];
  if (!isComplete(shares)) {
    // Eksik/fazla tabloda her pay kendi basina yuvarlanir (yarim yukari); toplam 10.000 olmayabilir.
    return shares.map((s) => Number((BigInt(s.numerator) * BigInt(BPS_TOTAL) * 2n + BigInt(s.denominator)) / (2n * BigInt(s.denominator))));
  }
  return largestRemainder(BPS_TOTAL, shareWeights(shares));
}

/** Tutarin paylara gore bolunmesi (kurus kaybi yok). Sira `owners` sirasidir. */
export function splitAmountByShares(amount: number, owners: readonly OwnerShare[]): { userId: string; amount: number }[] {
  const parts = largestRemainder(amount, shareWeights(owners.map((o) => o.share)));
  return owners.map((o, i) => ({ userId: o.userId, amount: parts[i] ?? 0 }));
}

/** "1/3" bicimi (gosterim / hata mesajlari). */
export const formatShare = (s: Share) => `${s.numerator}/${s.denominator}`;

/** Kanonik siralama: kullanici kimligine gore (deterministik bolme ve karsilastirma). */
export function sortOwners(owners: readonly OwnerShare[]): OwnerShare[] {
  return [...owners].sort((a, b) => a.userId.localeCompare(b.userId));
}

/**
 * Pay tablosu dogrulamasi: bos olamaz, tekrar yok, her pay > 0, en fazla MAX_OWNERS, toplam tam 1.
 */
export function assertCompleteTable(owners: readonly OwnerShare[], field = 'owners'): void {
  if (owners.length === 0) throw new ValidationError('Pay tablosunda en az bir malik olmalidir', field);
  if (owners.length > MAX_OWNERS) throw new ValidationError(`Bir bagimsiz bolumde en fazla ${MAX_OWNERS} paydas olabilir`, field);
  const seen = new Set<string>();
  for (const o of owners) {
    if (seen.has(o.userId)) throw new ValidationError(`Ayni malik iki kez yazilmis: ${o.userId}`, field);
    seen.add(o.userId);
    if (o.share.numerator < 1 || o.share.numerator > o.share.denominator) {
      throw new ValidationError(`Gecersiz pay: ${formatShare(o.share)}`, field);
    }
  }
  if (!isComplete(owners.map((o) => o.share))) {
    const total = sumShares(owners.map((o) => o.share));
    throw new ValidationError(`Paylarin toplami tam 1 olmali (simdiki toplam ${formatShare(total)})`, field);
  }
}

/** Iki pay tablosu ayni mi? (kanonik, sadelestirilmis karsilastirma) */
export function sameTable(a: readonly OwnerShare[], b: readonly OwnerShare[]): boolean {
  if (a.length !== b.length) return false;
  const x = sortOwners(a);
  const y = sortOwners(b);
  return x.every((o, i) => o.userId === y[i]?.userId && compareShares(o.share, (y[i] as OwnerShare).share) === 0);
}
