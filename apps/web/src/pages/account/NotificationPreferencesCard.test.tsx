// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '@/lib/api/errors';
import { type NotificationPreferences, NOTIFICATION_CATEGORIES, categoryEnabled, notificationPreferencesSchema } from '@/lib/api/notificationPreferences';
import { NotificationPreferencesCard } from './NotificationPreferencesCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type State = {
  data?: NotificationPreferences;
  loadError?: Error;
  saving: boolean;
  saveError?: Error;
  mutate: ReturnType<typeof vi.fn>;
  /** `GET /api/me/devices`; undefined: yukleniyor / hata. */
  devices?: { deviceId: string; platform: string; lastSeenAt: string }[];
  /** Aktif rol ve abonelik sisteminin acik olup olmadigi (abonelik satiri). */
  role: string;
  billing: boolean;
};
const state: State = { saving: false, mutate: vi.fn(), role: 'resident', billing: true };

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: state.role } }) }));
vi.mock('@/hooks/useSubscriptions', () => ({ useSubscriptionStatus: () => ({ data: { enabled: state.billing, status: 'legacy', legacy: true, readOnly: false } }) }));

vi.mock('@/hooks/useTeam', () => ({
  useNotificationPreferences: () => ({ data: state.data, isPending: !state.data && !state.loadError, isError: !!state.loadError, error: state.loadError ?? null }),
  useSaveNotificationPreferences: () => ({ mutate: state.mutate, isPending: state.saving, isError: !!state.saveError, isSuccess: false, error: state.saveError ?? null }),
  useMyDevices: () => ({ data: state.devices ? { devices: state.devices } : undefined }),
}));

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  Object.assign(state, { data: undefined, loadError: undefined, saving: false, saveError: undefined, mutate: vi.fn(), devices: undefined, role: 'resident', billing: true });
});

const PHONE = { deviceId: 'd1', platform: 'ios', lastSeenAt: '2026-11-28T08:00:00.000Z' };
const HINT = 'Mobil bildirimler, YÖNESİST mobil uygulamasında giriş yapıp bildirimlere izin verdiğinizde açılır';

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

  it('tercih okunamazsa hata gosterilir, anahtar cizilmez', () => {
    const { el } = render({ loadError: new Error('beklenmeyen') });
    expect(el.textContent).toContain('Beklenmeyen bir hata oluştu.');
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });
});

