import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { TERMINAL_STATUSES, callbackErrorView, intentResultView, partyLabel } from './result';

describe('odeme sonuc metinleri', () => {
  it('basari / hata / inceleme kesin; hata tekrar denenebilir', () => {
    expect(intentResultView({ status: 'SUCCEEDED' })).toMatchObject({ tone: 'success', terminal: true, canRetry: false });
    const failed = intentResultView({ status: 'FAILED', failureMessage: 'Kart limiti yetersiz.' });
    expect(failed).toMatchObject({ tone: 'danger', terminal: true, canRetry: true });
    expect(failed.body).toContain('Kart limiti yetersiz.');
    expect(intentResultView({ status: 'NEEDS_REVIEW' })).toMatchObject({ tone: 'warning', terminal: true, canRetry: false });
  });

  it('bekleyen: sure dolana kadar sorgu surer, sonra tekrar odeme onerilmez', () => {
    expect(intentResultView({ status: 'PENDING' }).terminal).toBe(false);
    const timedOut = intentResultView({ status: 'PENDING' }, true);
    expect(timedOut).toMatchObject({ tone: 'info', terminal: true, canRetry: false });
    expect(timedOut.body).toMatch(/tekrar ödeme yapmayın/);
  });

  it('callback hatalari', () => {
    expect(callbackErrorView('not_found').title).toMatch(/bulunamadı/);
    expect(callbackErrorView('invalid').title).toMatch(/doğrulanamadı/);
    expect(callbackErrorView('baska').canRetry).toBe(false);
  });

  it('terminal durumlar ve cari etiketleri', () => {
    expect(TERMINAL_STATUSES).not.toContain('PENDING');
    expect(partyLabel('owner')).not.toBe(partyLabel('occupant'));
  });
});
