import * as SecureStore from 'expo-secure-store';
import type { KeyValueStorage } from './types';

/*
 * Token deposu (iOS Keychain / Android Keystore, expo-secure-store). Amplify'in Cognito
 * token'lari ve oturum bilgisi burada tutulur; AsyncStorage'a (sifresiz) yazilmaz.
 *  - SecureStore anahtarlari yalnizca [A-Za-z0-9._-] kabul eder: diger karakterler geri
 *    donusumlu kacirilir (Amplify anahtarlarinda kullanici adi / e-posta bulunabilir).
 *  - Deger siniri ~2 KB: Cognito refresh token'i buna yakin oldugundan degerler parcalara bolunur.
 *  - Erisim: cihaz ilk kilit acildiktan sonra, YALNIZCA bu cihaz (yedekle baska cihaza tasinmaz).
 *  - `clear()` icin yazilan anahtarlarin listesi ayri bir kayitta tutulur.
 * Web onizlemesi: secureStorage.web.ts (localStorage).
 */

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const CHUNK = 1800;
const INDEX_KEY = 'bm.ss.index';

/** Gecersiz karakterleri `_xx_` (onaltilik) bicimine cevirir; `_` de kacirilir ki donusum tekil olsun. */
export function encodeKey(key: string): string {
  return `bm.ss.${key.replace(/[^A-Za-z0-9.-]/g, (ch) => `_${ch.codePointAt(0)?.toString(16)}_`)}`;
}

async function readIndex(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY, OPTIONS);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(keys: string[]): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(keys), OPTIONS);
}

async function removeChunks(base: string): Promise<void> {
  const count = Number(await SecureStore.getItemAsync(`${base}.n`, OPTIONS));
  for (let i = 0; i < (Number.isFinite(count) ? count : 0); i++) await SecureStore.deleteItemAsync(`${base}.${i}`, OPTIONS);
  await SecureStore.deleteItemAsync(`${base}.n`, OPTIONS);
}

export const secureStorage: KeyValueStorage = {
  async setItem(key, value) {
    const base = encodeKey(key);
    await removeChunks(base);
    const parts = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < parts; i++) await SecureStore.setItemAsync(`${base}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), OPTIONS);
    await SecureStore.setItemAsync(`${base}.n`, String(parts), OPTIONS);
    const index = await readIndex();
    if (!index.includes(key)) await writeIndex([...index, key]);
  },

  async getItem(key) {
    const base = encodeKey(key);
    const count = Number(await SecureStore.getItemAsync(`${base}.n`, OPTIONS));
    if (!Number.isInteger(count) || count < 1) return null;
    let value = '';
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${base}.${i}`, OPTIONS);
      if (part === null) return null;
      value += part;
    }
    return value;
  },

  async removeItem(key) {
    await removeChunks(encodeKey(key));
    const index = await readIndex();
    if (index.includes(key)) await writeIndex(index.filter((k) => k !== key));
  },

  async clear() {
    for (const key of await readIndex()) await removeChunks(encodeKey(key));
    await SecureStore.deleteItemAsync(INDEX_KEY, OPTIONS);
  },
};
