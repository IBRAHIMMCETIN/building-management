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
 *   Cagri alici kovasi: SK = `ASMCALLR#<assemblyId>#<cagri sirasi 3 hane>#<kova 3 hane>` (DEGISMEZ;
 *              kova basina en fazla CALL_RECIPIENTS_PER_BUCKET kullanici; 8.000+ malikli sitede tek
 *              oge 400 KB sinirini asmaz). Eski cagri kaydinda alicilar kaydin icindedir.
 *   Tebligat : SK = `ASMSERVE#<assemblyId>#<malik kisi kimligi>` (surumlu; yasal cagrinin malik
 *              basina teslim denemeleri, denemeler silinmez, duzeltme gerekceli iptal)
 *   Yazili riza talebi: SK = `ASMCONS#<consentId>` (surumlu); riza kaydi
 *              `ASMCONSV#<consentId>#<unitId>#<sira 3 hane>` (DEGISMEZ; duzeltme yeni sira); oy
 *              listesi `ASMCONSROLL#<consentId>#<kova>` (talep acilisinda dondurulur)
 *
 * Katilim ayri kayit: 5.000 bolumlu sitede tek ogeye sigmaz ve her bolum ayri surumle yazilir.
 * Silme yok: toplanti `cancelled` olur, katilim `absent` ile geri alinir.
 */
import type { IsoDate, IsoDateTime, TableKeys, AuditFields } from '../core/types.js';
import type { RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';
import type { ElectionResult } from './elections.js';
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

/** Cagri alicilari kova basina (kullanici kimligi ~40 bayt: kova ~45 KB, 400 KB sinirinin cok altinda). */
export const CALL_RECIPIENTS_PER_BUCKET = 1000;
/** Tek cagrinin en fazla alicisi: kovalar ayni atomik yazimda (100 oge, 4 MB) kalir. */
export const MAX_CALL_RECIPIENTS = 50_000;
/** Toplanti basina en fazla erteleme / yer degisikligi bildirimi. */
export const MAX_RESCHEDULES = 5;

/** Secim maddesinde aday (yonetici / denetci). `userId`: apartman kisisi ise (denetci kat maliki olmali, KMK m.41). */
export type ElectionCandidate = { candidateId: string; name: string; userId?: string };
export const MAX_CANDIDATES = 12;

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
  /** Secim maddesi: secilen aday (`null`: secim yapilamadi; hicbir aday gerekli cogunluga ulasmadi). */
  winnerCandidateId?: string | null;
};

export type AgendaItem = {
  itemId: string;
  title: string;
  description?: string;
  /** Karar turu (hazir tur kanundaki cogunlugu belirler); eski kayitta yok: `general`. */
  decisionKind?: DecisionKind;
  /** Gerekli cogunluk; eski kayitta yok: `attendees`. */
  majority?: MajorityRule;
  /**
   * Cok adayli secim (yalnizca yonetici / denetci secimi): her oy veren tek aday secer (veya
   * cekimser); aday basina kanuni cogunluk (m.34 / m.41) ayri hesaplanir.
   */
  candidates?: ElectionCandidate[];
  tally?: AgendaTally;
};

/** Cagridan sonra toplanti tarihi / yeri degisikligi (erteleme): maliklere bildirilir, kayit silinmez. */
export type AssemblyReschedule = {
  seq: number;
  previousScheduledAt: IsoDateTime;
  previousLocation?: string;
  previousOnlineUrl?: string;
  scheduledAt: IsoDateTime;
  location?: string;
  onlineUrl?: string;
  reason: string;
  at: IsoDateTime;
  by: string;
  eventId: string;
  /** Degisiklik sonrasi toplanti ozeti: sonra yeniden degisirse bu bildirim eskir. */
  meetingHash: string;
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
    /** Cagridan sonra yapilan ertelemeler / yer degisiklikleri (en eski once). */
    reschedules?: AssemblyReschedule[];
    status: AssemblyStatus;
    heldAt?: IsoDateTime;
    heldBy?: string;
    cancelledAt?: IsoDateTime;
    cancelReason?: string;
    /** Cagrisi gonderilmis toplantinin iptal bildirimi (`ASSEMBLY_CANCELLED:<id>`). */
    cancelEventId?: string;
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
  /** Secim maddesi: bolum bazinda oy pusulasi (aday kimligi veya `abstain`) ve aday sonuclari. */
  unitBallots?: Record<string, string>;
  election?: ElectionResult;
  /** Duzeltme: yerine gectigi kaydin sirasi ve gerekcesi. */
  supersedes?: number;
  correctionReason?: string;
  /** Y1'den kalan (ASMDEC# kaydi olmayan) sayimi duzelten ilk kayit: eski sayim burada korunur. */
  legacyTally?: AgendaTally;
  recordedAt: IsoDateTime;
  recordedBy: string;
};

