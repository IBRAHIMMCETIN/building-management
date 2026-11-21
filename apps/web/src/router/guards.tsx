import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { MFA_SETUP_PATH } from '@/lib/auth/mfa';
import { type Role, homePathForRole } from '@/types/roles';

/**
 * Yalnizca arayuz yonlendirmesidir; gercek yetki kontrolu API'de JWT claim'leriyle yapilir.
 *  - Oturum yok            -> /login (donus adresi saklanir)
 *  - Aktif baglam yok      -> /select-context
 *  - Zorunlu MFA kurulmamis -> /mfa-setup (API de 403 MFA_REQUIRED doner)
 *  - Rol bu alana uygun degil -> /403 (`redirectHome`: rolun acilis sayfasina; ornegin platform
 *    yoneticisi apartman ekranina girerse kendi paneline doner)
 */
export function RequireRole({ roles, redirectHome = false }: { roles: readonly Role[]; redirectHome?: boolean }) {
  const { user, mfaSetupRequired } = useAuth();
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (!user.role) return <Navigate to="/select-context" replace />;
  if (mfaSetupRequired) {
    return <Navigate to={MFA_SETUP_PATH} replace state={{ from: location.pathname + location.search }} />;
  }
  if (!roles.includes(user.role)) return <Navigate to={redirectHome ? homePathForRole(user.role) : '/403'} replace />;
  return <Outlet />;
}

/** Oturum yeterli, rol gerekmez (baglam secim ekrani). */
export function RequireSession() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/**
 * Giris yapmis kullaniciyi /login ve /forgot-password'dan uzak tutar. Giris tamamlaninca
 * da bu guard tetiklenir; LoginPage ile ayni hedefe (`state.from`) gitmesi bu yuzdendir.
 */
export function RedirectIfAuthenticated() {
  const { user } = useAuth();
  const from = (useLocation().state as { from?: string } | null)?.from;
  if (!user) return <Outlet />;
  if (!user.role) return <Navigate to="/select-context" replace />;
  return <Navigate to={from ?? homePathForRole(user.role)} replace />;
}

export function RootRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role ? homePathForRole(user.role) : '/select-context'} replace />;
}
