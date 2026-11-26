import { Building2 } from 'lucide-react';
import { Outlet } from 'react-router';
import { ApiStatus } from '@/components/ApiStatus';
import { cn } from '@/lib/cn';
import { BRAND_NAME } from '@/lib/brand';

export function AuthLayout({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex items-center gap-2 text-accent">
        <Building2 className="size-8" aria-hidden="true" />
        <span className="text-heading font-semibold text-text">{BRAND_NAME}</span>
      </div>
      <main className={cn('w-full', wide ? 'max-w-md' : 'max-w-sm')}>
        <Outlet />
      </main>
      <footer>
        <ApiStatus />
      </footer>
    </div>
  );
}