/**
 * Degismez cagri kaydi: e-posta alicilari (kullanici kimlikleri; kisisel veri yok). Yeni kayitta
 * alicilar `ASMCALLR#` kovalarindadir (`buckets`, `recipientCount`); eski kayitta `recipientUserIds`.
 * Depo okumasi (`getCall`, `listCalls`) her iki bicimi `recipientUserIds` olarak birlestirir.
 */
export type AssemblyCall = TableKeys & {
  entityType: 'ASSEMBLY_CALL';
  apartmentId: string;
  assemblyId: string;
  seq: number;
  recipientUserIds?: string[];
  recipientCount?: number;
  buckets?: number;
  calledAt: IsoDateTime;
  calledBy: string;
};

/** Cagri alici kovasi (degismez). */
export type AssemblyCallRecipients = TableKeys & {
  entityType: 'ASSEMBLY_CALL_RECIPIENTS';
  apartmentId: string;
  assemblyId: string;
  seq: number;
  bucket: number;
  userIds: string[];
};

/** Depodan okunan cagri: alicilar kovalardan birlestirilmis. */
export type ResolvedCall = Omit<AssemblyCall, 'recipientUserIds'> & { recipientUserIds: string[] };

// ---------------------------------------------------------------------------
// Yasal cagri teslim takibi (KMK m.29)
// ---------------------------------------------------------------------------

/** `hand_signed`: imza karsiligi elden; `registered_mail`: taahhutlu mektup; `email_info`: e-posta bilgilendirme (yasal cagri sayilmaz). */
export const SERVICE_METHODS = ['hand_signed', 'registered_mail', 'email_info'] as const;
export type ServiceMethod = (typeof SERVICE_METHODS)[number];
export const LEGAL_SERVICE_METHODS: readonly ServiceMethod[] = ['hand_signed', 'registered_mail'];
export const SERVICE_STATUSES = ['pending', 'delivered', 'returned'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const MAX_SERVICE_ATTEMPTS = 10;

export type ServiceAttempt = {
  seq: number;
  method: ServiceMethod;
  /** Imza tarihi (elden) / postaya verilis tarihi (taahhutlu) / gonderim tarihi (e-posta). */
  sentOn: IsoDate;
  referenceNo?: string;
  status: ServiceStatus;
  /** Teslim / iade tarihi. */
  statusOn?: IsoDate;
  note?: string;
  /** Durum gecmisi (degismez; en eski once). */
  history: { status: ServiceStatus; statusOn?: IsoDate; at: IsoDateTime; by: string; note?: string }[];
  /** Hatali giris: silinmez, gerekceyle iptal edilir. */
  voidedAt?: IsoDateTime;
  voidedBy?: string;
  voidReason?: string;
  recordedAt: IsoDateTime;
  recordedBy: string;
};

export type AssemblyServiceRecord = TableKeys & {
  entityType: 'ASSEMBLY_SERVICE';
  apartmentId: string;
  assemblyId: string;
  /** Oy listesindeki malik kisi kimligi (kullanici / kisi kaydi). */
  ownerId: string;
  attempts: ServiceAttempt[];
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

// ---------------------------------------------------------------------------
// Toplanti disinda yazili riza (KMK m.19/2 ve README "Hukuki yorum")
// ---------------------------------------------------------------------------

export const CONSENT_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const CONSENT_CHOICES = ['consent', 'object'] as const;
export type ConsentChoice = (typeof CONSENT_CHOICES)[number];
/** Islak imza, noter onayli, nitelikli e-imza, diger (aciklamali). */
export const CONSENT_METHODS = ['wet_signature', 'notarized', 'e_signature', 'other'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export type ConsentDocument = { key: string; fileName: string; contentType: string; size: number };

export type ConsentRequest = TableKeys &
  AuditFields & {
    entityType: 'ASSEMBLY_CONSENT';
    apartmentId: string;
    consentId: string;
    title: string;
    description?: string;
    decisionKind: DecisionKind;
    rule: MajorityRule;
    /** Oy listesi tarihi (talep acilis gunu, Europe/Istanbul). */
    rollDate: IsoDate;
    roll: RollMeta;
    status: ConsentStatus;
    /** Kapanista kesinlesen sonuc (sonra riza kaydi eklenemez). */
    result?: DecisionOutcome;
    closedAt?: IsoDateTime;
    closedBy?: string;
    cancelledAt?: IsoDateTime;
    cancelReason?: string;
  };

/** Degismez riza kaydi (bolum basina; duzeltme yeni sira, onceki silinmez). */
export type ConsentEntry = TableKeys & {
  entityType: 'ASSEMBLY_CONSENT_ENTRY';
  apartmentId: string;
  consentId: string;
  unitId: string;
  seq: number;
  choice: ConsentChoice;
  /** Rizayi veren malik (hisseli bolumde paydaslarin temsilcisi). */
  signerUserId: string;
  signedOn: IsoDate;
  method: ConsentMethod;
  methodNote?: string;
  document?: ConsentDocument;
  supersedes?: number;
  correctionReason?: string;
  recordedAt: IsoDateTime;
  recordedBy: string;
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
