import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/*
 * Gercek app/ dizini + mock kimlik + demo API: site ozelligine bagli "Diğer" ogesi listede gorunmez,
 * ekranina bildirim / derin baglantiyla gelinirse "Bu özellik sitenizde kapalı" notu cikar. Bugunku
 * katalogda "Diğer" ogesine karsilik gelen anahtar olmadigindan Tüketimim, demo sitede KAPALI olan
 * `resident.expenseChart` anahtarina baglanarak sinanir (mekanizma veriyle calisir: nav.ts `feature`).
 */

jest.mock('@/lib/nav', () => {
  const actual = jest.requireActual('@/lib/nav') as typeof import('@/lib/nav');
  const items = actual.RESIDENT_MORE.map((i) => (i.key === 'tuketim' ? { ...i, feature: 'resident.expenseChart' as const } : i));
  return {
    ...actual,
    RESIDENT_MORE: items,
    residentMoreFor: (isOwner: boolean, list = items, isEnabled?: Parameters<typeof actual.residentMoreFor>[2]) => actual.residentMoreFor(isOwner, list, isEnabled),
    moreItemForRoute: (name: string, params?: object, list = items) => actual.moreItemForRoute(name, params, list),
  };
});

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

describe('kapali site ozelligi (gercek yonlendirme)', () => {
  it('"Diğer"de gizli, dogrudan acilan ekranda sade not; acik ozellikler etkilenmez', async () => {
    const result = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Daire Sakini' }, { timeout: 5000 }));
    await expectPath(result, '/resident');

    await act(() => router.push('/resident/more'));
    expect(await screen.findByRole('button', { name: /^Ziyaretçi,/ }, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tüketimim,/ })).toBeNull(), { timeout: 5000 });

    await act(() => router.push('/resident/consumption'));
    await expectPath(result, '/resident/consumption');
    expect(await screen.findByText('Bu özellik sitenizde kapalı. Açılmasını isterseniz site yönetiminize söyleyebilirsiniz.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Tüketimim' })).toBeTruthy();

    // Acik ozellige bagli olmayan ekran normal acilir.
    await act(() => router.push('/kapi'));
    await expectPath(result, '/resident/gate');
    expect(await screen.findByRole('header', { name: 'Kapıda kurye var' }, { timeout: 5000 })).toBeTruthy();
  });
});
