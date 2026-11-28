/*
 * Guvenlik kapisi - saf yardimcilar (web: apps/web/src/lib/gate/plate.ts ile ayni kurallar; API:
 * apps/api/src/modules/gate/model.ts). Yetkinin ve dogrulamanin asli API'dedir. Web dosyasi paralel
 * kapi dallari birlesince buraya yeniden dışa aktarıma çevrilebilir.
 */
import { formatDate } from '../dates';

/** Bosluk / tire / nokta atilir, buyuk harf; Turkce `i` / `ı` / `İ` plakadaki Latin `I`. */
export function normalizePlate(input: string): string {
  return input
    .replace(/[ıİi]/g, 'I')
    .toUpperCase()
    .replace(/[\s.\-_/]/g, '');
}

const PLATE_RE = /^(0[1-9]|[1-7][0-9]|8[01])([ABCDEFGHIJKLMNOPRSTUVYZ]{1,3})([0-9]{2,5})$/;

/** `34ABC123` -> `34 ABC 123`; Turk plakasi degilse oldugu gibi. */
export function formatPlate(plate: string): string {
  const m = PLATE_RE.exec(plate);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : plate;
}

/** Plaka sorgusu icin en az karakter (API: tam plaka veya son >= 3 karakter). */
export const PLATE_MIN_QUERY = 3;

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

export type ScanResult = { token: string } | { code: string };

/** Okutulan QR / yazilan metin: gecis baglantisi (`/gecis/<jeton>#<kod>`), ham jeton veya kisa kod. */
export function parseScan(text: string): ScanResult | undefined {
  const raw = text.trim();
  const m = /\/gecis\/([A-Za-z0-9_-]{24})(?:[#?/]|$)/.exec(raw);
  if (m?.[1]) return { token: m[1] };
  if (TOKEN_RE.test(raw)) return { token: raw };
  const code = normalizeShortCode(raw);
  return code ? { code } : undefined;
}

export const UNKNOWN_CODE_MESSAGE = 'Kod tanınmadı. 8 karakterlik kısa kodu (örnek: K7M2-PQ4X) yazın.';

// ---------------------------------------------------------------------------
// Etiketler
// ---------------------------------------------------------------------------

export type PassVerdict = 'valid' | 'not_yet_valid' | 'expired' | 'used' | 'revoked' | 'host_left';
export type GateTone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export const VERDICT_TEXT: Record<PassVerdict, { label: string; tone: GateTone }> = {
  valid: { label: 'Geçerli', tone: 'success' },
  not_yet_valid: { label: 'Henüz başlamadı', tone: 'warning' },
  expired: { label: 'Süresi doldu', tone: 'danger' },
  used: { label: 'Kullanıldı', tone: 'neutral' },
  revoked: { label: 'İptal edildi', tone: 'danger' },
  host_left: { label: 'Ev sahibi taşındı', tone: 'danger' },
};

export type CourierState = 'waiting' | 'approved' | 'approval_expired' | 'declined' | 'cancelled' | 'expired' | 'inside' | 'done';

/** Kurye kaydinin ekrandaki durumu (sunucu alanlarindan). */
export function courierState(c: { status: string; expired: boolean; approvalExpired?: boolean; enteredAt?: string; exitedAt?: string }): CourierState {
  if (c.exitedAt) return 'done';
  if (c.enteredAt) return 'inside';
  if (c.status === 'waiting') return c.expired ? 'expired' : 'waiting';
  if (c.status === 'approved' && c.approvalExpired) return 'approval_expired';
  return c.status as CourierState;
}

export const COURIER_TEXT: Record<CourierState, { label: string; tone: GateTone }> = {
  waiting: { label: 'Onay bekliyor', tone: 'warning' },
  approved: { label: 'Onaylandı', tone: 'success' },
  approval_expired: { label: 'Onay süresi doldu', tone: 'neutral' },
  declined: { label: 'Reddedildi', tone: 'danger' },
  cancelled: { label: 'Kapatıldı', tone: 'neutral' },
  expired: { label: 'Yanıt verilmedi', tone: 'neutral' },
  inside: { label: 'İçeride', tone: 'accent' },
  done: { label: 'Çıktı', tone: 'neutral' },
};

/** Gorevlinin kapidaki kurye hizli secimleri (web CourierDesk ile ayni). */
export const COURIER_COMPANIES = ['Trendyol', 'Hepsiburada', 'Amazon', 'Getir', 'Yemeksepeti', 'Yurtiçi', 'Aras', 'MNG', 'PTT'] as const;

export const LOG_KIND_TEXT: Record<string, string> = { guest: 'Misafir', courier: 'Kurye', manual: 'Elle kayıt' };
export const DIRECTION_TEXT: Record<string, string> = { entry: 'Giriş', exit: 'Çıkış' };

/** "27 Kas 2026" veya "27 Kas 2026 – 29 Kas 2026". */
export const validityText = (from: string, until: string) => (from === until ? formatDate(from) : `${formatDate(from)} – ${formatDate(until)}`);

/** Saat:dakika (Istanbul). */
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });

/** Istanbul gunu (YYYY-MM-DD). */
export function istanbulDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

/** `YYYY-MM-DD` + n gun. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
