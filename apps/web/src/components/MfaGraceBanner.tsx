import { ShieldAlert } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { MFA_SETUP_PATH, mfaGraceDaysLeft } from '@/lib/auth/mfa';

/** Gecis suresi metni: "3 gün içinde", "bugün". */
export function graceText(daysLeft: number): string {
  return daysLeft <= 1 ? 'bugün' : `${daysLeft} gün içinde`;
}

/**
 * `warn` modu: TOTP kurmamis yonetici/denetciye kalan sureyi gosterir. Sure dolunca
 * Pre Token Lambda `mfa_required` ekler ve kullanici dogrudan kurulum ekranina yonlenir.
 */
export function MfaGraceBanner() {
  const { user } = useAuth();
  const location = useLocation();
  const daysLeft = mfaGraceDaysLeft(user);
  if (daysLeft === undefined) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface-muted px-4 py-2.5 text-small md:px-8"
    >
      <ShieldAlert className="size-4 shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Hesabınızın güvenliği için iki adımlı doğrulamayı <strong>{graceText(daysLeft)}</strong> kurmanız gerekiyor. Süre
        dolduğunda kurulum yapılmadan yönetim ekranları açılmaz.
      </span>
      <Link
        to={MFA_SETUP_PATH}
        state={{ from: location.pathname + location.search }}
        className="font-medium text-accent underline-offset-2 hover:underline"
      >
        Şimdi kur
      </Link>
    </div>
  );
}
