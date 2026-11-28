import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/context/AuthProvider';
import { createMockAuthAdapter } from '@/lib/auth/mockAdapter';
import { type LockStorage, lockStorageKey } from '@/lib/lock/appLock';
import { ServicesProvider, createServices } from '@/services';
import { type FakeBiometrics, fakeBiometrics } from '@/test/biometrics';
import { TEST_ENV, memoryStorage, mockApi } from '@/test/renderApp';
import { AppLockGate } from './AppLockGate';
import { Sheet } from './portal/Sheet';

/*
 * Kilit ekrani gercek servislerle: mock kimlik (kalici depo -> soguk acilista geri yukleme), sahte
 * biyometri, AppState olaylari testten.
 */

let appStateListeners: Array<(s: AppStateStatus) => void> = [];
beforeEach(() => {
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
    appStateListeners.push(fn as (s: AppStateStatus) => void);
    return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
  });
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});
afterEach(() => jest.restoreAllMocks());

const emitAppState = (s: AppStateStatus) => act(() => appStateListeners.forEach((l) => l(s)));

function lockStore(initial: Record<string, string> = {}): LockStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void (v === null ? data.delete(k) : data.set(k, v)) };
}

/** Once giris yapilir (oturum depoya yazilir), sonra uygulama "yeniden acilir": yeni servisler ayni depodan geri yukler. */
async function coldStart({ enabled = true, bio = fakeBiometrics(), now }: { enabled?: boolean; bio?: FakeBiometrics; now?: () => number } = {}) {
  const authStorage = memoryStorage();
  const first = createServices(TEST_ENV, { adapter: createMockAuthAdapter({ storage: authStorage, delayMs: 0 }), fetchImpl: mockApi({}).fetchImpl, pushStorage: memoryStorage() });
  await first.session.ready;
  await first.session.signIn({ email: 'resident@dev.local', password: 'Mock123456' });
  const sub = first.session.getSession()?.claims.sub ?? '';
  const storage = lockStore(enabled ? { [lockStorageKey(sub)]: JSON.stringify({ enabled: true, timeoutMinutes: 5 }) } : {});

  const services = createServices(TEST_ENV, {
    adapter: createMockAuthAdapter({ storage: authStorage, delayMs: 0 }),
    fetchImpl: mockApi({}).fetchImpl,
    pushStorage: memoryStorage(),
    biometrics: bio,
    lockStorage: storage,
    lockMarker: lockStore(),
  });
  if (now) Object.assign(services.lock, { now });
  await services.session.ready;
  const queryClient = new QueryClient();
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <ServicesProvider services={services}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Text>Uygulama içeriği</Text>
            <Sheet open title="Açık pencere" onClose={() => undefined}>
              <Text>Pencere içeriği</Text>
            </Sheet>
            <AppLockGate />
          </AuthProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </SafeAreaProvider>,
  );
  return { services, bio, storage, sub };
}

