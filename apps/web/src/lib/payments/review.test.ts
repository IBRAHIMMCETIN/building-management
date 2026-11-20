import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { reviewCheckSchema } from '@/lib/api/payments';
import { intentResultView, TERMINAL_STATUSES } from './result';
import { intentStatusLabel, intentStatusTone, REVIEW_ACTION_LABELS } from './manager';
import { noteError, providerCheckLabel, refundProgress } from './review';

const item = (status: 'pending' | 'succeeded' | 'failed', amount: number) => ({
  paymentTransactionId: `t-${amount}`,
  itemId: `i-${amount}`,
  amount,
  status,
  attempts: 1,
});

describe('inceleme sonuclandirma yardimcilari', () => {
  it('gerekce siniri API ile ayni (5-500)', () => {
    expect(noteError('kısa')).toMatch(/en az 5/);
    expect(noteError('   yeter   ')).toBeUndefined();
    expect(noteError('x'.repeat(501))).toMatch(/en fazla 500/);
  });

  it('iade ilerlemesi: tamamlanan, reddedilen ve iade edilen tutar', () => {
    expect(refundProgress(undefined)).toBeUndefined();
    expect(
      refundProgress({ items: [item('succeeded', 600_00), item('failed', 400_00)], requestedAt: 't', requestedBy: 'ops' }),
    ).toEqual({ total: 2, done: 1, failed: 1, refunded: 600_00, amount: 1000_00 });
  });

  it('yeni durumlar: etiket, ton, sakin metni; iade edilen odeme tekrar odenebilir', () => {
    expect(intentStatusLabel('REFUND_PENDING')).toBe('İade sürüyor');
    expect(intentStatusTone('REFUND_PENDING')).toBe('warning');
    expect(intentStatusLabel('REFUNDED')).toBe('İade edildi');
    expect(TERMINAL_STATUSES).toEqual(expect.arrayContaining(['REFUND_PENDING', 'REFUNDED']));
    expect(intentResultView({ status: 'REFUND_PENDING' })).toMatchObject({ tone: 'warning', terminal: true, canRetry: false });
    expect(intentResultView({ status: 'REFUNDED' })).toMatchObject({ terminal: true, canRetry: true });
    expect(REVIEW_ACTION_LABELS.refund.label).toBe('Tam iade et');
  });

  it('kontrol yaniti semasi ve saglayici etiketi', () => {
    const parsed = reviewCheckSchema.parse({
      intent: {
        intentId: 'PI1',
        status: 'NEEDS_REVIEW',
        mode: 'total',
        unitId: 'u1',
        userId: 'tenant-1',
        currency: 'TRY',
        amount: 1000_00,
        platformFee: 0,
        allocations: [{ liableParty: 'occupant', principal: 1000_00, lateFee: 0, amount: 1000_00 }],
        provider: 'iyzico',
        review: { reason: 'tutar uyusmuyor', at: 't' },
        apartmentId: 'apt-1',
        version: 3,
        createdAt: 't',
        updatedAt: 't',
      },
      check: { status: 'success', paidAmount: 999_00, problems: ['tutar uyusmuyor'], checkedAt: 't' },
      actions: [
        { action: 'approve', allowed: false, reason: 'Doğrulama tutmuyor' },
        { action: 'refund', allowed: true },
        { action: 'close', allowed: false },
      ],
    });
    expect(parsed.intent.version).toBe(3);
    expect(providerCheckLabel(parsed.check!)).toBe('Sağlayıcıda başarılı çekim var');
    expect(() => reviewCheckSchema.parse({ ...parsed, actions: [{ action: 'sil', allowed: true }] })).toThrow();
  });
});
