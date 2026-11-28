import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/*
 * Gercek app/ dizini (Expo Router) + mock kimlik + demo API (jest.setup.ts): korumali ekranlar role
 * gore acilir, bildirim baglantilari (push data.url) role gore yonlendirilir.
 */

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

// Jest apps/mobile icinde calisir (npm test -w @bm/mobile): yol ona gore.
const APP_DIR = './app';
jest.setTimeout(20_000);

beforeEach(() => mockStore.clear());

async function signInAs(label: string) {
  await fireEvent.press(await screen.findByRole('button', { name: label }, { timeout: 5000 }));
}

async function expectPath(result: { getPathname(): string }, pathname: string) {
  await waitFor(() => expect(result.getPathname()).toBe(pathname), { timeout: 5000 });
}

describe('korumali ekranlar ve bildirim baglantilari', () => {
  it('oturum yoksa giris; bildirim baglantisi da girise gider', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/borclar' });
    await expectPath(result, '/login');
    expect(await screen.findByRole('header', { name: 'Giriş yap' }, { timeout: 5000 })).toBeTruthy();
  });

  it('sakin: girisle sakin sekmeleri; baglantilar hazir ekranlara gider', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await signInAs('Daire Sakini');
    await expectPath(result, '/resident');

    await act(() => router.push('/duyurular/an-1'));
    await expectPath(result, '/resident/announcements/an-1');
    expect(await screen.findByText('Bahçe düzenlemesi', {}, { timeout: 5000 })).toBeTruthy();

    await act(() => router.push('/borclar'));
    await expectPath(result, '/resident/dues');

    await act(() => router.push('/oylamalar/p-1'));
    await expectPath(result, '/resident/polls/p-1');
    expect(await screen.findByRole('header', { name: 'Bahçeye çocuk oyun alanı yapılsın mı?' }, { timeout: 5000 })).toBeTruthy();

    await act(() => router.push('/genel-kurul/as-2'));
    await expectPath(result, '/resident/assemblies/as-2');
    expect(await screen.findByText('3. Yönetici seçimi', {}, { timeout: 5000 })).toBeTruthy();

    await act(() => router.push('/ihaleler/t-1'));
    await expectPath(result, '/resident/tenders/t-1');
    expect(await screen.findByText('Cephe Pro İnşaat', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('guvenlik: Kapı alani; sakin ekranlari kapali, baglantilar Kapı\'ya', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await signInAs('Güvenlik');
    await expectPath(result, '/guard');

    await act(() => router.push('/kapi'));
    await expectPath(result, '/guard');
    expect(await screen.findByRole('button', { name: 'QR okut' }, { timeout: 5000 })).toBeTruthy();
    await act(() => router.push('/guard/manual-entry?plate=34XYZ9'));
    await expectPath(result, '/guard/manual-entry');
    expect(screen.getByDisplayValue('34XYZ9')).toBeTruthy();

    await act(() => router.push('/resident/dues'));
    await waitFor(() => expect(result.getPathname()).not.toBe('/resident/dues'), { timeout: 5000 });
    expect(result.getPathname().startsWith('/resident')).toBe(false);
  });

  it('bina gorevlisi: İşlerim; talep bildirimi dogrudan talep ayrintisini acar', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await signInAs('Bina Görevlisi');
    await expectPath(result, '/staff');
    expect(await screen.findByText('Kombi basıncı düşüyor', {}, { timeout: 5000 })).toBeTruthy();

    await act(() => router.push('/talepler/tk-41'));
    await expectPath(result, '/staff/ticket/tk-41');
    expect(await screen.findByText('B Blok asansörü katlar arasında duruyor', {}, { timeout: 5000 })).toBeTruthy();

    await act(() => router.push('/staff/readings'));
    expect((await screen.findAllByText(/Salon peteği/, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
  });

  it('yonetim rolu: panel web\'de ekrani; cikis girise doner', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await signInAs('Apartman Yöneticisi');
    await expectPath(result, '/panel');
    expect(await screen.findByText("Yönetim paneli web'de", {}, { timeout: 5000 })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Çıkış yap' }));
    await expectPath(result, '/login');
  });
});