describe('Uygulama kilidi', () => {
  it('acik kilit: soguk acilista kilit ekrani ve sistem istemi; basarili dogrulamada icerik', async () => {
    const bio = fakeBiometrics();
    let release: (r: { ok: true }) => void = () => undefined;
    bio.authenticate = (prompt) => {
      bio.state.prompts.push(prompt);
      return new Promise((r) => (release = r));
    };
    await coldStart({ bio });
    expect(await screen.findByRole('header', { name: 'Uygulama kilitli' })).toBeTruthy();
    expect(screen.getByText('resident@dev.local')).toBeTruthy();
    await waitFor(() => expect(bio.state.prompts).toEqual(['YÖNESİST kilidini açın']));
    await act(async () => release({ ok: true }));
    await waitFor(() => expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull());
    expect(screen.getByText('Uygulama içeriği')).toBeTruthy();
  });

  it('kapali kilit: kilit ekrani yok, istem yok', async () => {
    const { bio } = await coldStart({ enabled: false });
    await waitFor(() => expect(screen.getByText('Uygulama içeriği')).toBeTruthy());
    expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull();
    expect(bio.state.prompts).toEqual([]);
  });

  it('vazgecilirse mesaj; "Kilidi aç" tekrar dener', async () => {
    const bio = fakeBiometrics();
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    await coldStart({ bio });
    expect(await screen.findByText(/Doğrulama iptal edildi/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Kilidi aç' }));
    await waitFor(() => expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull());
    expect(bio.state.prompts).toHaveLength(2);
  });

  it('kilit ekranindan cikis: oturum kapanir, kilit kalkar', async () => {
    const bio = fakeBiometrics();
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    const { services } = await coldStart({ bio });
    await screen.findByText(/Doğrulama iptal edildi/);
    await fireEvent.press(screen.getByRole('button', { name: 'Çıkış yap' }));
    await waitFor(() => expect(services.session.getSession()).toBeNull());
    expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull();
  });

  it('arka planda 5 dk kalinca yeniden kilitlenir; kisa sure kilitlemez', async () => {
    let now = 1_000_000;
    const bio = fakeBiometrics();
    await coldStart({ bio, now: () => now });
    await waitFor(() => expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull());

    await emitAppState('background');
    now += 2 * 60_000;
    await emitAppState('active');
    expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull();

    bio.state.results.push({ ok: false, error: 'user_cancel' });
    await emitAppState('background');
    now += 5 * 60_000;
    await emitAppState('active');
    expect(await screen.findByRole('header', { name: 'Uygulama kilitli' })).toBeTruthy();
  });

  it('cihazda kayitli biyometri yoksa kilit kapanir ve uygulama geneli not gosterilir', async () => {
    const { services, storage, sub } = await coldStart({ bio: fakeBiometrics({ enrolled: false }) });
    await waitFor(() => expect(services.notices.get()?.message).toMatch(/uygulama kilidi kapatıldı/));
    expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull();
    expect(JSON.parse(storage.data.get(lockStorageKey(sub)) ?? '{}').enabled).toBe(false);
  });

  it('vazgecildikten sonra inactive -> active yeni istem acmaz; "Kilidi aç" bekler', async () => {
    const bio = fakeBiometrics();
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    await coldStart({ bio });
    expect(await screen.findByText(/Doğrulama iptal edildi/)).toBeTruthy();
    await emitAppState('inactive');
    await emitAppState('active');
    await act(async () => undefined);
    expect(bio.state.prompts).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Kilidi aç' })).toBeTruthy();
  });

  it('kilitliyken diger pencereler (Sheet) gizli; kilit acilinca geri gelir', async () => {
    const bio = fakeBiometrics();
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    await coldStart({ bio });
    await screen.findByText(/Doğrulama iptal edildi/);
    expect(screen.queryByText('Pencere içeriği')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Kilidi aç' }));
    expect(await screen.findByText('Pencere içeriği')).toBeTruthy();
  });

  it('gizlilik ortusu: kilit aciksa inactive / background icerigi logoyla orter, kisa donuste kalkar', async () => {
    let now = 1_000_000;
    await coldStart({ now: () => now });
    await waitFor(() => expect(screen.queryByRole('header', { name: 'Uygulama kilitli' })).toBeNull());
    expect(screen.getByText('Pencere içeriği')).toBeTruthy();
    await emitAppState('inactive');
    expect(screen.getByLabelText('YÖNESİST')).toBeTruthy();
    expect(screen.queryByText('Pencere içeriği')).toBeNull();
    await emitAppState('background');
    now += 30_000;
    await emitAppState('active');
    expect(screen.queryByLabelText('YÖNESİST')).toBeNull();
    expect(screen.getByText('Pencere içeriği')).toBeTruthy();
  });

  it('kilit kapaliysa ortu yok', async () => {
    await coldStart({ enabled: false });
    await waitFor(() => expect(screen.getByText('Pencere içeriği')).toBeTruthy());
    await emitAppState('inactive');
    expect(screen.queryByLabelText('YÖNESİST')).toBeNull();
  });
});
