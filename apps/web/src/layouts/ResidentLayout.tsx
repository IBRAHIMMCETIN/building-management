import { Home, Megaphone, Receipt } from 'lucide-react';
import type { ComponentType } from 'react';
import { NavLink, Outlet } from 'react-router';
import { PortalUnitProvider } from '@/context/PortalUnitContext';
import { cn } from '@/lib/cn';
import { UserMenu } from './UserMenu';

type NavItem = { to: string; label: string; icon: ComponentType<{ className?: string }>; end?: boolean };

const NAV: NavItem[] = [
  { to: '/app', label: 'Ana Sayfa', icon: Home, end: true },
  { to: '/app/dues', label: 'Borçlarım', icon: Receipt },
  { to: '/app/announcements', label: 'Duyurular', icon: Megaphone },
];

/** Mobil oncelikli: ust bar + altta sekme cubugu (PWA'da ana ekrandan acilinca da rahat). */
export function ResidentLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-surface px-4">
        <span className="font-semibold">Aidat Yönetim</span>
        <UserMenu />
      </header>

      <main className="mx-auto w-full max-w-content flex-1 px-4 pt-6 pb-24">
        <PortalUnitProvider>
          <Outlet />
        </PortalUnitProvider>
      </main>

      <nav
        aria-label="Sakin menüsü"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-3 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn('flex flex-col items-center gap-1 py-2 text-small text-muted', isActive && 'text-accent')
            }
          >
            <Icon className="size-5" aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
