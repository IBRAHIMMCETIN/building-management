import { act, screen, waitFor } from '@testing-library/react-native';
import { NoticeBanner } from '@/components/NoticeBanner';
import { fakeNotifications } from '@/test/notifications';
import { renderApp } from '@/test/renderApp';
import { NotificationObserver } from './NotificationObserver';

/*
 * Bildirime dokunma: uygulama acikken, soguk acilista, oturum yokken, kullanicinin baglamlarinda
 * olmayan apartmanda ve baglam degisimi basarisiz oldugunda. Yonlendirici sahte (navigate cagrilari).
 */

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate, push: jest.fn() }) }));

function Harness() {
  return (
    <>
      <NotificationObserver />
      <NoticeBanner />
    </>
  );
}

const tap = (id: string, data: Record<string, unknown>) => ({ id, data });
const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => mockNavigate.mockReset());

describe('bildirime dokunma', () => {
  it('uygulama acikken: aktif apartmandaki yol acilir, saklanan son yanit temizlenir', async () => {
    const notifications = fakeNotifications();
    await renderApp(<Harness />, { email: 'resident@dev.local', withUnit: false, notifications });
    await act(async () => notifications.tap(tap('n1', { url: '/duyurular/an-1', apartmentId: 'apt-dev-1' })));
    await tick();
    expect(mockNavigate).toHaveBeenCalledWith('/duyurular/an-1');
    expect(notifications.state.lastTapCleared).toBe(1);
    // Ayni bildirim (ornek: soguk acilis + dinleyici) ikinci kez acilmaz.
    await act(async () => notifications.tap(tap('n1', { url: '/duyurular/an-1', apartmentId: 'apt-dev-1' })));
    await tick();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('soguk acilis: uygulamayi acan bildirim bir kez acilir', async () => {
    const notifications = fakeNotifications();
    notifications.setLastTap(tap('cold', { url: '/borclar' }));
    await renderApp(<Harness />, { email: 'resident@dev.local', withUnit: false, notifications });
    await tick();
    expect(mockNavigate).toHaveBeenCalledWith('/borclar');
    expect(notifications.state.lastTapCleared).toBe(1);
  });

  it('oturum yokken: acilis kurali (giris), giristen sonra bekleyen yol acilir', async () => {
    const notifications = fakeNotifications();
    const { services } = await renderApp(<Harness />, { email: null, withUnit: false, notifications });
    await act(async () => notifications.tap(tap('n2', { url: '/borclar', apartmentId: 'apt-dev-1' })));
    await tick();
    expect(mockNavigate).toHaveBeenLastCalledWith('/');
    await act(async () => {
      await services.session.signIn({ email: 'resident@dev.local', password: 'Mock123456' });
    });
    await tick();
    expect(mockNavigate).toHaveBeenLastCalledWith('/borclar');
  });

  it('baglamlarda olmayan apartman (baska kullanicinin bildirimi): gecis yok, ana sayfa + bilgi notu', async () => {
    const notifications = fakeNotifications();
    const { services } = await renderApp(<Harness />, { email: 'resident@dev.local', withUnit: false, notifications });
    const before = services.session.getSession()?.claims.apartmentId;
    await act(async () => notifications.tap(tap('n3', { url: '/borclar', apartmentId: 'apt-baska' })));
    await tick();
    expect(mockNavigate).toHaveBeenLastCalledWith('/');
    expect(await screen.findByText('Bu bildirim artık erişiminiz olmayan bir apartmana ait. Ana sayfa açıldı.')).toBeTruthy();
    expect(services.session.getSession()?.claims.apartmentId).toBe(before);
  });

  it('baglamlardaki baska apartman: once gecis, sonra yol', async () => {
    const notifications = fakeNotifications();
    const { services } = await renderApp(<Harness />, { email: 'multi@dev.local', withUnit: false, notifications });
    await act(async () => {
      await services.session.setActiveContext({ apartmentId: 'apt-dev-1', role: 'resident' });
    });
    await act(async () => notifications.tap(tap('n4', { url: '/duyurular/an-2', apartmentId: 'apt-dev-2' })));
    await waitFor(() => expect(services.session.getSession()?.claims).toMatchObject({ apartmentId: 'apt-dev-2', role: 'resident' }));
    await tick();
    expect(mockNavigate).toHaveBeenLastCalledWith('/duyurular/an-2');
  });

  it('baglam degisimi basarisiz: bilgi notu, ana sayfa, aktif baglam degismez', async () => {
    const notifications = fakeNotifications();
    const { services } = await renderApp(<Harness />, { email: 'multi@dev.local', withUnit: false, notifications });
    await act(async () => {
      await services.session.setActiveContext({ apartmentId: 'apt-dev-1', role: 'resident' });
    });
    jest.spyOn(services.session, 'setActiveContext').mockRejectedValue(new Error('Seçilen apartman/rol doğrulanamadı. Yetkiniz değişmiş olabilir.'));
    await act(async () => notifications.tap(tap('n5', { url: '/borclar', apartmentId: 'apt-dev-2' })));
    await tick();
    expect(mockNavigate).toHaveBeenLastCalledWith('/');
    expect(await screen.findByText(/^Bildirim açılamadı:/)).toBeTruthy();
    expect(services.session.getSession()?.claims.apartmentId).toBe('apt-dev-1');
  });
});
