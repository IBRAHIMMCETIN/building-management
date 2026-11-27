/**
 * Y1-3 - Kat malikleri kurulu (genel kurul) hazirligi ve devami (karar, tutanak, cagri).
 *
 * Anahtarlar (tek tablo, apartman partition'i):
 *   Toplanti : PK = `APT#<apartmentId>`, SK = `ASSEMBLY#<assemblyId>`  (gundem, guncel karar ozeti, cagri ozeti)
 *   Katilim  : PK = `APT#<apartmentId>`, SK = `ASMATT#<assemblyId>#<unitId>`  (bolum basina tek kayit)
 *   Karar    : PK = `APT#<apartmentId>`, SK = `ASMDEC#<assemblyId>#<itemId>#<sira 3 hane>`  (DEGISMEZ;
 *              duzeltme yeni sirayla yeni kayit, `supersedes` oncekini gosterir)
 *   Cagri    : PK = `APT#<apartmentId>`, SK = `ASMCALL#<assemblyId>#<sira 3 hane>`  (DEGISMEZ; e-posta
 *              alicilari, yeniden gonderim yeni sira)
 *
 * Katilim ayri kayit: 5.000 bolumlu sitede tek ogeye sigmaz ve her bolum ayri surumle yazilir.
 * Silme yok: toplanti `cancelled` olur, katilim `absent` ile geri alinir.
 */
import type { IsoDate, IsoDateTime, TableKeys, AuditFields } from '../core/types.js';
import type { RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';
import type { DecisionKind, DecisionOutcome, MajorityRule, VoteChoice } from './majority.js';

export const ASSEMBLY_KINDS = ['ordinary', 'extraordinary'] as const;
export type AssemblyKind = (typeof ASSEMBLY_KINDS)[number];

/** `held`: toplanti yapildi ve tutanak kesinlesti (katilim / yeter sayi / yeni karar yazilamaz). */
export const ASSEMBLY_STATUSES = ['planned', 'held', 'cancelled'] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];

/** Yeniden gonderimler dahil en fazla cagri sayisi. */
export const MAX_CALLS = 10;
/** KMK m.29: cagri toplantidan en az bu kadar gun once. */
export const CALL_NOTICE_DAYS = 15;
/** KMK m.29: ilk ve ikinci toplanti arasinda en az bu kadar gun. */
export const SECOND_MEETING_MIN_DAYS = 7;

/** `present` asaleten, `proxy` vekaleten (yazili vekaletname), `absent` katilmadi. */
export const ATTENDANCE_MODES = ['present', 'proxy', 'absent'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];

export const MAX_AGENDA_ITEMS = 30;

/**
 * Gundem maddesinin GUNCEL karar ozeti (toplanti kaydinda; liste ekranlari icin). Asil kayit
 * degismez `ASMDEC#` kaydidir; `seq` en son kaydin sirasi (1 = ilk karar, > 1 duzeltme).
 */
export type AgendaTally = {
  /** Kabul / ret / cekimser (KMK m.31 sinirli oy). */
  yes: number;
  no: number;
  abstain: number;
  /** Sayim anindaki katilan oy (KMK m.31 sinirli). */
  presentVotes: number;
  decision: 'accepted' | 'rejected';
  recordedAt: IsoDateTime;
  recordedBy: string;
  /** Uygulanan cogunluk (eski kayitta yok: `attendees`). */
  rule?: MajorityRule;
  mode?: DecisionOutcome['mode'];
  seq?: number;
};

export type AgendaItem = {
  itemId: string;
  title: string;
  description?: string;
  /** Karar turu (hazir tur kanundaki cogunlugu belirler); eski kayitta yok: `general`. */
  decisionKind?: DecisionKind;
  /** Gerekli cogunluk; eski kayitta yok: `attendees`. */
  majority?: MajorityRule;
  tally?: AgendaTally;
};

/** Ilk toplanti cagrisinda bildirilen ikinci toplanti (KMK m.29). */
export type SecondMeetingPlan = { scheduledAt: IsoDateTime; location?: string; onlineUrl?: string };

