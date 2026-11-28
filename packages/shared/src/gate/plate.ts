/*
 * Guvenlik kapisi - gorevli masasinin saf yardimcilari (web: apps/web/src/lib/gate/plate.ts ile ayni
 * kurallar; API: apps/api/src/modules/gate/model.ts). Plaka, kisa kod gosterimi, karar / gunluk
 * etiketleri ve tarih yardimcilari tek kaynaktan (../api/portalGate.ts) yeniden dışa aktarilir; burada
 * yalnizca okutma (QR / kisa kod ayristirma), kurye durumu ve masaya ozgu sabitler vardir.
 */
export {
  DIRECTION_TEXT,
  type GateTone,
  LOG_KIND_TEXT,
  type PassVerdict,
  VERDICT_TEXT,
  formatPlate,
  formatShortCode,
  normalizePlate,
  timeOf,
  validityText,
} from '../api/portalGate';
import type { GateTone } from '../api/portalGate';

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
// Kurye (gorevli gorunumu)
// ---------------------------------------------------------------------------

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

/** Istanbul gunu (YYYY-MM-DD) ve gun ekleme: tek kaynak takvim yardimcilari. */
export { addDays, istanbulToday as istanbulDay } from '../reservations/model';
