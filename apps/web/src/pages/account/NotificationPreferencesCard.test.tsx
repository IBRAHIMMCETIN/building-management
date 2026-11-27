// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NotificationPreferences, NOTIFICATION_CATEGORIES, categoryEnabled, notificationPreferencesSchema } from '@/lib/api/notificationPreferences';
import { NotificationPreferencesCard } from './NotificationPreferencesCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: { data: NotificationPreferences | undefined; mutate: ReturnType<typeof vi.fn> } = { data: undefined, mutate: vi.fn() };

vi.mock('@/hooks/useTeam', () => ({
  useNotificationPreferences: () => ({ data: state.data, isPending: !state.data, isError: false, error: null }),
  useSaveNotificationPreferences: () => ({ mutate: state.mutate, isPending: false, isError: false, isSuccess: false, error: null }),
}));

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  state.mutate = vi.fn();
});

function render(data: NotificationPreferences) {
  state.data = data;
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(<NotificationPreferencesCard />));
  const box = (label: string) => el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  return { el, box };
}

describe('bildirim tercihleri karti', () => {
  it('ana anahtar + alti kategori; kayitli olmayan kategori acik, kapatilan kapali gorunur', () => {
    const { el, box } = render({ email: { enabled: true, gate: false } });
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(1 + NOTIFICATION_CATEGORIES.length);
    for (const label of ['Aidat ve tahsilat', 'Duyurular', 'Arıza ve talepler', 'Rezervasyon', 'Anket ve oylama']) expect(box(`${label} e-postaları`)?.checked).toBe(true);
    expect(box('Ziyaretçi ve kurye e-postaları')?.checked).toBe(false);
    expect(el.textContent).toContain('Kapıdaki kurye için onay isteği');
  });

  it('bir kategori degisince yalnizca o alan gonderilir (sunucu digerlerini korur)', () => {
    const { box } = render({ email: { enabled: true } });
    act(() => box('Rezervasyon e-postaları')?.click());
    expect(state.mutate).toHaveBeenCalledWith({ email: { enabled: true, reservations: false } });
    act(() => box('E-posta bildirimleri')?.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ email: { enabled: false } });
  });

  it('ana anahtar kapaliyken kategoriler devre disi ve isaretsiz', () => {
    const { el, box } = render({ email: { enabled: false, finance: true } });
    const finance = box('Aidat ve tahsilat e-postaları');
    expect(finance?.disabled).toBe(true);
    expect(finance?.checked).toBe(false);
    expect(el.textContent).toContain('E-posta bildirimleri kapalıyken bu konularda e-posta gönderilmez.');
  });
});

describe('tercih semasi', () => {
  it('bilinmeyen alanlari atar; kategori yoksa acik', () => {
    const parsed = notificationPreferencesSchema.parse({ email: { enabled: true, polls: false, sms: true }, updatedAt: '2026-11-27T08:00:00.000Z' });
    expect(parsed.email).toEqual({ enabled: true, polls: false });
    expect(categoryEnabled(parsed, 'polls')).toBe(false);
    expect(categoryEnabled(parsed, 'finance')).toBe(true);
  });
});
