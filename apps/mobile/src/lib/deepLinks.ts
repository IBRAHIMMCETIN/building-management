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
  'genel-kurul': 'genel-kurul',
  ihaleler: 'ihale',
};

export const DEEP_LINK_ROOTS = ['borclar', 'duyurular', 'oylamalar', 'talepler', 'kapi', 'rezervasyonlar', 'genel-kurul', 'ihaleler'] as const;

/** Bozuk kacis dizisi (`%E0%A4%A`) hata firlatmasin: cozulemeyen parca null olur. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** `/duyurular/an-1?x=1` -> ['duyurular', 'an-1'] (bos parcalar ve sorgu atilir). */
function segments(path: string): Array<string | null> {
  return (path.split(/[?#]/)[0] ?? '').split('/').filter(Boolean).map(decode);
}

/**
 * Bildirim yolunu aktif role gore uygulama ici hedefe cevirir. Bilinmeyen yol veya rol yoksa
 * null (cagiran acilis ekranina gider).
 */
export function deepLinkTarget(path: string, area: RoleArea | null): DeepLinkTarget | null {
  // Kimlik cozulemezse (bozuk baglanti) liste ekranina dusulur.
  const [root, rawId] = segments(path);
  const id = rawId ?? undefined;
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
      return id ? { pathname: '/resident/tickets/[id]', params: { id } } : '/resident/tickets';
    case 'kapi':
      return '/resident/gate';
    case 'rezervasyonlar':
      return { pathname: '/resident/reservations', params: { tab: 'mine' } };
    default: {
      const feature = RESIDENT_WEB_FEATURES[root];
      return feature ? { pathname: '/resident/web/[feature]', params: withId({ feature }) } : null;
    }
  }
}
