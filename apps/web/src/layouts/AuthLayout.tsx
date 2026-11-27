import { Outlet } from 'react-router';
import { ApiStatus } from '@/components/ApiStatus';
import { BrandMark, BrandWordmark } from '@/components/BrandMark';
import { cn } from '@/lib/cn';
import { PageSuspense } from '@/router/lazyPage';

export function AuthLayout({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex flex-col items-center gap-3">
        <BrandMark className="size-16" />
        <BrandWordmark tagline className="text-title" />
      </div>
      <main className={cn('w-full', wide ? 'max-w-md' : 'max-w-sm')}>
        <PageSuspense>
          <Outlet />
        </PageSuspense>
      </main>
      <footer>
        <ApiStatus />
      </footer>
    </div>
  );
}
