/**
 * Guvenlik kapisi - saf kurallar (I/O yok): plaka normalizasyonu ve dogrulamasi, kisa kod,
 * gecis karari ve Istanbul takvim yardimcilari. Web tarafindaki kopya: apps/web/src/lib/gate/plate.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IsoDate, IsoDateTime } from '../core/types.js';
import type { GuestPass, PassVerdict } from './types.js';

// ---------------------------------------------------------------------------
// Plaka
// ---------------------------------------------------------------------------

/**
 * Bosluk, tire ve noktayi atar; buyuk harfe cevirir. Turkce klavyeden gelen `i` / `ı` / `İ`
 * plakadaki Latin `I` sayilir. Diger karakterler korunur (dogrulama reddeder).
 */
export function normalizePlate(input: string): string {
  return input
    .replace(/[ıİi]/g, 'I')
    .toUpperCase()
    .replace(/[\s.\-_/]/g, '');
}

/** Turk plaka harfleri: Q, W, X ve Turkce harfler kullanilmaz. */
const PLATE_LETTERS = 'ABCDEFGHIJKLMNOPRSTUVYZ';
const PLATE_RE = new RegExp(`^(0[1-9]|[1-7][0-9]|8[01])([${PLATE_LETTERS}]{1,3})([0-9]{2,5})$`);

/**
 * Turk plakasi mi (normalize edilmis)? Il kodu 01-81; harf sayisina gore rakam sayisi:
 * 1 harf -> 4-5 rakam, 2 harf -> 3-4 rakam, 3 harf -> 2-3 rakam (34 A 1234, 34 AB 123, 34 ABC 12).
 */
export function isTurkishPlate(plate: string): boolean {
  const m = PLATE_RE.exec(plate);
  if (!m) return false;
  const letters = (m[2] ?? '').length;
  const digits = (m[3] ?? '').length;
  const range: Record<number, [number, number]> = { 1: [4, 5], 2: [3, 4], 3: [2, 3] };
  const [min, max] = range[letters] ?? [0, -1];
  return digits >= min && digits <= max;
}

/** `34ABC123` -> `34 ABC 123` (gosterim). Turk plakasi degilse oldugu gibi. */
export function formatPlate(plate: string): string {
  const m = PLATE_RE.exec(plate);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : plate;
}

/** Sondan eslesme icin ters yazim (`34ABC123` -> `321CBA43`). */
export const reversePlate = (plate: string) => [...plate].reverse().join('');

/** Arama girdisi: harf/rakam disi atilir. Kisa veya gecersiz sorgu `undefined`. */
export function plateQuery(input: string, min: number): string | undefined {
  const q = normalizePlate(input);
  return /^[A-Z0-9]+$/.test(q) && q.length >= min && q.length <= 9 ? q : undefined;
}

// ---------------------------------------------------------------------------
// Jeton ve kisa kod
// ---------------------------------------------------------------------------

/** Karisan karakterler (0/O, 1/I/L) yok: 8 rakam + 23 harf = 31 sembol; 8 karakter ~ 39,6 bit. */
export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHORT_CODE_LENGTH = 8;

/** 256'yi bolmeyen alfabe icin reddetmeli ornekleme (modulo yanliligi yok). */
export function newShortCode(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const size = SHORT_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let out = '';
  while (out.length < SHORT_CODE_LENGTH) {
    for (const b of random(16)) {
      if (b < limit && out.length < SHORT_CODE_LENGTH) out += SHORT_CODE_ALPHABET[b % size];
    }
  }
  return out;
}

/** Gorevlinin yazdigi kod: bosluk / tire atilir, buyuk harf; alfabe disiysa `undefined`. */
export function normalizeShortCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== SHORT_CODE_LENGTH) return undefined;
  return [...code].every((ch) => SHORT_CODE_ALPHABET.includes(ch)) ? code : undefined;
}

/** QR jetonu: 18 rastgele bayt (144 bit), URL-guvenli base64 (24 karakter). */
export const newPassToken = (): string => randomBytes(18).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** Jeton anahtarda acik yazilmaz: dizin anahtari jetonun SHA-256 ozetidir. */
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// ---------------------------------------------------------------------------
// Istanbul takvimi (Turkiye 2016'dan beri sabit UTC+03:00)
// ---------------------------------------------------------------------------

export const istanbulDay = (now: Date): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);

/** Istanbul gununun baslangici (UTC ISO). */
export const istanbulDayStart = (day: IsoDate): IsoDateTime => new Date(`${day}T00:00:00+03:00`).toISOString();

export function addDays(day: IsoDate, days: number): IsoDate {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Iki uc dahil gun sayisi. */
export const daySpan = (from: IsoDate, until: IsoDate) => Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Dizin kayitlarinin TTL'i: gecerliligin bittigi gunun sonundan `graceDays` sonra (epoch sn). */
export const indexTtl = (validUntil: IsoDate, graceDays: number) => Math.floor(Date.parse(istanbulDayStart(addDays(validUntil, 1 + graceDays))) / 1000);

// ---------------------------------------------------------------------------
// Gecis karari
// ---------------------------------------------------------------------------

/** Iptal > kullanildi > suresi doldu > henuz baslamadi > gecerli. */
export function passVerdict(p: Pick<GuestPass, 'status' | 'validFrom' | 'validUntil'>, today: IsoDate): PassVerdict {
  if (p.status === 'revoked') return 'revoked';
  if (p.status === 'used') return 'used';
  if (today > p.validUntil) return 'expired';
  if (today < p.validFrom) return 'not_yet_valid';
  return 'valid';
}

export const VERDICT_MESSAGES: Record<Exclude<PassVerdict, 'valid'>, string> = {
  revoked: 'Bu geçiş daire sakini veya yönetim tarafından iptal edildi',
  used: 'Bu tek girişlik geçiş daha önce kullanıldı',
  expired: 'Bu geçişin süresi doldu',
  not_yet_valid: 'Bu geçiş henüz başlamadı',
};

/**
 * Giris yalnizca karar `valid` iken (tek girislikte hic kullanilmamis); cikis misafir icerideyse
 * her zaman kaydedilebilir (gece yarisini gecen ziyaret, iceride iken iptal edilen gecis).
 */
export function passActions(p: Pick<GuestPass, 'status' | 'validFrom' | 'validUntil' | 'inside'>, today: IsoDate) {
  return { canEnter: passVerdict(p, today) === 'valid', canExit: p.inside };
}
