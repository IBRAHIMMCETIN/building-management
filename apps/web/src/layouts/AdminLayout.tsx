import { ArrowLeftRight, Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { BrandMark } from '@/components/BrandMark';
import { ContextSwitchDialog, useCanSwitchContext } from '@/components/context/ContextSwitcher';
import { MfaGraceBanner } from '@/components/MfaGraceBanner';
import { SupportBanner } from '@/components/support/SupportBanner';
import { SubscriptionBanner } from '@/components/subscription/SubscriptionBanner';
import { Button, Dialog } from '@/components/ui';
import { useActiveApartmentName } from '@/hooks/useActiveContextLabel';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolioAccess } from '@/hooks/usePortfolio';
import { SiteFeaturesProvider, useSiteFeatures } from '@/context/SiteFeaturesContext';
import { ROLE_LABELS } from '@/types/roles';
import { navItemsFor, panelTitleFor } from './adminNav';
import { cn } from '@/lib/cn';
import { UserMenu } from './UserMenu';
import { PageSuspense } from '@/router/lazyPage';

/** Masaustu yan menu ve mobil cekmece ayni listeyi kullanir. */
function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const { showInNav } = usePortfolioAccess();
  const { isEnabled } = useSiteFeatures();
  const items = navItemsFor(user?.role, showInNav, isEnabled);
  return (
    <nav aria-label="Yönetim menüsü" className="flex flex-col gap-1">
      {items.map(({ to, label, icon: Icon, end }) => (
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
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  const { user } = useAuth();
  return (
    <div className="flex items-center gap-2">
      <BrandMark className="size-8" />
      <span className="font-semibold text-text">{panelTitleFor(user?.role)}</span>
    </div>
  );
}

/** md (768px) ve ustu: kalici yan menu. Alti: hamburger + soldan cekmece. */
const DESKTOP_QUERY = '(min-width: 48rem)';

/** Adim 1: menu, rota ve ekranlar aktif sitenin ozellik anahtarlarini bu saglayicidan okur. */
export function AdminLayout() {
  return (
    <SiteFeaturesProvider>
      <AdminShell />
    </SiteFeaturesProvider>
  );
}

function AdminShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { pathname } = useLocation();
  const { user } = useAuth();
  const apartmentName = useActiveApartmentName();
  const canSwitch = useCanSwitchContext();

  // Cekmeceden secici: once cekmece kapanir, ardindan modal acilir (iki modal ust uste binmez).
  const openSwitcherFromMenu = () => {
    setMenuOpen(false);
    setSwitcherOpen(true);
  };

  // Sayfa degisince (geri tusu dahil) cekmece kapanir.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Ekran masaustu genisligine buyurse acik cekmece ortada kalmasin.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMenuOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="flex min-h-dvh">
      {/* Kisa ekranda (ör. 1366x768 dizustu) uzun menu kendi icinde kayar; ogeler sikismaz / kesilmez. */}
      <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface px-3 pb-4 md:flex">
        <div className="flex h-16 items-center px-3">
          <Brand />
        </div>
        <AdminNav />
      </aside>

      {/*
        Icerik sutunu: min-w-0 + overflow-x-clip -> genis tablo / cekmece icerigi sutunu ve ust bari
        genisletemez (clip, hidden'in aksine kaydirma kutusu acmaz; sticky header calismaya devam eder).
      */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">
        <header className="sticky top-0 z-10 flex h-16 w-full min-w-0 items-center justify-between gap-2 overflow-x-hidden border-b border-border bg-surface px-2 sm:px-4 md:justify-end md:px-6 lg:px-8">
          <div className="flex min-w-0 shrink items-center gap-1 md:hidden">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Menüyü aç"
              aria-expanded={menuOpen}
              aria-controls="admin-mobile-nav"
              className="grid size-10 shrink-0 place-items-center rounded-md text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
            <BrandMark className="size-7" />
            <span className="truncate font-semibold">{panelTitleFor(user?.role)}</span>
          </div>
          <UserMenu sidebar />
        </header>
        <SupportBanner />
        <MfaGraceBanner />
        <SubscriptionBanner />
        <main className="mx-auto w-full min-w-0 max-w-page flex-1 px-4 py-8 md:px-8">
          <PageSuspense>
            <Outlet />
          </PageSuspense>
        </main>
      </div>

      <Dialog
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="Yönetim menüsü"
        hideTitle
        variant="sheet"
        className="md:hidden"
      >
        <div id="admin-mobile-nav" className="flex min-h-full flex-col gap-4">
          <div className="px-3">
            <Brand />
          </div>

          {user?.role && (
            <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-muted p-3">
              <div className="min-w-0">
                <p className="truncate text-small font-medium">{apartmentName ?? user.email}</p>
                <p className="text-small text-muted">{ROLE_LABELS[user.role]}</p>
              </div>
              {canSwitch && (
                <Button variant="secondary" size="sm" className="w-full" onClick={openSwitcherFromMenu}>
                  <ArrowLeftRight className="size-4" aria-hidden="true" />
                  Apartman / Rol Değiştir
                </Button>
              )}
            </div>
          )}

          <AdminNav onNavigate={() => setMenuOpen(false)} />
        </div>
      </Dialog>

      <ContextSwitchDialog open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  );
}
