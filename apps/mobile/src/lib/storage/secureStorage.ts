import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { KeyValueStorage } from './types';

/*
 * Token deposu (iOS Keychain / Android Keystore, expo-secure-store). Amplify'in Cognito token'lari ve
 * oturum bilgisi burada tutulur; AsyncStorage'a (sifresiz) yazilmaz.
 *  - SecureStore anahtarlari yalnizca [A-Za-z0-9._-] kabul eder: diger karakterler geri donusumlu
 *    kacirilir (Amplify anahtarlarinda kullanici adi / e-posta bulunabilir).
 *  - Deger siniri ~2 KB: Cognito refresh token'i buna yakin oldugundan degerler parcalara bolunur.
 *    Yeni parcalar ONCE yazilir, sonra gosterge (`.m`) yeni nesle gecer, en son eski parcalar silinir:
 *    yazim yarida kalirsa eski deger okunur, yarim deger okunmaz.
 *  - Tum islemler sirayla calisir (anahtar listesi guncellemeleri birbirini ezmez).
 *  - Erisim: cihaz ilk kilit acildiktan sonra, YALNIZCA bu cihaz (yedekle baska cihaza tasinmaz).
 *  - iOS Keychain uygulama silinince kalir: yeniden kurulumda (AsyncStorage isareti yok) onceki
 *    kullanicinin oturumu geri gelmesin diye ilk calistirmada depo temizlenir.
 * Web onizlemesi: secureStorage.web.ts (localStorage).
 */

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
export const CHUNK = 1800;
const INDEX_KEY = 'bm.ss.index';
export const INSTALL_FLAG_KEY = 'bm.installed';

type Meta = { g: number; n: number };

/** Gecersiz karakterleri `_xx_` (onaltilik) bicimine cevirir; `_` de kacirilir ki donusum tekil olsun. */
export function encodeKey(key: string): string {
  return `bm.ss.${key.replace(/[^A-Za-z0-9.-]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`)}`;
}

export function createSecureStorage(): KeyValueStorage {
  let queue: Promise<unknown> = Promise.resolve();
  let prepared: Promise<void> | null = null;

  /** Islemleri siraya koyar (onceki hata sonrakini durdurmaz). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(() => prepare()).then(fn);
    queue = run.catch(() => undefined);
    return run;
  }

  const get = (k: string) => SecureStore.getItemAsync(k, OPTIONS);
  const put = (k: string, v: string) => SecureStore.setItemAsync(k, v, OPTIONS);
  const del = (k: string) => SecureStore.deleteItemAsync(k, OPTIONS);

  async function readIndex(): Promise<string[]> {
    try {
      const raw = await get(INDEX_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  async function readMeta(base: string): Promise<Meta | null> {
    try {
      const raw = await get(`${base}.m`);
      const meta = raw ? (JSON.parse(raw) as Meta) : null;
      return meta && Number.isInteger(meta.g) && Number.isInteger(meta.n) && meta.n > 0 ? meta : null;
    } catch {
      return null;
    }
  }

  async function deleteChunks(base: string, meta: Meta) {
    for (let i = 0; i < meta.n; i++) await del(`${base}.${meta.g}.${i}`);
  }

  async function removeValue(key: string) {
    const base = encodeKey(key);
    const meta = await readMeta(base);
    await del(`${base}.m`);
    if (meta) await deleteChunks(base, meta);
  }

  async function wipe() {
    for (const key of await readIndex()) await removeValue(key);
    await del(INDEX_KEY);
  }

  function prepare(): Promise<void> {
    prepared ??= (async () => {
      try {
        if (await AsyncStorage.getItem(INSTALL_FLAG_KEY)) return;
        await wipe();
        await AsyncStorage.setItem(INSTALL_FLAG_KEY, '1');
      } catch {
        // Depoya erisilemezse (ornek: kilitli cihaz) normal akis devam eder.
      }
    })();
    return prepared;
  }

  return {
    setItem: (key, value) =>
      serial(async () => {
        const base = encodeKey(key);
        const old = await readMeta(base);
        const g = (old?.g ?? 0) + 1;
        const n = Math.max(1, Math.ceil(value.length / CHUNK));
        for (let i = 0; i < n; i++) await put(`${base}.${g}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
        await put(`${base}.m`, JSON.stringify({ g, n } satisfies Meta));
        if (old) await deleteChunks(base, old);
        const index = await readIndex();
        if (!index.includes(key)) await put(INDEX_KEY, JSON.stringify([...index, key]));
      }),

    getItem: (key) =>
      serial(async () => {
        const base = encodeKey(key);
        const meta = await readMeta(base);
        if (!meta) return null;
        let value = '';
        for (let i = 0; i < meta.n; i++) {
          const part = await get(`${base}.${meta.g}.${i}`);
          if (part === null) return null;
          value += part;
        }
        return value;
      }),

    removeItem: (key) =>
      serial(async () => {
        await removeValue(key);
        const index = await readIndex();
        if (index.includes(key)) await put(INDEX_KEY, JSON.stringify(index.filter((k) => k !== key)));
      }),

    clear: () => serial(wipe),
  };
}

export const secureStorage: KeyValueStorage = createSecureStorage();
