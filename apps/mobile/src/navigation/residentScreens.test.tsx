import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/*
 * Gercek app/ dizini + mock kimlik + demo API (jest.setup.ts): Talepler, Ziyaretçi ve Rezervasyon
 * mobil ekranlari; bildirim baglantilari (push data.url) bu ekranlara gider, "Diğer" onlari acar.
 */

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

const APP_DIR = './app';
jest.setTimeout(30_000);

beforeEach(() => mockStore.clear());

async function expectPath(result: { getPathname(): string }, pathname: string) {
  await waitFor(() => expect(result.getPathname()).toBe(pathname), { timeout: 5000 });
}

describe('sakin M2a ekranlari (gercek yonlendirme)', () => {
  it('bildirim baglantilari ve "Diğer": talep ayrintisi, Ziyaretçi, Rezervasyonlarım', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Daire Sakini' }, { timeout: 5000 }));
    await expectPath(result, '/resident');

    await act(() => router.push('/talepler/tk-2'));
    await expectPath(result, '/resident/tickets/tk-2');
    expect(await screen.findByRole('header', { name: 'Banyo lavabosu su kaçırıyor' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Onayla ve kapat' })).toBeTruthy();

    await act(() => router.push('/kapi'));
    await expectPath(result, '/resident/gate');
    expect(await screen.findByRole('header', { name: 'Kapıda kurye var' }, { timeout: 5000 })).toBeTruthy();

    await act(() => router.push('/rezervasyonlar'));
    await expectPath(result, '/resident/reservations');
    expect(result.getSearchParams()).toMatchObject({ tab: 'mine' });
    expect(await screen.findByRole('button', { name: 'Rezervasyonlarım', selected: true }, { timeout: 5000 })).toBeTruthy();

    await act(() => router.replace('/resident/more'));
    await fireEvent.press(await screen.findByRole('button', { name: /^Ziyaretçi,/ }, { timeout: 5000 }));
    await expectPath(result, '/resident/gate');
  });

  it('Talepler sekmesi ve yeni talep sihirbazi', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Daire Sakini' }, { timeout: 5000 }));
    await expectPath(result, '/resident');
    await act(() => router.push('/resident/tickets'));
    expect(await screen.findByRole('header', { name: 'Arıza / Talep' }, { timeout: 5000 })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Yeni talep' }));
    await expectPath(result, '/resident/tickets/new');
    expect(await screen.findByRole('header', { name: 'Arıza nerede?' }, { timeout: 5000 })).toBeTruthy();
  });
});
