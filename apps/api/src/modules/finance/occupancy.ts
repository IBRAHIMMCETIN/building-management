/**
 * Bos daire kurali (KMK uygulamasi: isletme gideri fiilen oturana, oturan yoksa kat malikine).
 *
 * Tahakkuk tarihinde bagimsiz bolumde kiraci veya oturan malik yoksa `occupant` tarafina yazilmak
 * istenen gider kat maliki carisine yazilir. Uyelik kaydi hic yoksa (veri eksik / henuz girilmemis)
 * kural uygulanmaz: borc istenen tarafta kalir ve onizlemede "bilinmiyor" olarak raporlanir.
 */
import type { IsoDate, LiableParty } from '../core/types.js';
import type { UnitMembership } from '../portal/types.js';

export type Occupancy = 'occupied' | 'vacant' | 'unknown';

type MembershipLike = Pick<UnitMembership, 'unitId' | 'relation' | 'residesInUnit' | 'startDate' | 'endDate' | 'status'>;

/** `day` gunu (dahil) gecerli uyelik. Kapama servisindeki kuralla aynidir. */
export const coversDay = (m: MembershipLike, day: IsoDate): boolean =>
  m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

/**
 * occupied: kiraci ya da oturan malik var.
 * vacant:   yalnizca (oturmayan) malik var.
 * unknown:  o gun gecerli hicbir uyelik yok.
 */
export function occupancyOn(memberships: readonly MembershipLike[], unitId: string, day: IsoDate): Occupancy {
  const current = memberships.filter((m) => m.unitId === unitId && coversDay(m, day));
  if (current.some((m) => m.relation === 'tenant' || m.residesInUnit)) return 'occupied';
  if (current.some((m) => m.relation === 'owner')) return 'vacant';
  return 'unknown';
}

/** Gercekte borclanacak taraf. Malik tarafi istenmisse (demirbas/yatirim) dokunulmaz. */
export function liablePartyFor(requested: LiableParty, occupancy: Occupancy): { party: LiableParty; vacant: boolean } {
  if (requested === 'occupant' && occupancy === 'vacant') return { party: 'owner', vacant: true };
  return { party: requested, vacant: false };
}

export const VACANT_SUFFIX = ' (daire boş - kat malikine)';
