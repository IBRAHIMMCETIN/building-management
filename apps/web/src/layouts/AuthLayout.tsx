import { Landmark, Receipt, Users, Wrench } from 'lucide-react';
import { Outlet } from 'react-router';
import { ApiStatus } from '@/components/ApiStatus';
import { BrandMark, BrandWordmark } from '@/components/BrandMark';
import { cn } from '@/lib/cn';
import { PageSuspense } from '@/router/lazyPage';

/** Masaustu marka panelindeki kisa urun ozeti. */
const HIGHLIGHTS = [
  { icon: Receipt, text: 'Aidat, tahsilat ve gider takibi' },
  { icon: Wrench, text: 'Arıza, bakım ve ekipman yönetimi' },
  { icon: Landmark, text: 'Genel kurul, oylama ve ihale' },
  { icon: Users, text: 'Sakinler için çevrim içi portal' },
] as const;

function Brand({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <BrandMark className="size-16 lg:size-20" />
      <BrandWordmark tagline className="text-title" />
    </div>
  );
}

/**
 * Giris / sifre / baglam secimi sayfalari. Telefonda: ortada marka, form ve API durumu alt alta.
 * Genis ekranda (lg) web sitesi duzeni: solda marka paneli (yan menuyle ayni yuzey / kenarlik),
 * sagda form.
 */
export function AuthLayout({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <div className="hidden border-r border-border bg-surface px-12 lg:flex lg:w-1/2 lg:flex-col lg:items-center lg:justify-center">
        <div className="flex max-w-md flex-col gap-10">
          <Brand />
          <ul className="flex flex-col gap-4 text-body text-text-secondary">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <Icon className="size-5 shrink-0 text-accent" aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
        <Brand className="lg:hidden" />
        <main className={cn('w-full', wide ? 'max-w-md' : 'max-w-sm')}>
          <PageSuspense>
            <Outlet />
          </PageSuspense>
        </main>
        <footer>
          <ApiStatus />
        </footer>
      </div>
    </div>
  );
}
