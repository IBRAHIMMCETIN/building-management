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
import type { RollMeta } from '../polls/rollSnapshot.js';

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
  /** Sayim anindaki katilan oy (KMK m.31 sinirli; karar esigi bununla hesaplanir). */
  presentVotes: number;
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
     * Ikinci toplanti (KMK m.30): `firstMeetingId` ayni apartmanin, yeter sayisinin saglanamadigi
     * tutanaga gecmis ilk toplantisidir ve bu toplanti ondan en gec 15 gun sonradir. Toplanti yeter
     * sayisi aranmaz; karar katilanlarin oy cogunluguyla.
     */
    secondMeeting: boolean;
    firstMeetingId?: string;
    scheduledAt: IsoDateTime;
    location?: string;
    onlineUrl?: string;
    /** Oy listesi (hazirun) tarihi: toplanti gunu, Europe/Istanbul. */
    rollDate: IsoDate;
    /** Ilk katilim / sayim / hazirun isteginde dondurulan oy listesi (satirlar `ASMROLL#...`). */
    roll?: RollMeta;
    /** Toplanti yeter sayisinin tutanaga gecirilen sonucu (ilk sayimda veya elle). */
    quorumRecord?: QuorumRecord;
    agenda: AgendaItem[];
    status: AssemblyStatus;
    cancelledAt?: IsoDateTime;
    cancelReason?: string;
  };

export type QuorumRecord = {
  met: boolean;
  presentUnits: number;
  totalUnits: number;
  presentOwners: number;
  totalOwners: number;
  presentVotes: number;
  totalVotes: number;
  /** "Kimse gelmedi": katilim kaydi olmadan yeter sayisizlik tutanagi. */
  noAttendance: boolean;
  ownersMajority: boolean;
  landShareMajority: boolean;
  landShareComputable: boolean;
  recordedAt: IsoDateTime;
  recordedBy: string;
};

export type AssemblyAttendance = TableKeys & {
  entityType: 'ASSEMBLY_ATTENDANCE';
  apartmentId: string;
  assemblyId: string;
  unitId: string;
  mode: AttendanceMode;
  /** Asaleten katilan paydas (oy listesindeki maliklerden biri; hisseli bolumun temsilcisi). */
  attendee?: { userId: string };
  /** Vekaleten katilimda vekil: apartman kisisi ise userId, degilse ad-soyad. */
  proxy?: { userId?: string; name: string };
  recordedAt: IsoDateTime;
  recordedBy: string;
  version: number;
};
