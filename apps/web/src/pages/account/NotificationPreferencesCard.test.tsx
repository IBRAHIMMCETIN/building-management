// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '@/lib/api/errors';
import { type NotificationPreferences, NOTIFICATION_CATEGORIES, categoryEnabled, notificationPreferencesSchema } from '@/lib/api/notificationPreferences';
import { NotificationPreferencesCard } from './NotificationPreferencesCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type State = { data?: NotificationPreferences; loadError?: Error; saving: boolean; saveError?: Error; mutate: ReturnType<typeof vi.fn>; role: string };
const state: State = { saving: false, mutate: vi.fn(), role: 'resident' };

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: state.role } }) }));

vi.mock('@/hooks/useTeam', () => ({
  useNotificationPreferences: () => ({ data: state.data, isPending: !state.data && !state.loadError, isError: !!state.loadError, error: state.loadError ?? null }),
  useSaveNotificationPreferences: () => ({ mutate: state.mutate, isPending: state.saving, isError: !!state.saveError, isSuccess: false, error: state.saveError ?? null }),
}));

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  Object.assign(state, { data: undefined, loadError: undefined, saving: false, saveError: undefined, mutate: vi.fn(), role: 'resident' });
});

function render(over: Partial<State>) {
  Object.assign(state, over);
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(<NotificationPreferencesCard />));
  const box = (name: string) => el.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  /** Erisilebilir ad: sarmalayan <label>'in ad satiri (aria-label yok). */
  const labelOf = (input: HTMLInputElement | null) => input?.closest('label')?.querySelector('.font-medium')?.textContent;
  const descriptionOf = (input: HTMLInputElement | null) => {
    const id = input?.getAttribute('aria-describedby');
    return id ? el.ownerDocument.getElementById(id)?.textContent : undefined;
  };
  return { el, box, labelOf, descriptionOf };
}

describe('bildirim tercihleri karti', () => {
  it('ana anahtar + alti kategori; kayitli olmayan kategori acik, kapatilan kapali gorunur', () => {
    const { el, box } = render({ data: { email: { enabled: true, gate: false } } });
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(1 + NOTIFICATION_CATEGORIES.length);
    for (const c of ['finance', 'announcements', 'tickets', 'reservations', 'polls']) expect(box(c)?.checked, c).toBe(true);
    expect(box('gate')?.checked).toBe(false);
  });

  it('erisilebilirlik: ad sarmalayan etiketten (aria-label yok), aciklama aria-describedby ile bagli', () => {
    const { box, labelOf, descriptionOf } = render({ data: { email: { enabled: true } } });
    const gate = box('gate');
    expect(gate?.hasAttribute('aria-label')).toBe(false);
    expect(labelOf(gate)).toBe('Ziyaretçi ve kurye');
    expect(descriptionOf(gate)).toContain('Kapıdaki kurye için onay isteği');
    expect(descriptionOf(box('enabled'))).toContain('Güvenlik ve davet e-postaları her zaman gönderilir');
    expect(descriptionOf(box('polls'))).not.toContain('sonuç');
  });

  it('degisiklikte yalnizca degisen alan gonderilir (ana anahtar dahil degil)', () => {
    const { box } = render({ data: { email: { enabled: true } } });
    act(() => box('reservations')?.click());
    expect(state.mutate).toHaveBeenCalledWith({ email: { reservations: false } });
    act(() => box('enabled')?.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ email: { enabled: false } });
  });

  it('ana anahtar kapaliyken kategoriler devre disi ve isaretsiz', () => {
    const { el, box } = render({ data: { email: { enabled: false, finance: true } } });
    expect(box('finance')?.disabled).toBe(true);
    expect(box('finance')?.checked).toBe(false);
    expect(el.textContent).toContain('E-posta bildirimleri kapalıyken bu konularda e-posta gönderilmez.');
  });

  it('kaydedilirken tum anahtarlar devre disi; kayit hatasi gosterilir', () => {
    const { el } = render({ data: { email: { enabled: true } }, saving: true, saveError: new NetworkError('kapali') });
    const inputs = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(inputs.length).toBe(1 + NOTIFICATION_CATEGORIES.length);
    expect(inputs.every((i) => i.disabled)).toBe(true);
    expect(el.textContent).toContain('Sunucuya ulaşılamadı');
  });

  it('abonelik / faturalar satiri yalnizca yonetici ve yonetim firmasina; ayni satir bicimiyle', () => {
    expect(render({ data: { email: { enabled: true } } }).box('billing')).toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    for (const role of ['observer', 'building_staff', 'platform_admin']) {
      const r = render({ data: { email: { enabled: true } }, role });
      expect(r.box('billing'), role).toBeNull();
      act(() => root?.unmount());
      document.body.innerHTML = '';
    }
    const { box, labelOf, descriptionOf } = render({ data: { email: { enabled: true, billing: false } }, role: 'apartment_manager' });
    const billing = box('billing');
    expect(billing?.checked).toBe(false);
    expect(labelOf(billing)).toBe('Abonelik ve faturalar');
    expect(descriptionOf(billing)).toContain('Yalnızca yönetime gönderilir');
    act(() => billing?.click());
    expect(state.mutate).toHaveBeenCalledWith({ email: { billing: true } });
  });

  it('tercih okunamazsa hata gosterilir, anahtar cizilmez', () => {
    const { el } = render({ loadError: new Error('beklenmeyen') });
    expect(el.textContent).toContain('Beklenmeyen bir hata oluştu.');
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
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
