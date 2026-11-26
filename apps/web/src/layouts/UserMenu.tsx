import { CircleUserRound, LogOut, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ContextSwitcher } from '@/components/context/ContextSwitcher';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useActiveApartmentName } from '@/hooks/useActiveContextLabel';
import { useAuth } from '@/hooks/useAuth';
import { MFA_SETUP_PATH } from '@/lib/auth/mfa';
import { RESIDENT_ROLES } from '@/types/roles';
import { ROLE_LABELS } from '@/types/roles';

/**
 * Ust bar sag blogu. Uzun apartman adlari daralip kesilir (min-w-0 + truncate);
 * dugmeler asla daralmaz, boylece dar ekranda tasip gorunmez olmazlar.
 */
export function UserMenu({ sidebar = false }: { sidebar?: boolean }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const apartmentName = useActiveApartmentName();
  if (!user) return null;

  const roleLabel = user.role ? ROLE_LABELS[user.role] : 'Bağlam seçilmedi';
  const title = apartmentName ?? user.email ?? user.sub;

  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:gap-3 md:flex-initial">
      {/*
        Ad / rol blogu daralan tek oge (flex-shrink + truncate). Yan menulu dar aralikta (md-lg) yer
        dugmelere birakilir (`sidebar`); aksiyon grubu shrink-0 oldugu icin Hesabim / Cikis hic tasmaz.
      */}
      <div className={cn('hidden min-w-0 max-w-64 shrink text-right sm:block', sidebar && 'md:hidden lg:block')} title={`${title} · ${roleLabel}`}>
        <p className="truncate text-small font-medium">{title}</p>
        <p className="truncate text-small text-muted">{roleLabel}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <ContextSwitcher />
        {/* Iki adimli dogrulama: kapsamdaki rollerde zorunlu, digerlerinde istege bagli. */}
        {!user.mfa?.enabled && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="İki adımlı doğrulama"
            title="İki adımlı doğrulama"
            className="shrink-0"
            onClick={() => navigate(MFA_SETUP_PATH)}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            <span className="hidden lg:inline">2FA</span>
          </Button>
        )}
        {user.role && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Hesabım"
            title="Hesabım"
            className="shrink-0"
            onClick={() => navigate((RESIDENT_ROLES as readonly string[]).includes(user.role ?? '') ? '/app/account' : '/admin/account')}
          >
            <CircleUserRound className="size-4" aria-hidden="true" />
            <span className="hidden lg:inline">Hesabım</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Çıkış yap"
          className="shrink-0"
          onClick={async () => {
            await signOut();
            navigate('/login', { replace: true });
          }}
        >
          <LogOut className="size-4" aria-hidden="true" />
          <span className="hidden lg:inline">Çıkış</span>
        </Button>
      </div>
    </div>
  );
}
