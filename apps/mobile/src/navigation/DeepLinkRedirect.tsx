import { type Href, Redirect, usePathname } from 'expo-router';
import { useAuth } from '@/context/AuthProvider';
import { areaForRole, homeRouteFor } from '@/lib/auth/flow';
import { deepLinkTarget } from '@/lib/deepLinks';

/**
 * Bildirim baglantisi yollari (app/borclar.tsx, app/duyurular/[id].tsx ...): bulundugu adresi role
 * gore uygulama ici ekrana yonlendirir. Oturum / baglam yoksa acilis kurali (giris, baglam secimi).
 */
export function DeepLinkRedirect() {
  const pathname = usePathname();
  const { user } = useAuth();
  const target = deepLinkTarget(pathname, user?.role ? areaForRole(user.role) : null);
  // withAnchor: hedef ekranin altina rol yiginin ilk rotasi (sekmeler) konur; bildirimle dogrudan
  // acilan ekranda Geri dugmesi olur (app/*/_layout.tsx `unstable_settings.initialRouteName`).
  return <Redirect href={(target ?? homeRouteFor(user)) as Href} withAnchor />;
}
