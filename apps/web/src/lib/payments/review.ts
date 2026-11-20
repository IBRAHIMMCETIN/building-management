/**
 * Platform: inceleme sonuclandirma ekraninin saf yardimcilari (API: payments/service.ts resolveReview).
 */
import type { ProviderCheck, ReviewIntent } from '@/lib/api/payments';

/** API ile ayni gerekce siniri. */
export const NOTE_MIN = 5;
export const NOTE_MAX = 500;

export function noteError(note: string): string | undefined {
  const n = note.trim().length;
  if (n < NOTE_MIN) return `Gerekçe en az ${NOTE_MIN} karakter olmalı.`;
  if (n > NOTE_MAX) return `Gerekçe en fazla ${NOTE_MAX} karakter olabilir.`;
  return undefined;
}

export type RefundProgress = { total: number; done: number; failed: number; refunded: number; amount: number };

export function refundProgress(refund: ReviewIntent['refund']): RefundProgress | undefined {
  if (!refund) return undefined;
  const done = refund.items.filter((i) => i.status === 'succeeded');
  return {
    total: refund.items.length,
    done: done.length,
    failed: refund.items.filter((i) => i.status === 'failed').length,
    refunded: done.reduce((sum, i) => sum + i.amount, 0),
    amount: refund.items.reduce((sum, i) => sum + i.amount, 0),
  };
}

const CHECK_STATUS: Record<ProviderCheck['status'], string> = {
  success: 'Sağlayıcıda başarılı çekim var',
  failure: 'Sağlayıcıda başarılı çekim yok',
  pending: 'Sağlayıcıda sonuç henüz kesinleşmedi',
};

export const providerCheckLabel = (c: ProviderCheck) => CHECK_STATUS[c.status];
