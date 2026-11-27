import { Building2, DoorOpen, Gauge, Home, Megaphone, Receipt, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';
import { NavLink, Outlet } from 'react-router';
import { PortalUnitProvider } from '@/context/PortalUnitContext';
import { useActiveApartmentName } from '@/hooks/useActiveContextLabel';
import { BRAND_NAME } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { UserMenu } from './UserMenu';
import { PageSuspense } from '@/router/lazyPage';

type NavItem = { to: string; label: string; icon: ComponentType<{ className?: string }>; end?: boolean };

const NAV: NavItem[] = [
  { to: '/app', label: 'Ana Sayfa', icon: Home, end: true },
  { to: '/app/dues', label: 'Borçlarım', icon: Receipt },
  { to: '/app/talepler', label: 'Talepler', icon: Wrench },
  { to: '/app/ziyaretci', label: 'Ziyaretçi', icon: DoorOpen },
  { to: '/app/tuketim', label: 'Tüketimim', icon: Gauge },
  { to: '/app/announcements', label: 'Duyurular', icon: Megaphone },
];

/**
 * Sol ust marka: aktif sitenin adi (baglam listesi yuklenince), yoksa urun markasi. Uzun site
 * adlari kesilir; UserMenu dugmeleri daralmaz.
 */
export function PortalBrand() {
  const siteName = useActiveApartmentName();
  return (
    <div className="flex min-w-0 items-center gap-2" title={siteName ? `${siteName} · ${BRAND_NAME}` : BRAND_NAME}>
      <Building2 className="size-5 shrink-0 text-accent" aria-hidden="true" />
      <span className="truncate font-semibold">{siteName ?? BRAND_NAME}</span>
    </div>
  );
}

/** Mobil oncelikli: ust bar + altta sekme cubugu (PWA'da ana ekrandan acilinca da rahat). */
export function ResidentLayout() {
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
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-6 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn('flex min-w-0 flex-col items-center gap-1 px-0.5 py-2 text-xs text-muted sm:text-small', isActive && 'text-accent')
            }
          >
            <Icon className="size-5" aria-hidden="true" />
            {/* Alti sekme dar telefonda da tek satir: uzun etiket kirpilir. */}
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
