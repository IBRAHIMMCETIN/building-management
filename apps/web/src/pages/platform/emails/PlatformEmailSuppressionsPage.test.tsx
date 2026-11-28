// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailSuppression } from '@/lib/api/emailSuppressions';
import { clearReasonError, suppressionBadgeText, suppressionReasonText, suppressionTone } from '@/lib/api/emailSuppressions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api/client', () => ({ apiClient: {} }));

const hard: EmailSuppression = {
  emailHash: 'a'.repeat(64),
  emailMasked: 'a***@example.com',
  reason: 'bounce',
  bounceType: 'Permanent',
  bounceSubType: 'General',
  at: '2026-11-28T08:59:00.000Z',
  recordedAt: '2026-11-28T09:00:00.000Z',
  status: 'active',
  active: true,
};
const soft: EmailSuppression = { ...hard, emailHash: 'b'.repeat(64), emailMasked: 'b***@example.com', bounceType: 'Transient', expiresAt: '2026-12-05T09:00:00.000Z' };

const state = {
  list: { isPending: false, isError: false, data: { pages: [{ items: [hard, soft] }] }, hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(), fetchNextPage: vi.fn() } as Record<string, unknown>,
  clear: { mutateAsync: vi.fn(async () => ({ ...hard, status: 'cleared', active: false })), reset: vi.fn(), isPending: false, isError: false, error: null },
};

vi.mock('@/hooks/useEmailSuppressions', () => ({
  useEmailSuppressions: () => state.list,
  useLookupSuppression: () => ({ mutate: vi.fn(), isPending: false, isError: false, data: undefined }),
  useClearSuppression: () => state.clear,
}));

const { PlatformEmailSuppressionsPage } = await import('./PlatformEmailSuppressionsPage');

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  state.clear.mutateAsync.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

function render() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(<PlatformEmailSuppressionsPage />));
  return el;
}

const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));

describe('E-posta engelleri sayfasi', () => {
  it('liste maskeli adres, neden ve gecici engelin bitisiyle; tam adres yok', () => {
    const el = render();
    const text = el.textContent ?? '';
    expect(text).toContain('E-posta Engelleri');
    expect(text).toContain('a***@example.com');
    expect(text).toContain('Kalıcı geri dönüş');
    expect(text).toContain('Geçici geri dönüş');
    expect(text).toContain('kendiliğinden kalkar');
    expect(buttons('Engeli kaldır')).toHaveLength(2);
  });

  it('kaldirma: gerekce zorunlu (5-300), sonra API cagrisi', async () => {
    render();
    act(() => buttons('Engeli kaldır')[0]?.click());
    const confirm = () => buttons('Engeli kaldır').at(-1) as HTMLButtonElement;
    await act(async () => confirm().click());
    expect(document.body.textContent).toContain('Gerekçe 5-300 karakter olmalı.');
    expect(state.clear.mutateAsync).not.toHaveBeenCalled();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'Kullanıcı adresi düzeltti');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => confirm().click());
    expect(state.clear.mutateAsync).toHaveBeenCalledWith({ emailHash: hard.emailHash, reason: 'Kullanıcı adresi düzeltti' });
  });

  it('bos liste metni', () => {
    state.list = { ...state.list, data: { pages: [{ items: [] }] } };
    const el = render();
    expect(el.textContent).toContain('Engellenen e-posta adresi yok.');
  });
});

describe('engel metinleri', () => {
  it('neden, ton ve gerekce kurali', () => {
    expect(suppressionReasonText({ reason: 'complaint', feedbackType: 'abuse' })).toBe('Şikâyet (abuse)');
    expect(suppressionReasonText({ reason: 'bounce', bounceType: 'Undetermined' })).toBe('Geçici geri dönüş');
    expect(suppressionTone({ reason: 'bounce', bounceType: 'Transient', active: true })).toBe('warning');
    expect(suppressionTone({ reason: 'complaint', active: true })).toBe('danger');
    expect(suppressionTone({ reason: 'complaint', active: false })).toBe('neutral');
    expect(suppressionBadgeText({ reason: 'bounce', bounceType: 'Transient', active: false, status: 'observing', softBounceCount: 2 })).toBe('İzleniyor (2 geçici geri dönüş)');
    expect(suppressionBadgeText({ reason: 'bounce', active: false, status: 'cleared' })).toBe('Kaldırıldı');
    expect(clearReasonError('  abc ')).toBeDefined();
    expect(clearReasonError('Adres düzeltildi')).toBeUndefined();
  });
});
