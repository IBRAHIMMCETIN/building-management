import type { SelectableContext } from '@bm/shared/auth/contextsSchema';
import type { ActiveContext } from '@bm/shared/auth/session';
import type { Role } from '@bm/shared/roles';
import { DEEP_LINK_ROOTS } from '@/lib/deepLinks';
import type { NotificationData } from './types';

/*
 * Bildirime dokununca ne olacagi (saf karar; NotificationObserver uygular):
 *  - `data.url` uygulamanin karsiladigi bir yol degilse hicbir sey yapilmaz.
 *  - `data.apartmentId` yoksa veya aktif apartmansa: aktif rolle `data.url` (DeepLinkRedirect role gore
 *    ekrana cevirir).
 *  - Baska apartmansa: YALNIZCA kullanicinin baglamlarinda o apartman varsa ona gecilir, sonra
 *    `data.url`; ayni apartmanda birden fazla rol varsa aktif rol, yoksa yola uygun rol secilir
 *    (talep -> gorevli, digerleri -> sakin). Baglamlarda yoksa ana sayfa + bilgi notu.
 */

export type NotificationDecision =
  | { kind: 'ignore' }
  | { kind: 'navigate'; url: string }
  | { kind: 'switch'; context: ActiveContext; url: string }
  | { kind: 'unavailable'; message: string };

export const UNAVAILABLE_NOTICE = 'Bu bildirim artık erişiminiz olmayan bir apartmana ait. Ana sayfa açıldı.';

/** Gecerli uygulama ici yol: `/<bilinen kok>[/...]`, baska sema / alan adi yok. */
export function notificationUrl(data: NotificationData): string | null {
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  const root = url.split(/[/?#]/)[1] ?? '';
  return (DEEP_LINK_ROOTS as readonly string[]).includes(root) ? url : null;
}

const ROLE_ORDER: Record<'talepler' | 'default', readonly Role[]> = {
  talepler: ['building_staff', 'resident', 'security_guard', 'apartment_manager', 'management_company', 'observer'],
  default: ['resident', 'building_staff', 'security_guard', 'apartment_manager', 'management_company', 'observer'],
};

export function resolveNotificationTarget(
  data: NotificationData,
  state: { active: { apartmentId?: string; role?: string } | null; contexts: readonly SelectableContext[] },
): NotificationDecision {
  const url = notificationUrl(data);
  if (!url) return { kind: 'ignore' };
  const apartmentId = typeof data.apartmentId === 'string' && data.apartmentId ? data.apartmentId : null;
  if (!apartmentId || apartmentId === state.active?.apartmentId) return { kind: 'navigate', url };

  const candidates = state.contexts.filter((c) => c.apartmentId === apartmentId);
  if (candidates.length === 0) return { kind: 'unavailable', message: UNAVAILABLE_NOTICE };
  const root = url.split(/[/?#]/)[1] === 'talepler' ? 'talepler' : 'default';
  const sameRole = state.active ? candidates.find((c) => c.role === state.active?.role) : undefined;
  const byOrder = ROLE_ORDER[root].map((r) => candidates.find((c) => c.role === r)).find(Boolean);
  const chosen = sameRole ?? byOrder ?? candidates[0];
  if (!chosen) return { kind: 'unavailable', message: UNAVAILABLE_NOTICE };
  return { kind: 'switch', context: { apartmentId: chosen.apartmentId, role: chosen.role }, url };
}
