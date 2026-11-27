/**
 * Y1-3 - Kat malikleri kurulu (genel kurul) hazirligi.
 *
 * Anahtarlar (tek tablo, apartman partition'i):
 *   Toplanti : PK = `APT#<apartmentId>`, SK = `ASSEMBLY#<assemblyId>`  (gundem ve sayimlar icinde)
 *   Katilim  : PK = `APT#<apartmentId>`, SK = `ASMATT#<assemblyId>#<unitId>`  (bolum basina tek kayit)
 *
 * Katilim ayri kayit: 5.000 bolumlu sitede tek ogeye sigmaz ve her bolum ayri surumle yazilir.
 * Silme yok: toplanti `cancelled` olur, katilim `absent` ile geri alinir.
 */
import type { IsoDate, IsoDateTime, TableKeys, AuditFields } from '../core/types.js';

export const ASSEMBLY_KINDS = ['ordinary', 'extraordinary'] as const;
export type AssemblyKind = (typeof ASSEMBLY_KINDS)[number];

export const ASSEMBLY_STATUSES = ['planned', 'cancelled'] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];

/** `present` asaleten, `proxy` vekaleten (yazili vekaletname), `absent` katilmadi. */
export const ATTENDANCE_MODES = ['present', 'proxy', 'absent'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];

export const MAX_AGENDA_ITEMS = 30;

export type AgendaTally = {
  /** Kabul / ret / cekimser (bagimsiz bolum sayisi). */
  yes: number;
  no: number;
  abstain: number;
  /** Sayim anindaki katilan bolum sayisi (karar esigi bununla hesaplanir). */
  presentUnits: number;
  decision: 'accepted' | 'rejected';
  recordedAt: IsoDateTime;
  recordedBy: string;
};

export type AgendaItem = { itemId: string; title: string; description?: string; tally?: AgendaTally };

export type Assembly = TableKeys &
  AuditFields & {
    entityType: 'ASSEMBLY';
    assemblyId: string;
    apartmentId: string;
    kind: AssemblyKind;
    /**
     * Ikinci toplanti: ilk toplantida yeter sayi saglanamadi (KMK m.30/3). Toplanti yeter sayisi
     * aranmaz; karar yine katilanlarin sayi cogunluguyla.
     */
    secondMeeting: boolean;
    scheduledAt: IsoDateTime;
    location?: string;
    onlineUrl?: string;
    /** Oy listesi (hazirun) tarihi: toplanti gunu, Europe/Istanbul. */
    rollDate: IsoDate;
    agenda: AgendaItem[];
    status: AssemblyStatus;
    cancelledAt?: IsoDateTime;
    cancelReason?: string;
  };

export type AssemblyAttendance = TableKeys & {
  entityType: 'ASSEMBLY_ATTENDANCE';
  apartmentId: string;
  assemblyId: string;
  unitId: string;
  mode: AttendanceMode;
  /** Toplantiya katilan malik / paydas adi (serbest metin; hazirun cetveline yazilir). */
  attendeeName?: string;
  /** Vekaleten katilimda vekilin adi. */
  proxyName?: string;
  recordedAt: IsoDateTime;
  recordedBy: string;
  version: number;
};
