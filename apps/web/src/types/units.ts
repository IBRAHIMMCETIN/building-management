/** Bagimsiz bolum tipleri (API: apps/api/src/modules/core/types.ts UnitType). */
export const UNIT_TYPES = ['flat', 'duplex', 'shop', 'office', 'parking', 'storage', 'other'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const UNIT_TYPE_LABELS: Record<UnitType, string> = {
  flat: 'Daire',
  duplex: 'Dubleks',
  shop: 'Dükkan',
  office: 'Ofis',
  parking: 'Otopark',
  storage: 'Depo',
  other: 'Diğer',
};
