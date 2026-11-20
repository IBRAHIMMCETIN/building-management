/**
 * Yonetici / platform odeme ekranlari icin saf yardimcilar (etiket, ton, oran bicimi, IBAN).
 */
import type { AccountSummary, IntentStatus } from '@/lib/api/payments';

export type Tone = 'neutral' | 'success' | 'warning' | 'accent' | 'danger';

const STATUS: Record<IntentStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Bekliyor', tone: 'neutral' },
  SUCCEEDED: { label: 'Başarılı', tone: 'success' },
  FAILED: { label: 'Başarısız', tone: 'danger' },
  NEEDS_REVIEW: { label: 'İnceleme gerekli', tone: 'warning' },
};

export const intentStatusLabel = (s: IntentStatus) => STATUS[s].label;
export const intentStatusTone = (s: IntentStatus) => STATUS[s].tone;

/** Baz puan -> "%1,5" (10000 bp = %100). */
export function formatBasisPoints(bp: number): string {
  return `%${(bp / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;
}

/** API ile ayni ust sinir (payments/types.ts MAX_PLATFORM_FEE_BASIS_POINTS = %20). */
export const MAX_PLATFORM_FEE_BASIS_POINTS = 2_000;

/** "%1,5" / "1.5" / "1,5" -> 150 baz puan; gecersiz ya da [0, maxBp] disi ise null. */
export function parsePercentToBasisPoints(input: string, maxBp = MAX_PLATFORM_FEE_BASIS_POINTS): number | null {
  const s = input.trim().replace(/^%/, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp <= maxBp ? bp : null;
}

export type AccountView = { tone: Tone; label: string; body: string };

export function accountStatusView(a: AccountSummary): AccountView {
  if (!a.configured) {
    return { tone: 'neutral', label: 'Kapalı', body: 'Platformda online ödeme sağlayıcısı yapılandırılmamış.' };
  }
  switch (a.status) {
    case 'active':
      return {
        tone: 'success',
        label: 'Aktif',
        body: 'Sakinler borçlarını kartla online ödeyebilir; tahsilat apartmanın IBAN hesabına aktarılır.',
      };
    case 'disabled':
      return { tone: 'warning', label: 'Durduruldu', body: 'Online ödeme geçici olarak kapatıldı. Açtırmak için platform yöneticisiyle görüşün.' };
    default:
      return {
        tone: 'neutral',
        label: 'Kayıtlı değil',
        body: 'Apartmanın ödeme hesabı (alt üye işyeri) henüz açılmadı. Kayıt platform yöneticisi tarafından yapılır.',
      };
  }
}

/** TR IBAN: "TR" + 24 hane, mod-97 = 1. Bosluklar yok sayilir. */
export function normalizeIban(value: string): string | null {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^TR\d{24}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? iban : null;
}
