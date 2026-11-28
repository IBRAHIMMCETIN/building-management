import type { KeyValueStorage } from './types';

/*
 * Web onizlemesi (react-native-web): tarayicida guvenli depo yoktur; web uygulamasiyla ayni
 * sekilde localStorage kullanilir (apps/web: Amplify varsayilani). Yalnizca onizleme icindir;
 * cihazdaki uygulama secureStorage.ts (Keychain / Keystore) kullanir.
 */
const PREFIX = 'bm.ss.';

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function encodeKey(key: string): string {
  return PREFIX + key;
}

export const secureStorage: KeyValueStorage = {
  async setItem(key, value) {
    local()?.setItem(encodeKey(key), value);
  },
  async getItem(key) {
    return local()?.getItem(encodeKey(key)) ?? null;
  },
  async removeItem(key) {
    local()?.removeItem(encodeKey(key));
  },
  async clear() {
    const store = local();
    if (!store) return;
    for (const k of Object.keys(store)) if (k.startsWith(PREFIX)) store.removeItem(k);
  },
};
