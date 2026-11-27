/**
 * Ariza & bakim v2 - Ekipman sicili. Tek tablo, `PK = APT#<apartmentId>`:
 *
 *   EQUIP#<equipmentId>     ekipman (surumlu). Belgeler (garanti belgesi, servis sozlesmesi,
 *                           periyodik kontrol raporu ...) kaydin icindedir (en fazla 30).
 *
 * Hicbir kayit silinmez (Lambda'larin DeleteItem yetkisi yok): ekipman `retired` (hizmetten
 * cikarildi) olur, belge `archived` olur. Talep (`Ticket.equipmentId`) ve bakim sablonu / gorevi
 * (`equipmentId`) ekipmana istege bagli baglanir; gecmis ve masraflar okuma aninda o kayitlardan
 * derlenir (ayri bir baglanti kaydi yok).
 *
 * S3 (private): `tmp/{apt}/equipment-uploads/{userId}/{uploadId}` gecici yukleme ->
 * `apartments/{apt}/equipment/{equipmentId}/{documentId}.{ext}` kalici belge.
 */
import type { AuditFields, IsoDate, IsoDateTime, TableKeys } from '../core/types.js';
import type { TicketCategory } from '../tickets/types.js';

/**
 * Kategoriler. Bakim / ariza kategorileriyle ortak olanlar ayni kimligi kullanir (asansor,
 * jenerator, hidrofor, isitma, havuz, diger); digerleri ekipmana ozgudur.
 */
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

/** Ekipmandan acilan ariza / bakim icin onerilen talep kategorisi. */
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

/** `active` calisiyor, `out_of_service` arizali / devre disi (gecici), `retired` hizmetten cikarildi. */
export const EQUIPMENT_STATUSES = ['active', 'out_of_service', 'retired'] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

/** Asansor periyodik kontrol etiketi (A tipi muayene kurulusu). */
export const INSPECTION_LABELS = ['green', 'blue', 'yellow', 'red'] as const;
export type InspectionLabel = (typeof INSPECTION_LABELS)[number];

export const DOCUMENT_KINDS = ['warranty', 'contract', 'inspection', 'manual', 'other'] as const;
export type EquipmentDocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Ticari sartlar (fiyat) tasiyan belge turleri: bina gorevlisine gosterilmez (masraf gibi). */
export const MANAGER_ONLY_DOCUMENT_KINDS: readonly EquipmentDocumentKind[] = ['contract'];

export type EquipmentDocument = {
  documentId: string;
  kind: EquipmentDocumentKind;
  title: string;
  fileName: string;
  contentType: string;
  size: number;
  /** Kalici S3 anahtari (yalnizca sunucuda; istemciye donmez). */
  key: string;
  /** Belgenin gecerlilik sonu (ornegin muayene raporu); bilgi amacli. */
  validUntil?: IsoDate;
  uploadedAt: IsoDateTime;
  uploadedBy: string;
  status: 'active' | 'archived';
  archivedAt?: IsoDateTime;
  archivedBy?: string;
};

/**
 * Servis firmasi. Finans'ta tedarikci carisi (payable hesap) varsa ona baglanir; iletisim bilgisi
 * (firma telefonu / e-postasi) serbest metindir.
 */
export type ServiceCompany = {
  supplierAccountId?: string;
  name?: string;
  phone?: string;
  email?: string;
};

export type Equipment = TableKeys &
  AuditFields & {
    entityType: 'EQUIPMENT';
    apartmentId: string;
    equipmentId: string;
    name: string;
    category: EquipmentCategory;
    /** Bos ise site geneli; blok secildiyse o blok. */
    blockId?: string;
    /** Serbest konum metni ("B Blok bodrum kat"). */
    location?: string;
    brand?: string;
    model?: string;
    serialNumber?: string;
    /** Kurulum / devreye alma tarihi. */
    installDate?: IsoDate;
    warrantyEndDate?: IsoDate;
    serviceCompany?: ServiceCompany;
    serviceContractEndDate?: IsoDate;
    lastInspectionDate?: IsoDate;
    /** Bir sonraki periyodik kontrol (muayene) tarihi. */
    nextInspectionDate?: IsoDate;
    inspectionLabel?: InspectionLabel;
    notes?: string;
    status: EquipmentStatus;
    /** Devre disi / hizmetten cikarma gerekcesi. */
    statusNote?: string;
    statusChangedAt?: IsoDateTime;
    documents: EquipmentDocument[];
  };

export const MAX_DOCUMENTS_PER_EQUIPMENT = 30;

export const EQUIPMENT_PREFIX = 'EQUIP#';
export const equipmentKeys = {
  equipment: (apartmentId: string, equipmentId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `${EQUIPMENT_PREFIX}${equipmentId}` }),
};

export const equipmentDocumentKeys = {
  pending: (apartmentId: string, userId: string, uploadId: string) => `tmp/${apartmentId}/equipment-uploads/${userId}/${uploadId.replace('_', '.')}`,
  final: (apartmentId: string, equipmentId: string, documentId: string, ext: string) => `apartments/${apartmentId}/equipment/${equipmentId}/${documentId}.${ext}`,
};

/** Son tarih hatirlatmalari (gunluk ozet ve yonetim ekrani). */
export const EXPIRY_KINDS = ['warranty', 'contract', 'inspection'] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];

export const EXPIRY_KIND_LABELS: Record<ExpiryKind, string> = {
  warranty: 'Garanti bitişi',
  contract: 'Servis sözleşmesi bitişi',
  inspection: 'Periyodik kontrol',
};

export type ExpiryItem = {
  equipmentId: string;
  name: string;
  kind: ExpiryKind;
  date: IsoDate;
  /** Tarih bugunden once (doldu / gecikti). */
  expired: boolean;
  /** Bugune gore gun farki (negatif: gecti). */
  daysLeft: number;
};
