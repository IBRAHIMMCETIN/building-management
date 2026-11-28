/**
 * Dinamik import (kod parcasi) yukleme hatasinda tek seferlik sayfa yenileme.
 *
 * Yeni surum yayinlaninca eski parca adlari (hash) sunucudan kalkar; acik sekmedeki kullanici
 * eski parcayi isterse yukleme hatasi alir. Bu durumda sayfa bir kez yenilenir (yeni index.html
 * yeni parcalari getirir); ikinci hatada hata yukari firlatilir (sonsuz yenileme yok). Bayrak sekme
 * bazlidir (sessionStorage) ve basarili yuklemede silinir. Hem acilis (`main.tsx`) hem sayfa parcalari
 * (`router/lazyPage.tsx`) kullanir; bu modul bilincli olarak bagimliliksizdir (acilis paketi kucuk kalir).
 */
export const RELOAD_KEY = 'bm:chunk-reload';

export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(message);
}

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export async function loadWithReload<M>(load: () => Promise<M>): Promise<M> {
  try {
    const mod = await load();
    storage()?.removeItem(RELOAD_KEY);
    return mod;
  } catch (err) {
    const s = storage();
    if (isChunkLoadError(err) && s && !s.getItem(RELOAD_KEY)) {
      s.setItem(RELOAD_KEY, String(Date.now()));
      window.location.reload();
      // Yenileme surerken hicbir sey render edilmez.
      return new Promise<M>(() => undefined);
    }
    throw err;
  }
}
