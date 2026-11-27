/*
 * Guvenlik kapisi - saf yardimcilar. Plaka kurallari API ile aynidir
 * (apps/api/src/modules/gate/model.ts); yetkinin ve dogrulamanin asli API'dedir.
 */
import { formatDate } from '@/lib/dates';

/** Bosluk / tire / nokta atilir, buyuk harf; Turkce `i` / `ı` / `İ` plakadaki Latin `I`. */
export function normalizePlate(input: string): string {
  return input
    .replace(/[ıİi]/g, 'I')
    .toUpperCase()
    .replace(/[\s.\-_/]/g, '');
}

const PLATE_RE = /^(0[1-9]|[1-7][0-9]|8[01])([ABCDEFGHIJKLMNOPRSTUVYZ]{1,3})([0-9]{2,5})$/;
const DIGITS_BY_LETTERS: Record<number, [number, number]> = { 1: [4, 5], 2: [3, 4], 3: [2, 3] };

/** Il kodu 01-81; 1 harf 4-5, 2 harf 3-4, 3 harf 2-3 rakam; Q, W, X ve Turkce harf yok. */
export function isTurkishPlate(plate: string): boolean {
  const m = PLATE_RE.exec(plate);
  if (!m) return false;
  const [min, max] = DIGITS_BY_LETTERS[(m[2] ?? '').length] ?? [0, -1];
  const digits = (m[3] ?? '').length;
  return digits >= min && digits <= max;
}

/** `34ABC123` -> `34 ABC 123`; Turk plakasi degilse oldugu gibi. */
export function formatPlate(plate: string): string {
  const m = PLATE_RE.exec(plate);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : plate;
}

/** Form dogrulamasi: hata metni veya `undefined`. */
export function plateError(input: string): string | undefined {
  const plate = normalizePlate(input);
  if (!plate) return 'Plaka girin';
  return isTurkishPlate(plate) ? undefined : 'Plaka Türkiye plaka biçiminde olmalıdır (örnek: 34 ABC 123)';
}

// ---------------------------------------------------------------------------
// QR jetonu / kisa kod
// ---------------------------------------------------------------------------

export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** `k7m2-pq4x` -> `K7M2PQ4X`; alfabe disi / eksikse `undefined`. */
export function normalizeShortCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 8 && [...code].every((c) => SHORT_CODE_ALPHABET.includes(c)) ? code : undefined;
}

/** `K7M2PQ4X` -> `K7M2-PQ4X` (okumasi ve yazmasi kolay). */
export const formatShortCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/**
 * Misafire gonderilen baglanti: `/gecis/<jeton>#<kod>`. Sayfa sunucuya hicbir sey sormaz; QR'i
 * tarayicida cizer. Kod parca (#) icinde: sunucu loglarina gitmez.
 */
export const passLink = (origin: string, token: string, shortCode?: string) => `${origin.replace(/\/$/, '')}/gecis/${encodeURIComponent(token)}${shortCode ? `#${shortCode}` : ''}`;

export type ScanResult = { token: string } | { code: string };

/** Okutulan QR / yazilan metin: gecis baglantisi, ham jeton veya kisa kod. */
export function parseScan(text: string): ScanResult | undefined {
  const raw = text.trim();
  const m = /\/gecis\/([A-Za-z0-9_-]{24})(?:[#?/]|$)/.exec(raw);
  if (m?.[1]) return { token: m[1] };
  if (TOKEN_RE.test(raw)) return { token: raw };
  const code = normalizeShortCode(raw);
  return code ? { code } : undefined;
}

// ---------------------------------------------------------------------------
// Etiketler
// ---------------------------------------------------------------------------

export type PassVerdict = 'valid' | 'not_yet_valid' | 'expired' | 'used' | 'revoked';
export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export const VERDICT_TEXT: Record<PassVerdict, { label: string; tone: Tone }> = {
  valid: { label: 'Geçerli', tone: 'success' },
  not_yet_valid: { label: 'Henüz başlamadı', tone: 'warning' },
  expired: { label: 'Süresi doldu', tone: 'danger' },
  used: { label: 'Kullanıldı', tone: 'neutral' },
  revoked: { label: 'İptal edildi', tone: 'danger' },
};

export type CourierState = 'waiting' | 'approved' | 'declined' | 'cancelled' | 'expired' | 'inside' | 'done';

/** Kurye kaydinin ekrandaki durumu (sunucu alanlarindan). */
export function courierState(c: { status: string; expired: boolean; enteredAt?: string; exitedAt?: string }): CourierState {
  if (c.exitedAt) return 'done';
  if (c.enteredAt) return 'inside';
  if (c.status === 'waiting') return c.expired ? 'expired' : 'waiting';
  return c.status as CourierState;
}

export const COURIER_TEXT: Record<CourierState, { label: string; tone: Tone }> = {
  waiting: { label: 'Onay bekliyor', tone: 'warning' },
  approved: { label: 'Onaylandı', tone: 'success' },
  declined: { label: 'Reddedildi', tone: 'danger' },
  cancelled: { label: 'Kapatıldı', tone: 'neutral' },
  expired: { label: 'Yanıt verilmedi', tone: 'neutral' },
  inside: { label: 'İçeride', tone: 'accent' },
  done: { label: 'Çıktı', tone: 'neutral' },
};

export const LOG_KIND_TEXT: Record<string, string> = { guest: 'Misafir', courier: 'Kurye', manual: 'Elle kayıt' };
export const DIRECTION_TEXT: Record<string, string> = { entry: 'Giriş', exit: 'Çıkış' };

/** "27 Kas 2026" veya "27 Kas 2026 – 29 Kas 2026". */
export const validityText = (from: string, until: string) => (from === until ? formatDate(from) : `${formatDate(from)} – ${formatDate(until)}`);
