import type { RoleArea } from './auth/flow';

/*
 * Bildirim baglantilari (push `data.url`; API: apps/api/src/modules/notifications/push-templates.ts).
 * Kokteki kisa yollar (app/borclar.tsx, app/duyurular/[id].tsx ...) burada role gore uygulama ici
 * ekrana cevrilir (sakinde tum ozellikler M2a / M2b ile yerel ekrandir).
 *   /borclar  /duyurular[/<id>]  /oylamalar[/<id>]  /talepler[/<id>]  /kapi  /rezervasyonlar
 *   /genel-kurul[/<id>]  /ihaleler[/<id>]
 * Cok apartmanli kullanicida `data.apartmentId` baglamina gecis bildirime dokunma isleyicisinin
 * isidir (push fazi); burada aktif baglamin rolune gore yonlendirilir.
 */

export type DeepLinkTarget = string | { pathname: string; params: Record<string, string> };

/** Sakin icin yerel ekrani olan ozellikler (M2b): bildirim yolu -> liste ekrani (ayrinti: `<liste>/[id]`). */
const RESIDENT_NATIVE: Record<string, '/resident/polls' | '/resident/assemblies' | '/resident/tenders'> = {
  oylamalar: '/resident/polls',
  'genel-kurul': '/resident/assemblies',
  ihaleler: '/resident/tenders',
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
      const native = RESIDENT_NATIVE[root];
      if (!native) return null;
      return id ? { pathname: `${native}/[id]`, params: { id } } : native;
    }
  }
}
