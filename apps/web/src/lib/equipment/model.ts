/*
 * Ariza & bakim v2 - ekipman sicili modeli (apps/api/src/modules/equipment/types.ts ile ayni
 * kimlikler). Saf: API istemcisine bagli degildir; testler buradan import eder.
 */
import type { TicketCategory } from '@/lib/tickets/model';

export const EQUIPMENT_CATEGORIES = ['elevator', 'generator', 'water_pump', 'heating', 'fire_system', 'camera', 'gate_barrier', 'pool', 'other'] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  elevator: 'Asansör',
  generator: 'Jeneratör',
  water_pump: 'Hidrofor / pompa',
  heating: 'Kazan / ısıtma',
  fire_system: 'Yangın sistemi',
  camera: 'Kamera / güvenlik',
  gate_barrier: 'Otomatik kapı / bariyer',
  pool: 'Havuz',
  other: 'Diğer',
};

/** Ekipmandan acilan arizada onerilen talep kategorisi (API EQUIPMENT_TICKET_CATEGORY ile ayni). */
export const EQUIPMENT_TICKET_CATEGORY: Record<EquipmentCategory, TicketCategory> = {
  elevator: 'elevator',
  generator: 'generator',
  water_pump: 'water_pump',
  heating: 'heating',
  fire_system: 'security',
  camera: 'security',
  gate_barrier: 'security',
  pool: 'pool',
  other: 'other',
};

export const EQUIPMENT_STATUSES = ['active', 'out_of_service', 'retired'] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_STATUS_LABELS: Record<EquipmentStatus, string> = {
  active: 'Çalışıyor',
  out_of_service: 'Devre dışı',
  retired: 'Hizmetten çıktı',
};

export const INSPECTION_LABELS = ['green', 'blue', 'yellow', 'red'] as const;
export type InspectionLabel = (typeof INSPECTION_LABELS)[number];

export const INSPECTION_LABEL_TEXT: Record<InspectionLabel, string> = {
  green: 'Yeşil etiket (güvenli)',
  blue: 'Mavi etiket (hafif kusurlu)',
  yellow: 'Sarı etiket (kusurlu)',
  red: 'Kırmızı etiket (güvensiz)',
};

export const DOCUMENT_KINDS = ['warranty', 'contract', 'inspection', 'manual', 'other'] as const;
export type EquipmentDocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<EquipmentDocumentKind, string> = {
  warranty: 'Garanti belgesi',
  contract: 'Servis sözleşmesi',
  inspection: 'Periyodik kontrol raporu / etiketi',
  manual: 'Kılavuz / teknik doküman',
  other: 'Diğer',
};

export const EXPIRY_KINDS = ['warranty', 'contract', 'inspection'] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];

export const EXPIRY_KIND_LABELS: Record<ExpiryKind, string> = {
  warranty: 'Garanti bitişi',
  contract: 'Servis sözleşmesi bitişi',
  inspection: 'Periyodik kontrol',
};

/** Bagli ekipmanin gosterilen adi: hizmetten cikmissa "(hizmet dışı)" ekiyle. */
export function equipmentDisplayName(e: { name: string; status: EquipmentStatus }): string {
  return e.status === 'retired' ? `${e.name} (hizmet dışı)` : e.name;
}

/** "12 gün kaldı", "bugün", "5 gün geçti" (API `daysLeft`). */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft === 0) return 'bugün';
  return daysLeft > 0 ? `${daysLeft} gün kaldı` : `${-daysLeft} gün geçti`;
}

/** Konum: blok adi + serbest metin; ikisi de yoksa site geneli. */
export function equipmentLocationText(e: { blockId?: string; location?: string }, blockName: (id: string) => string | undefined): string {
  const parts = [e.blockId ? (blockName(e.blockId) ?? 'Blok') : undefined, e.location].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Site geneli';
}
