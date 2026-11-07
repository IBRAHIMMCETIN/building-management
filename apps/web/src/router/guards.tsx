import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { type Role, homePathForRole } from '@/types/roles';

/**
 * Yalnizca arayuz yonlendirmesidir; gercek yetki kontrolu API'de JWT claim'leriyle yapilir.
 *  - Oturum yok            -> /login (donus adresi saklanir)
 *  - Aktif baglam yok      -> /select-context
 *  - Rol bu alana uygun degil -> /403
 */
export function RequireRole({ roles }: { roles: readonly Role[] }) {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (!user.role) return <Navigate to="/select-context" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/403" replace />;
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
