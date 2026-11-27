import { Ellipsis } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { BrandMark } from '@/components/BrandMark';
import { Dialog } from '@/components/ui';
import { PortalUnitProvider } from '@/context/PortalUnitContext';
import { useActiveApartmentName } from '@/hooks/useActiveContextLabel';
import { BRAND_NAME } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { isMoreActive, splitResidentNav } from './residentNav';
import { UserMenu } from './UserMenu';
import { PageSuspense } from '@/router/lazyPage';

/**
 * Sol ust marka: aktif sitenin adi (baglam listesi yuklenince), yoksa urun markasi. Uzun site
 * adlari kesilir; UserMenu dugmeleri daralmaz.
 */
export function PortalBrand() {
  const siteName = useActiveApartmentName();
  return (
    <div className="flex min-w-0 items-center gap-2" title={siteName ? `${siteName} · ${BRAND_NAME}` : BRAND_NAME}>
      <BrandMark className="size-7" />
      <span className="truncate font-semibold">{siteName ?? BRAND_NAME}</span>
    </div>
  );
}

const tabClass = 'flex min-w-0 flex-col items-center gap-1 px-0.5 py-2 text-xs text-muted sm:text-small';

/** Mobil oncelikli: ust bar + altta sekme cubugu (PWA'da ana ekrandan acilinca da rahat). */
export function ResidentLayout() {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const { primary, more } = splitResidentNav();
  const moreActive = isMoreActive(pathname, more);

  // Sayfa degisince (geri tusu dahil) cekmece kapanir.
  useEffect(() => setMoreOpen(false), [pathname]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-14 min-w-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
        <PortalBrand />
        <UserMenu />
      </header>

      <main className="mx-auto w-full max-w-content flex-1 px-4 pt-6 pb-24">
        <PortalUnitProvider>
          <PageSuspense>
            <Outlet />
          </PageSuspense>
        </PortalUnitProvider>
      </main>

      <nav
        aria-label="Sakin menüsü"
        className="fixed inset-x-0 bottom-0 z-10 grid auto-cols-fr grid-flow-col border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {primary.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cn(tabClass, isActive && 'text-accent')}>
            <Icon className="size-5" aria-hidden="true" />
            {/* Sekmeler dar telefonda da tek satir: uzun etiket kirpilir. */}
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        ))}
        {more.length > 0 && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={cn(tabClass, 'cursor-pointer', moreActive && 'text-accent')}
          >
            <Ellipsis className="size-5" aria-hidden="true" />
            <span className="max-w-full truncate">Diğer</span>
          </button>
        )}
      </nav>

      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="Diğer" variant="sheet">
        <nav aria-label="Diğer sayfalar" className="flex flex-col gap-1">
          {more.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2.5 text-small text-muted hover:bg-surface-muted hover:text-text',
                  isActive && 'bg-surface-muted font-medium text-text [&>svg]:text-accent',
                )
              }
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </Dialog>
    </div>
  );
}