/** Toplanti tutanagi: divan (yonetici girer, serbest ad) ve gorusme notlari. */
export type AssemblyMinutes = {
  chair?: string;
  clerks: string[];
  voteCounters: string[];
  /** Gundem maddesi basina gorusme ozeti (`itemId` -> metin). */
  notes: Record<string, string>;
  generalNotes?: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
};

/** Toplanti kaydindaki cagri ozeti (alici listesi `ASMCALL#` kaydinda). */
export type AssemblyCallSummary = {
  seq: number;
  calledAt: IsoDateTime;
  calledBy: string;
  eventId: string;
  /** E-posta gidecek kat maliki kullanici sayisi. */
  recipients: number;
  /** Oy listesinde olup apartman kullanicisi olmayan malik (e-posta gitmez; yasal cagri ayrica). */
  ownersWithoutAccount: number;
  /** Cagri gunu ile toplanti gunu arasi (Istanbul takvim gunu). */
  daysBefore: number;
  /** KMK m.29'daki 15 gunden sonra gonderildi (uyari; engel degil). */
  lateNotice: boolean;
  resend: boolean;
  reason?: string;
  /** Cagridaki toplanti bilgisi (tarih, yer, baglanti, gundem, ikinci toplanti) ozeti: degisirse cagri eskidir. */
  meetingHash: string;
};

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
    /** Yalnizca ilk toplantida: cagrida bildirilen ikinci toplanti yeri ve zamani. */
    secondMeetingPlan?: SecondMeetingPlan;
    /** Gonderilen cagrilar (en eski once). */
    calls?: AssemblyCallSummary[];
    minutes?: AssemblyMinutes;
    /** Ilk karar ani: sonra katilim degistirilemez (katilim yazimi bunu `ConditionCheck` ile dogrular). */
    attendanceLockedAt?: IsoDateTime;
    status: AssemblyStatus;
    heldAt?: IsoDateTime;
    heldBy?: string;
    cancelledAt?: IsoDateTime;
    cancelReason?: string;
  };

/**
 * Degismez karar kaydi. Toplanti bilgisi karar defteri icin kopyalanir (toplanti kaydi okunmadan
 * tarih sirasi). Bolum bazinda oylar yalnizca yonetim / denetciye gosterilir; sakin portali toplam
 * sayilari gorur. Denetim kaydina oylarin SHA-256 ozeti yazilir.
 */
export type AssemblyDecision = TableKeys & {
  entityType: 'ASSEMBLY_DECISION';
  apartmentId: string;
  assemblyId: string;
  itemId: string;
  seq: number;
  meetingAt: IsoDateTime;
  meetingKind: AssemblyKind;
  secondMeeting: boolean;
  itemTitle: string;
  decisionKind: DecisionKind;
  outcome: DecisionOutcome;
  /** Bolum bazinda oy (yalnizca `units` girisinde). */
  unitVotes?: Record<string, VoteChoice>;
  /** Duzeltme: yerine gectigi kaydin sirasi ve gerekcesi. */
  supersedes?: number;
  correctionReason?: string;
  /** Y1'den kalan (ASMDEC# kaydi olmayan) sayimi duzelten ilk kayit: eski sayim burada korunur. */
  legacyTally?: AgendaTally;
  recordedAt: IsoDateTime;
  recordedBy: string;
};

/** Degismez cagri kaydi: e-posta alicilari (kullanici kimlikleri; kisisel veri yok). */
export type AssemblyCall = TableKeys & {
  entityType: 'ASSEMBLY_CALL';
  apartmentId: string;
  assemblyId: string;
  seq: number;
  recipientUserIds: string[];
  calledAt: IsoDateTime;
  calledBy: string;
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
  /** Kayit anindaki anlik goruntu (tutanak yalnizca bundan yazilir); eski kayitta yok. */
  proxyUnits?: number;
  presentLandShare?: Fraction | null;
  totalLandShare?: Fraction | null;
  landShareBps?: number | null;
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
