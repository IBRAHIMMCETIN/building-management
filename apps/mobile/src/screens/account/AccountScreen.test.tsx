import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_META } from '@bm/shared/api/notificationPreferences';
import { renderApp } from '@/test/renderApp';
import { AccountScreen } from './AccountScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

type Prefs = { email: Record<string, boolean> };

function prefsApi(initial: Prefs) {
  let state = initial;
  return {
    'GET /api/me/notification-preferences': () => state,
    'PUT /api/me/notification-preferences': ({ body }: { body: unknown }) => {
      state = { email: { ...state.email, ...(body as Prefs).email } };
      return state;
    },
  };
}

const switchFor = (label: string) => screen.getByRole('switch', { name: label });

describe('Hesabım', () => {
  it('profil: e-posta, rol, apartman; tek baglamda degistirme dugmesi yok', async () => {
    await renderApp(<AccountScreen />, { routes: prefsApi({ email: { enabled: true } }) });
    expect(screen.getByLabelText('E-posta: resident@dev.local')).toBeTruthy();
    expect(screen.getByLabelText('Aktif rol: Daire Sakini')).toBeTruthy();
    expect(await screen.findByLabelText('Apartman: Geliştirme Sitesi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apartman / rol değiştir' })).toBeNull();
  });

  it('birden fazla baglam: degistirme ekranina gider', async () => {
    await renderApp(<AccountScreen />, { email: 'multi@dev.local', routes: prefsApi({ email: { enabled: true } }) });
    await fireEvent.press(await screen.findByRole('button', { name: 'Apartman / rol değiştir' }));
    expect(mockPush).toHaveBeenCalledWith('/select-context');
  });

  it('web ile ayni kategoriler; kayitli olmayan kategori acik sayilir', async () => {
    await renderApp(<AccountScreen />, { routes: prefsApi({ email: { enabled: true, finance: false } }) });
    await screen.findByRole('switch', { name: 'E-posta bildirimleri' });
    for (const c of NOTIFICATION_CATEGORIES) expect(switchFor(NOTIFICATION_CATEGORY_META[c].label)).toBeTruthy();
    expect(switchFor('Aidat ve tahsilat').props.accessibilityState?.checked ?? switchFor('Aidat ve tahsilat').props.value).toBe(false);
    expect(switchFor('Duyurular').props.value).toBe(true);
  });

  it('degisiklik YALNIZCA degisen alani gonderir ve kaydedildi bilgisini gosterir', async () => {
    const { calls } = await renderApp(<AccountScreen />, { routes: prefsApi({ email: { enabled: true } }) });
    await fireEvent(await screen.findByRole('switch', { name: 'Aidat ve tahsilat' }), 'valueChange', false);
    expect(await screen.findByText('Tercihiniz kaydedildi.')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ email: { finance: false } });
    await waitFor(() => expect(switchFor('Aidat ve tahsilat').props.value).toBe(false));
  });

  it('ana anahtar kapaliyken kategoriler devre disi ve aciklama gosterilir', async () => {
    const { calls } = await renderApp(<AccountScreen />, { routes: prefsApi({ email: { enabled: true } }) });
    await fireEvent(await screen.findByRole('switch', { name: 'E-posta bildirimleri' }), 'valueChange', false);
    expect(await screen.findByText('E-posta bildirimleri kapalıyken bu konularda e-posta gönderilmez.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ email: { enabled: false } });
    expect(switchFor('Duyurular').props.disabled).toBe(true);
  });

  it('kayit hatasi Turkce mesajla gosterilir', async () => {
    await renderApp(<AccountScreen />, {
      routes: { 'GET /api/me/notification-preferences': { email: { enabled: true } }, 'PUT /api/me/notification-preferences': { status: 503, body: { error: 'unavailable' } } },
    });
    await fireEvent(await screen.findByRole('switch', { name: 'Duyurular' }), 'valueChange', false);
    expect(await screen.findByText('Sunucuda beklenmeyen bir hata oluştu.')).toBeTruthy();
  });

  it('cikis oturumu kapatir', async () => {
    const { services } = await renderApp(<AccountScreen />, { routes: prefsApi({ email: { enabled: true } }) });
    await fireEvent.press(screen.getByRole('button', { name: 'Çıkış yap' }));
    await waitFor(() => expect(services.session.getSession()).toBeNull());
  });
});
