import type { RoleArea } from './auth/flow';

/*
 * Bildirim baglantilari (push `data.url`; API: apps/api/src/modules/notifications/push-templates.ts).
 * Kokteki kisa yollar (app/borclar.tsx, app/duyurular/[id].tsx ...) burada role gore uygulama ici
 * ekrana cevrilir; henuz mobilde olmayan ozellikler yer tutucuya (web'de ac, ayni kayda) gider.
 *   /borclar  /duyurular[/<id>]  /oylamalar[/<id>]  /talepler[/<id>]  /kapi  /rezervasyonlar
 *   /genel-kurul[/<id>]  /ihaleler[/<id>]
 * Cok apartmanli kullanicida `data.apartmentId` baglamina gecis bildirime dokunma isleyicisinin
 * isidir (push fazi); burada aktif baglamin rolune gore yonlendirilir.
 */

export type DeepLinkTarget = string | { pathname: string; params: Record<string, string> };

/** Sakin icin henuz yer tutucu olan ozellikler: bildirim yolu -> "Diğer" anahtari (lib/nav.ts). */
const RESIDENT_WEB_FEATURES: Record<string, string> = {
  oylamalar: 'oylamalar',
  kapi: 'ziyaretci',
  rezervasyonlar: 'rezervasyon',
  'genel-kurul': 'genel-kurul',
  ihaleler: 'ihale',
};

export const DEEP_LINK_ROOTS = ['borclar', 'duyurular', 'oylamalar', 'talepler', 'kapi', 'rezervasyonlar', 'genel-kurul', 'ihaleler'] as const;

/** `/duyurular/an-1?x=1` -> ['duyurular', 'an-1'] (bos parcalar ve sorgu atilir). */
function segments(path: string): string[] {
  return (path.split(/[?#]/)[0] ?? '')
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

/**
 * Bildirim yolunu aktif role gore uygulama ici hedefe cevirir. Bilinmeyen yol veya rol yoksa
 * null (cagiran acilis ekranina gider).
 */
export function deepLinkTarget(path: string, area: RoleArea | null): DeepLinkTarget | null {
  const [root, id] = segments(path);
  if (!root || !(DEEP_LINK_ROOTS as readonly string[]).includes(root) || !area) return null;
  const withId = (params: Record<string, string>) => (id ? { ...params, id } : params);

  if (area === 'guard') return '/guard';
  if (area === 'staff') return '/staff';
  if (area === 'panel') return '/panel';

  switch (root) {
    case 'borclar':
      return '/resident/dues';
    case 'duyurular':
      return id ? { pathname: '/resident/announcements/[id]', params: { id } } : '/resident/announcements';
    case 'talepler':
      return id ? { pathname: '/resident/tickets', params: { id } } : '/resident/tickets';
    default: {
      const feature = RESIDENT_WEB_FEATURES[root];
      return feature ? { pathname: '/resident/web/[feature]', params: withId({ feature }) } : null;
    }
  }
}
