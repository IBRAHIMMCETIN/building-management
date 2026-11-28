import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHUNK, INSTALL_FLAG_KEY, createSecureStorage, encodeKey } from './secureStorage';

const mockStore = new Map<string, string>();
const mockAllowed = /^[A-Za-z0-9._-]+$/;
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    // Gercek SecureStore gibi: gecersiz anahtar ve ~2 KB ustu deger reddedilir.
    if (!mockAllowed.test(k)) throw new Error(`gecersiz anahtar ${k}`);
    if (v.length > 2048) throw new Error('deger cok buyuk');
    mockStore.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

const refreshToken = 'r'.repeat(CHUNK * 2 + 123);

beforeEach(async () => {
  mockStore.clear();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(INSTALL_FLAG_KEY, '1');
});

describe('guvenli depo (expo-secure-store)', () => {
  it('buyuk degerleri parcalar, gecersiz karakterli anahtarlari geri donusumlu kacirir', async () => {
    const storage = createSecureStorage();
    const key = 'CognitoIdentityServiceProvider.client.ayse@site.com.refreshToken';
    await storage.setItem(key, refreshToken);
    expect(await storage.getItem(key)).toBe(refreshToken);
    expect([...mockStore.keys()].every((k) => mockAllowed.test(k))).toBe(true);
    expect([...mockStore.keys()].filter((k) => k.startsWith(`${encodeKey(key)}.1.`))).toHaveLength(3);
    // `_` da kacirilir: "a_b" ile "a@b" ayni anahtara dusmez.
    expect(encodeKey('a_b')).not.toBe(encodeKey('a@b'));
  });

  it('uzerine yazarken eski parcalar yeni deger yazildiktan sonra silinir', async () => {
    const storage = createSecureStorage();
    await storage.setItem('k', refreshToken);
    await storage.setItem('k', 'kisa');
    expect(await storage.getItem('k')).toBe('kisa');
    expect([...mockStore.keys()].filter((k) => k.startsWith(`${encodeKey('k')}.`)).sort()).toEqual([`${encodeKey('k')}.2.0`, `${encodeKey('k')}.m`]);
  });

  it('yazim yarida kalirsa eski deger okunur (yarim deger okunmaz)', async () => {
    const storage = createSecureStorage();
    await storage.setItem('k', 'eski');
    const SecureStore = jest.requireMock<{ setItemAsync: jest.Mock }>('expo-secure-store');
    SecureStore.setItemAsync.mockImplementationOnce(async (k: string, v: string) => void mockStore.set(k, v)).mockRejectedValueOnce(new Error('kilitli'));
    await expect(storage.setItem('k', refreshToken)).rejects.toThrow('kilitli');
    expect(await storage.getItem('k')).toBe('eski');
  });

  it('eszamanli yazimlar sirayla islenir; anahtar listesi eksiksiz; clear hepsini siler', async () => {
    const storage = createSecureStorage();
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => storage.setItem(k, `${k}-deger`)));
    expect(await Promise.all(['a', 'b', 'c', 'd'].map((k) => storage.getItem(k)))).toEqual(['a-deger', 'b-deger', 'c-deger', 'd-deger']);
    await storage.removeItem('b');
    expect(await storage.getItem('b')).toBeNull();
    await storage.clear();
    expect(mockStore.size).toBe(0);
  });

  it('yeniden kurulumda (isaret yok) Keychain\'de kalan onceki oturum silinir', async () => {
    await createSecureStorage().setItem('CognitoIdentityServiceProvider.client.LastAuthUser', 'onceki');
    await AsyncStorage.removeItem(INSTALL_FLAG_KEY); // uygulama silindi: AsyncStorage gitti, Keychain kaldi

    const fresh = createSecureStorage();
    expect(await fresh.getItem('CognitoIdentityServiceProvider.client.LastAuthUser')).toBeNull();
    expect(await AsyncStorage.getItem(INSTALL_FLAG_KEY)).toBe('1');
    // Sonraki acilislarda silinmez.
    await fresh.setItem('x', '1');
    expect(await createSecureStorage().getItem('x')).toBe('1');
  });
});
