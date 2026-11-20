import { ArrowLeftRight, Building2, CreditCard, FileUp, LayoutDashboard, Megaphone, Menu, Settings, Users, Wallet } from 'lucide-react';
import { type ComponentType, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ContextSwitchDialog, useCanSwitchContext } from '@/components/context/ContextSwitcher';
import { Button, Dialog } from '@/components/ui';
import { useActiveApartmentName } from '@/hooks/useActiveContextLabel';
import { useAuth } from '@/hooks/useAuth';
import { PLATFORM_ROLES, ROLE_LABELS, type Role } from '@/types/roles';
import { cn } from '@/lib/cn';
import { UserMenu } from './UserMenu';

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  /** Verilirse yalnizca bu roller gorur. */
  roles?: readonly Role[];
};

// Henuz ekrani olmayan ogeler router'da PlaceholderPage'e bagli; ekran yazildikca degistirilir.
const NAV: NavItem[] = [
  { to: '/admin', label: 'Genel Bakış', icon: LayoutDashboard, end: true },
  { to: '/admin/units', label: 'Daireler', icon: Users },
  { to: '/admin/finance', label: 'Finans', icon: Wallet },
  { to: '/admin/announcements', label: 'Duyurular', icon: Megaphone },
  { to: '/admin/import', label: 'Toplu Aktarım', icon: FileUp },
  { to: '/admin/settings', label: 'Ayarlar', icon: Settings },
  { to: '/admin/payments', label: 'Ödeme Hesapları', icon: CreditCard, roles: PLATFORM_ROLES },
];

/** Masaustu yan menu ve mobil cekmece ayni listeyi kullanir. */
function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const items = NAV.filter((n) => !n.roles || (!!user?.role && n.roles.includes(user.role)));
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
  return (
    <div className="flex items-center gap-2 text-accent">
      <Building2 className="size-6" aria-hidden="true" />
      <span className="font-semibold text-text">Yönetim Paneli</span>
    </div>
  );
}

/** md (768px) ve ustu: kalici yan menu. Alti: hamburger + soldan cekmece. */
const DESKTOP_QUERY = '(min-width: 48rem)';

export function AdminLayout() {
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
      <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col gap-4 border-r border-border bg-surface px-3 md:flex">
        <div className="flex h-16 items-center px-3">
          <Brand />
        </div>
        <AdminNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-2 border-b border-border bg-surface px-2 sm:px-4 md:justify-end md:px-8">
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
            <span className="truncate font-semibold">Yönetim Paneli</span>
          </div>
          <UserMenu />
        </header>
        <main className="mx-auto w-full max-w-page flex-1 px-4 py-8 md:px-8">
          <Outlet />
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
