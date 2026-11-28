import { Ellipsis } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { BrandMark } from '@/components/BrandMark';
import { Dialog } from '@/components/ui';
import { PortalUnitProvider } from '@/context/PortalUnitContext';
import { SiteFeaturesProvider, useSiteFeatures } from '@/context/SiteFeaturesContext';
import { useActiveApartmentName, useIsActiveOwner } from '@/hooks/useActiveContextLabel';
import { BRAND_NAME } from '@/lib/brand';
import { cn } from '@/lib/cn';
import type { NavItem } from './adminNav';
import { isMoreActive, residentNavFor, splitResidentNav } from './residentNav';
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

/** Masaustu yan menu ve mobil "Diğer" cekmecesi ayni listeyi kullanir (AdminLayout'taki AdminNav gibi). */
function ResidentNavList({ items, label, onNavigate }: { items: readonly NavItem[]; label: string; onNavigate?: () => void }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-1">
      {items.map(({ to, label: itemLabel, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2.5 text-small text-muted hover:bg-surface-muted hover:text-text md:py-2',
              isActive && 'bg-surface-muted font-medium text-text [&>svg]:text-accent',
            )
          }
        >
          <Icon className="size-4" aria-hidden="true" />
          {itemLabel}
        </NavLink>
      ))}
    </nav>
  );
}

const tabClass = 'flex min-w-0 flex-col items-center gap-1 px-0.5 py-2 text-xs text-muted sm:text-small';

/** md (768px) ve ustu: kalici yan menu (yonetim paneliyle ayni). Alti: ust bar + alt sekme cubugu. */
const DESKTOP_QUERY = '(min-width: 48rem)';

/**
 * Sakin portali. Masaustunde web sitesi duzeni: solda tum sayfalarin yan menusu, genis icerik
 * (max-w-page). Telefonda: ust bar + altta sekme cubugu ve "Diğer" cekmecesi (PWA'da ana ekrandan
 * acilinca da rahat).
 */
export function ResidentLayout() {
  // Adim 1: menu, rota ve ekranlar aktif sitenin ozellik anahtarlarini bu saglayicidan okur.
  return (
    <SiteFeaturesProvider>
      <ResidentShell />
    </SiteFeaturesProvider>
  );
}

function ResidentShell() {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const { isEnabled } = useSiteFeatures();
  // Genel Kurul yalnizca malik uyeligi olana (kiraciya menude gorunmez; API de 403 doner).
  // Adim 1: `feature` tasiyan oge yalnizca site ozelligi acikken gorunur.
  const items = residentNavFor(useIsActiveOwner()).filter((i) => !i.feature || isEnabled(i.feature));
  const { primary, more } = splitResidentNav(items);
  const moreActive = isMoreActive(pathname, more);

  // Sayfa degisince (geri tusu dahil) cekmece kapanir.
  useEffect(() => setMoreOpen(false), [pathname]);

  // Ekran masaustu genisligine buyurse acik cekmece ortada kalmasin.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMoreOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface px-3 pb-4 md:flex">
        <div className="flex h-16 items-center px-3">
          <PortalBrand />
        </div>
        <ResidentNavList items={items} label="Sakin menüsü" />
      </aside>

      {/* Icerik sutunu: min-w-0 + overflow-x-clip -> genis icerik ust bari ve sutunu genisletemez. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">
        <header className="sticky top-0 z-10 flex h-14 w-full min-w-0 items-center justify-between gap-3 overflow-x-hidden border-b border-border bg-surface px-4 md:h-16 md:justify-end md:px-6 lg:px-8">
          <div className="min-w-0 md:hidden">
            <PortalBrand />
          </div>
          <UserMenu sidebar />
        </header>

        <main className="mx-auto w-full min-w-0 max-w-page flex-1 px-4 pt-6 pb-24 md:px-8 md:py-8">
          <PortalUnitProvider>
            <PageSuspense>
              <Outlet />
            </PageSuspense>
          </PortalUnitProvider>
        </main>
      </div>

      <nav
        aria-label="Sakin menüsü"
        className="fixed inset-x-0 bottom-0 z-10 grid auto-cols-fr grid-flow-col border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
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

      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="Diğer" variant="sheet" className="md:hidden">
        <ResidentNavList items={more} label="Diğer sayfalar" onNavigate={() => setMoreOpen(false)} />
      </Dialog>
    </div>
  );
}
