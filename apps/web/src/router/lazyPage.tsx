import { type ComponentType, type LazyExoticComponent, type ReactNode, Suspense, lazy } from 'react';
import { Skeleton } from '@/components/ui';
import { loadWithReload } from '@/lib/chunkReload';

/**
 * Sayfa bazli kod bolme. Her ekran ayri bir JS parcasidir ve yalnizca o rotaya girilince
 * indirilir; sakin, ilk acilista yonetim panelinin (finans, sayac, Excel aktarimi...) kodunu
 * indirmez. Yukleme hatasinda tek seferlik yenileme: `lib/chunkReload.ts` (acilisla ortak).
 */
export { isChunkLoadError, loadWithReload } from '@/lib/chunkReload';

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
