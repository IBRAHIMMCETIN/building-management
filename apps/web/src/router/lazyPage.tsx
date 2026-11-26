import { type ComponentType, type LazyExoticComponent, type ReactNode, Suspense, lazy } from 'react';
import { Skeleton } from '@/components/ui';

/**
 * Sayfa bazli kod bolme. Her ekran ayri bir JS parcasidir ve yalnizca o rotaya girilince
 * indirilir; sakin, ilk acilista yonetim panelinin (finans, sayac, Excel aktarimi...) kodunu
 * indirmez.
 *
 * Yeni surum yayinlaninca eski parca adlari (hash) sunucudan kalkar; acik sekmedeki kullanici
 * eski parcayi isterse yukleme hatasi alir. Bu durumda sayfa bir kez yenilenir (yeni index.html
 * yeni parcalari getirir); ikinci hatada hata sayfasi gosterilir (sonsuz yenileme yok).
 */
const RELOAD_KEY = 'bm:chunk-reload';

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

/** `lazyPage(() => import('@/pages/x/XPage'), 'XPage')`: adlandirilmis disa aktarimla React.lazy. */
export function lazyPage<K extends string, M extends { [P in K]: ComponentType }>(load: () => Promise<M>, name: K): LazyExoticComponent<M[K]> {
  return lazy(async () => ({ default: (await loadWithReload(load))[name] }));
}

/** Sayfa parcasi inerken gosterilen iskelet (yerlesim - menu, ust bar - yerinde kalir). */
export function PageFallback() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Sayfa yükleniyor">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32" />
      <Skeleton className="h-64" />
    </div>
  );
}

export function PageSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}