describe('mobil bildirim bolumu', () => {
  it('kayitli telefon yoksa yalnizca kisa not; push anahtari yok', () => {
    const { el, box } = render({ data: { email: { enabled: true } }, devices: [] });
    expect(el.textContent).toContain(HINT);
    expect(box('push.enabled')).toBeNull();
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(1 + NOTIFICATION_CATEGORIES.length);
  });

  it('cihaz listesi yuklenmeden (veya hata) ne bolum ne not', () => {
    const { el, box } = render({ data: { email: { enabled: true } } });
    expect(box('push.enabled')).toBeNull();
    expect(el.textContent).not.toContain(HINT);
  });

  it('telefon varsa e-postanin altinda ana anahtar + ayni kategoriler; push tercihi okunur', () => {
    const { el, box, labelOf, descriptionOf } = render({ data: { email: { enabled: true }, push: { enabled: true, finance: false } }, devices: [PHONE] });
    expect(el.textContent).not.toContain(HINT);
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(2 * (1 + NOTIFICATION_CATEGORIES.length));
    expect(labelOf(box('push.enabled'))).toBe('Mobil bildirimler');
    expect(descriptionOf(box('push.enabled'))).toContain('E-posta tercihinden bağımsızdır');
    expect(box('push.finance')?.checked).toBe(false);
    expect(box('push.gate')?.checked).toBe(true);
    // E-posta tarafi push tercihinden etkilenmez.
    expect(box('finance')?.checked).toBe(true);
    // Ayni konu iki kanalda: push kutusunun ekran okuyucu adi kanali soyler, aciklama yine bagli.
    expect(box('push.gate')?.getAttribute('aria-label')).toBe('Ziyaretçi ve kurye, mobil bildirim');
    expect(descriptionOf(box('push.gate'))).toContain('Kapıdaki kurye için onay isteği');
    expect(el.querySelector('[role="group"][aria-label="Mobil bildirim konuları"]')).not.toBeNull();
    // Sira: e-posta bolumu once.
    const names = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((i) => i.name);
    expect(names.indexOf('push.enabled')).toBe(1 + NOTIFICATION_CATEGORIES.length);
  });

  it('push tercihi kayitli degilse acik sayilir', () => {
    const { box } = render({ data: { email: { enabled: false } }, devices: [PHONE] });
    expect(box('push.enabled')?.checked).toBe(true);
    expect(box('push.tickets')?.checked).toBe(true);
  });

  it('degisiklikte yalnizca degisen push alani gonderilir', () => {
    const { box } = render({ data: { email: { enabled: true }, push: { enabled: true } }, devices: [PHONE] });
    act(() => box('push.gate')?.click());
    expect(state.mutate).toHaveBeenCalledWith({ push: { gate: false } });
    act(() => box('push.enabled')?.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ push: { enabled: false } });
  });

  it('push ana anahtari kapaliyken konular devre disi ve not gosterilir; e-posta acik kalir', () => {
    const { el, box } = render({ data: { email: { enabled: true }, push: { enabled: false, polls: true } }, devices: [PHONE] });
    expect(box('push.polls')?.disabled).toBe(true);
    expect(box('push.polls')?.checked).toBe(false);
    expect(box('polls')?.disabled).toBe(false);
    expect(el.textContent).toContain('Mobil bildirimler kapalıyken bu konularda telefona bildirim gönderilmez.');
  });

  it('kaydedilirken push anahtarlari da devre disi', () => {
    const { el } = render({ data: { email: { enabled: true }, push: { enabled: true } }, devices: [PHONE], saving: true });
    expect([...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((i) => i.disabled)).toBe(true);
  });
});

describe('abonelik ve faturalar satiri (yalnizca yonetim, sistem aciksa)', () => {
  it('sakin, denetci, gorevli ve platform yoneticisinde yok', () => {
    for (const role of ['resident', 'observer', 'building_staff', 'platform_admin']) {
      const r = render({ data: { email: { enabled: true }, push: { enabled: true } }, devices: [PHONE], role });
      expect(r.box('billing'), role).toBeNull();
      expect(r.box('push.billing'), role).toBeNull();
      act(() => root?.unmount());
      document.body.innerHTML = '';
    }
  });

  it('yoneticide e-posta ve mobil bolumde ayni satir bicimiyle, en sonda; yalnizca degisen alan gider', () => {
    const { el, box, labelOf, descriptionOf } = render({ data: { email: { enabled: true, billing: false }, push: { enabled: true } }, devices: [PHONE], role: 'apartment_manager' });
    const billing = box('billing');
    expect(billing?.checked).toBe(false);
    expect(labelOf(billing)).toBe('Abonelik ve faturalar');
    expect(descriptionOf(billing)).toContain('Yalnızca yönetime gönderilir');
    const emailGroup = el.querySelector('[role="group"][aria-label="E-posta konuları"]');
    expect([...(emailGroup?.querySelectorAll('input') ?? [])].at(-1)?.getAttribute('name')).toBe('billing');
    const push = box('push.billing');
    expect(push?.checked).toBe(true);
    expect(push?.getAttribute('aria-label')).toBe('Abonelik ve faturalar, mobil bildirim');
    act(() => billing?.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ email: { billing: true } });
    act(() => push?.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ push: { billing: false } });
  });

  it('abonelik sistemi kapaliyken yoneticide de iki bolumde de yok', () => {
    const r = render({ data: { email: { enabled: true }, push: { enabled: true } }, devices: [PHONE], role: 'management_company', billing: false });
    expect(r.box('billing')).toBeNull();
    expect(r.box('push.billing')).toBeNull();
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
