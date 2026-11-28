import { z } from 'zod';
import { fractionSchema } from './polls';

/*
 * Y1-3 kat malikleri kurulu (genel kurul) veri modeli (web + mobil ortak): semalar, tipler,
 * etiketler. API istemcisine bagimli DEGILDIR. Web uclari: apps/web/src/lib/api/assemblies.ts
 * (assemblyModel.ts bu dosyayi yeniden disa aktarir); mobil: apps/mobile/src/lib/api/assemblies.ts.
 *
 *   GET  /api/assemblies | POST /api/assemblies | GET|PATCH /api/assemblies/:id
 *   GET  /api/assemblies/decision-book             karar defteri PDF (imzali link)
 *   POST /api/assemblies/:id/call                  { version, resend?, reason? } cagri e-postasi
 *   PUT  /api/assemblies/:id/attendance/:unitId    { mode, attendeeUserId?, proxyUserId? | proxyName? }
 *   POST /api/assemblies/:id/quorum                { version } yeter sayiyi tutanaga gecir
 *   POST /api/assemblies/:id/agenda/:itemId/tally  { version, yes, no, abstain } | { version, votes }, correctionReason?
 *   PUT  /api/assemblies/:id/minutes               { version, chair?, clerks?, voteCounters?, notes?, generalNotes? }
 *   POST /api/assemblies/:id/finalize              { version } tutanagi kesinlestir
 *   POST /api/assemblies/:id/cancel                { version, reason }
 *   GET  /api/assemblies/:id/attendance-sheet      hazirun cetveli PDF (imzali link)
 *   GET  /api/assemblies/:id/minutes               toplanti tutanagi PDF (imzali link)
 *   GET  /api/portal/assemblies[/:id[/minutes]]    kat maliki sakin gorunumu
 *
 * KMK m.30: toplanti yeter sayisi kat maliklerinin sayi VE arsa payi cogunlugu (ikinci toplantida
 * aranmaz). Karar: gundem maddesinin gerekli cogunlugu (katilanlarin oy cogunlugu veya butun kat
 * maliklerinin nitelikli cogunlugu / oybirligi). m.31: oy kisi basina ucte birle sinirli.
 */

export const ASSEMBLY_KINDS = ['ordinary', 'extraordinary'] as const;
export type AssemblyKind = (typeof ASSEMBLY_KINDS)[number];
export const ASSEMBLY_STATUSES = ['planned', 'held', 'cancelled'] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];
export const ATTENDANCE_MODES = ['present', 'proxy', 'absent'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];
export const MAX_AGENDA_ITEMS = 30;
/** KMK m.30: ikinci toplanti ilk toplantidan en gec bu kadar gun sonra. */
export const SECOND_MEETING_MAX_DAYS = 15;
/** KMK m.29/3: ilk ve ikinci toplanti arasinda en az bu kadar gun (7 dahil gecerli). */
export const SECOND_MEETING_MIN_DAYS = 7;

/** API ile ayni (apps/api/src/modules/assemblies/majority.ts). */
export const MAJORITY_RULES = [
  'attendees',
  'persons_and_land',
  'four_fifths_persons',
  'four_fifths_votes',
  'four_fifths_persons_and_land',
  'two_thirds_votes',
  'unanimous',
] as const;
export type MajorityRule = (typeof MAJORITY_RULES)[number];
/** Bolum bazinda oy gereken (payda butun kat malikleri) kurallar. */
export const QUALIFIED_RULES: readonly MajorityRule[] = MAJORITY_RULES.filter((r) => r !== 'attendees');
/** Kat maliki KISI sayisiyla sayilan kurallar ("sayi ... cogunlugu", "yazili riza"). */
export const PERSON_RULES: readonly MajorityRule[] = ['persons_and_land', 'four_fifths_persons', 'four_fifths_persons_and_land'];

export const MAJORITY_LABELS: Record<MajorityRule, string> = {
  attendees: 'Katılanların oy çokluğu',
  persons_and_land: 'Bütün kat maliklerinin sayı (kişi) ve arsa payı çoğunluğu',
  four_fifths_persons: 'Bütün kat maliklerinin beşte dördü (kişi sayısı)',
  four_fifths_votes: 'Bütün kat maliklerinin oylarının beşte dördü',
  four_fifths_persons_and_land: 'Bütün kat maliklerinin kişi sayısı ve arsa payı bakımından beşte dördü',
  two_thirds_votes: 'Bütün kat maliklerinin oylarının üçte ikisi',
  unanimous: 'Bütün kat maliklerinin oybirliği',
};

export const DECISION_KINDS = [
  'general',
  'operating_budget',
  'manager_election',
  'auditor_election',
  'beneficial_improvement',
  'common_area_change',
  'management_plan_change',
  'use_change',
  'central_heating_conversion',
  'major_disposition',
  'additional_floor',
  'custom',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Hazir karar turleri (API ile ayni cogunluklar); `custom` icin cogunluk secilir. */
export const DECISION_PRESETS: Record<Exclude<DecisionKind, 'custom'>, { rule: MajorityRule; label: string; legal: string; hint?: string }> = {
  general: { rule: 'attendees', label: 'Genel karar', legal: 'KMK m.30' },
  operating_budget: { rule: 'attendees', label: 'İşletme projesi', legal: 'KMK m.37, m.30' },
  manager_election: { rule: 'persons_and_land', label: 'Yönetici seçimi', legal: 'KMK m.34' },
  auditor_election: { rule: 'persons_and_land', label: 'Denetçi seçimi', legal: 'KMK m.41' },
  beneficial_improvement: { rule: 'persons_and_land', label: 'Ortak yerlerde faydalı yenilik / ilave, ısı yalıtımı, yakıt veya ısıtma sistemi değişikliği', legal: 'KMK m.42' },
  common_area_change: {
    rule: 'four_fifths_persons',
    label: 'Ortak yerlerde inşaat veya tesis, dış cephede farklı renk boya (kat maliklerinin yazılı rızası)',
    legal: 'KMK m.19/2',
    hint: 'Olağan bakım ve onarım yöneticinin görevidir (KMK m.35/b) ve beşte dört gerektirmez.',
  },
  management_plan_change: { rule: 'four_fifths_votes', label: 'Yönetim planı değişikliği', legal: 'KMK m.28' },
  use_change: {
    rule: 'unanimous',
    label: 'Konut olarak kayıtlı bölümün m.24/2’de sayılan işyerine (eğlence yeri, lokanta, fırın, imalathane vb.) dönüştürülmesi',
    legal: 'KMK m.24/2',
    hint: 'Konut olarak kayıtlı bölümde hastane, dispanser, klinik, poliklinik, ilaç laboratuvarı gibi müesseseler oybirliğiyle de açılamaz (KMK m.24/1).',
  },
  central_heating_conversion: { rule: 'unanimous', label: '2.000 m² ve üzeri binada merkezi ısıtmadan bireysel ısıtmaya geçiş', legal: 'KMK m.42/4' },
  major_disposition: { rule: 'unanimous', label: 'Ana gayrimenkulün hakla kayıtlanması, arsanın bölünmesi, çatı / dış duvar reklam kirası', legal: 'KMK m.45' },
  additional_floor: { rule: 'unanimous', label: 'Kat veya bağımsız bölüm ilavesi', legal: 'KMK m.44' },
};

export const kindLabel = (k: DecisionKind) => (k === 'custom' ? 'Özel (yönetim planı / diğer)' : DECISION_PRESETS[k].label);
export const ruleOf = (kind: DecisionKind, custom?: MajorityRule): MajorityRule | undefined => (kind === 'custom' ? custom : DECISION_PRESETS[kind].rule);

export const VOTE_CHOICES = ['yes', 'no', 'abstain'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];
export const CHOICE_LABELS: Record<VoteChoice, string> = { yes: 'Kabul', no: 'Ret', abstain: 'Çekimser' };

const share = z.object({ numerator: z.number().int(), denominator: z.number().int() });
const choiceCounts = z.object({ yes: z.number().int(), no: z.number().int(), abstain: z.number().int() });

const tallySchema = z.object({
  yes: z.number().int(),
  no: z.number().int(),
  abstain: z.number().int(),
  presentVotes: z.number().int(),
  decision: z.enum(['accepted', 'rejected']),
  recordedAt: z.string(),
  rule: z.enum(MAJORITY_RULES).optional(),
  mode: z.enum(['counts', 'units']).optional(),
  seq: z.number().int().optional(),
  /** Secim maddesi: secilen aday (`null`: secim yapilamadi). */
  winnerCandidateId: z.string().nullable().optional(),
});

/** Secim maddesi adayi (yonetici / denetci). */
export const candidateSchema = z.object({ candidateId: z.string(), name: z.string(), userId: z.string().optional() });
export type Candidate = z.infer<typeof candidateSchema>;
/** Aday girilebilen karar turleri (API `ELECTION_KINDS`). */
export const ELECTION_KINDS = ['manager_election', 'auditor_election'] as const;
export const isElectionKind = (k: string | undefined) => (ELECTION_KINDS as readonly string[]).includes(k ?? '');
export const ABSTAIN = 'abstain';
export const MAX_CANDIDATES = 12;

export const rescheduleSchema = z.object({
  seq: z.number().int(),
  previousScheduledAt: z.string(),
  previousLocation: z.string().optional(),
  previousOnlineUrl: z.string().optional(),
  scheduledAt: z.string(),
  location: z.string().optional(),
  onlineUrl: z.string().optional(),
  previousSecondMeetingPlan: z.object({ scheduledAt: z.string(), location: z.string().optional(), onlineUrl: z.string().optional() }).optional(),
  secondMeetingPlan: z.object({ scheduledAt: z.string(), location: z.string().optional(), onlineUrl: z.string().optional() }).optional(),
  reason: z.string(),
  at: z.string(),
});
export type Reschedule = z.infer<typeof rescheduleSchema>;

const placeSchema = { location: z.string().optional(), onlineUrl: z.string().optional() };

export const callSummarySchema = z.object({
  seq: z.number().int(),
  calledAt: z.string(),
  recipients: z.number().int(),
  ownersWithoutAccount: z.number().int(),
  daysBefore: z.number().int(),
  lateNotice: z.boolean(),
  resend: z.boolean(),
  reason: z.string().optional(),
  /** Cagrida bildirilen toplanti zamani (eski kayitta yok). */
  scheduledAt: z.string().optional(),
  /** Buyuk sitede bildirim parca sayisi. */
  parts: z.number().int().optional(),
});
export type CallSummary = z.infer<typeof callSummarySchema>;

export const minutesSchema = z.object({
  chair: z.string().optional(),
  clerks: z.array(z.string()),
  voteCounters: z.array(z.string()),
  notes: z.record(z.string(), z.string()),
  generalNotes: z.string().optional(),
  updatedAt: z.string(),
});
export type Minutes = z.infer<typeof minutesSchema>;

export const assemblySchema = z.object({
  assemblyId: z.string(),
  kind: z.enum(ASSEMBLY_KINDS),
  secondMeeting: z.boolean(),
  firstMeetingId: z.string().optional(),
  scheduledAt: z.string(),
  ...placeSchema,
  rollDate: z.string(),
  roll: z.object({ frozenAt: z.string(), units: z.number().int() }).optional(),
  quorumRecord: z
    .object({
      met: z.boolean(),
      presentOwners: z.number().int(),
      totalOwners: z.number().int(),
      presentVotes: z.number().int(),
      totalVotes: z.number().int(),
      noAttendance: z.boolean(),
      recordedAt: z.string(),
    })
    .optional(),
  agenda: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      decisionKind: z.enum(DECISION_KINDS).optional(),
      majority: z.enum(MAJORITY_RULES).optional(),
      candidates: z.array(candidateSchema).optional(),
      tally: tallySchema.optional(),
    }),
  ),
  secondMeetingPlan: z.object({ scheduledAt: z.string(), ...placeSchema }).optional(),
  calls: z.array(callSummarySchema).optional(),
  /** Cagridan sonra ertelemeler / yer degisiklikleri (maliklere bildirildi). */
  reschedules: z.array(rescheduleSchema).optional(),
  minutes: minutesSchema.optional(),
  /** Ilk karar ani: sonra katilim degistirilemez. */
  attendanceLockedAt: z.string().optional(),
  status: z.enum(ASSEMBLY_STATUSES),
  heldAt: z.string().optional(),
  cancelReason: z.string().optional(),
  cancelledAt: z.string().optional(),
  /** Iptal bildirimi gonderildi (cagrisi gonderilmis toplanti). */
  cancelEventId: z.string().optional(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type Assembly = z.infer<typeof assemblySchema>;
export type AgendaItem = Assembly['agenda'][number];

/** Eski kayitta karar turu / cogunluk yok: genel karar, katilanlarin oy cogunlugu. */
export const itemKind = (i: Pick<AgendaItem, 'decisionKind'>): DecisionKind => i.decisionKind ?? 'general';
export const itemRule = (i: Pick<AgendaItem, 'majority'>): MajorityRule => i.majority ?? 'attendees';

/**
 * Toplanti yeter sayisinin sayi olcutu kat maliki (ayri kisiler; hisseli bolum temsilcisiyle bir kez),
 * karar olcutu oy (bolum basina bir, kisi basina en fazla `voteCap`). `totalVotes` butun oylar (sinirsiz).
 */
export const quorumSchema = z.object({
  totalUnits: z.number().int(),
  presentUnits: z.number().int(),
  proxyUnits: z.number().int(),
  totalOwners: z.number().int(),
  presentOwners: z.number().int(),
  ownersBps: z.number().int(),
  totalVotes: z.number().int(),
  presentVotes: z.number().int(),
  voteCap: z.number().int(),
  cappedOwners: z.number().int(),
  landShareComputable: z.boolean(),
  totalLandShare: fractionSchema.nullable(),
  presentLandShare: fractionSchema.nullable(),
  landShareBps: z.number().int().nullable(),
  ownersMajority: z.boolean(),
  landShareMajority: z.boolean(),
  secondMeeting: z.boolean(),
  met: z.boolean(),
  decisionThreshold: z.number().int(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type Quorum = z.infer<typeof quorumSchema>;

const proxySchema = z.object({ userId: z.string().optional(), name: z.string() });

export const assemblyUnitSchema = z.object({
  unitId: z.string(),
  blockId: z.string(),
  number: z.string(),
  landShare: share.optional(),
  owners: z.array(z.object({ userId: z.string(), name: z.string().optional(), share: share.optional() })),
  attendance: z
    .object({
      mode: z.enum(ATTENDANCE_MODES),
      attendee: z.object({ userId: z.string(), name: z.string().optional() }).optional(),
      proxy: proxySchema.optional(),
      recordedAt: z.string(),
      version: z.number().int(),
    })
    .optional(),
  /** Katilan bolumde oyu kullanan kisi: ayni anahtarli bolumler ayni oyu alir (KMK m.31). */
  voterKey: z.string().optional(),
  /** Kisi sayimli kurallarda ayni kat malikine dusen bolumler ayni oyu alir. */
  personKey: z.string().optional(),
  warnings: z.array(z.string()),
});
export type AssemblyUnit = z.infer<typeof assemblyUnitSchema>;

export const outcomeSchema = z.object({
  rule: z.enum(MAJORITY_RULES),
  mode: z.enum(['counts', 'units']),
  decision: z.enum(['accepted', 'rejected']),
  votes: choiceCounts.extend({ notVoted: z.number().int() }),
  units: choiceCounts.extend({ notVoted: z.number().int(), absent: z.number().int() }).nullable(),
  persons: choiceCounts.extend({ notVoted: z.number().int(), absent: z.number().int(), total: z.number().int() }).nullable(),
  landShare: z.object({ yes: fractionSchema, no: fractionSchema, abstain: fractionSchema }).nullable(),
  landShareBps: choiceCounts.nullable(),
  presentVotes: z.number().int(),
  allVotes: z.number().int(),
  totalVotes: z.number().int(),
  voteCap: z.number().int(),
  totalLandShare: fractionSchema.nullable(),
  landShareComputable: z.boolean(),
  required: z.object({ votes: z.number().int().nullable(), persons: z.number().int().nullable(), landShare: fractionSchema.nullable(), units: z.number().int().nullable() }),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type DecisionOutcome = z.infer<typeof outcomeSchema>;

const counts3 = z.object({ votes: z.number().int(), persons: z.number().int(), units: z.number().int() });
export const electionSchema = z.object({
  rule: z.enum(MAJORITY_RULES),
  candidates: z.array(
    z.object({
      candidateId: z.string(),
      name: z.string(),
      userId: z.string().optional(),
      votes: z.number().int(),
      persons: z.number().int(),
      units: z.number().int(),
      landShare: fractionSchema.nullable(),
      landShareBps: z.number().int().nullable(),
      elected: z.boolean(),
      reasons: z.array(z.string()),
    }),
  ),
  winnerCandidateId: z.string().nullable(),
  abstain: counts3,
  notVoted: counts3,
  absent: z.object({ persons: z.number().int(), units: z.number().int() }),
  required: z.object({ persons: z.number().int().nullable(), landShare: fractionSchema.nullable() }),
  totalPersons: z.number().int(),
  totalLandShare: fractionSchema.nullable(),
  noWinner: z.string().optional(),
  warnings: z.array(z.string()),
});
export type Election = z.infer<typeof electionSchema>;

export const decisionSchema = z.object({
  itemId: z.string(),
  seq: z.number().int(),
  outcome: outcomeSchema,
  unitVotes: z.record(z.string(), z.enum(VOTE_CHOICES)).optional(),
  /** Secim maddesi: bolum bazinda aday (veya `abstain`) ve sonuc. */
  unitBallots: z.record(z.string(), z.string()).optional(),
  election: electionSchema.optional(),
  supersedes: z.number().int().optional(),
  correctionReason: z.string().optional(),
  /** Y1 sayimini duzelten ilk kayit: eski sayim. */
  legacyTally: tallySchema.optional(),
  recordedAt: z.string(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const callCheckSchema = z.object({
  daysBefore: z.number().int(),
  lateNotice: z.boolean(),
  recipients: z.number().int(),
  ownersWithoutAccount: z.number().int(),
  warnings: z.array(z.string()),
});
export type CallCheck = z.infer<typeof callCheckSchema>;

export const assemblyDetailSchema = z.object({
  assembly: assemblySchema,
  rollFrozen: z.boolean(),
  quorum: quorumSchema,
  units: z.array(assemblyUnitSchema),
  decisions: z.array(decisionSchema).default([]),
  warnings: z.array(z.string()).default([]),
  callOutdated: z.boolean().default(false),
  callCheck: callCheckSchema.optional(),
});
export type AssemblyDetail = z.infer<typeof assemblyDetailSchema>;

export const callResultSchema = z.object({ assembly: assemblySchema, call: callSummarySchema, warnings: z.array(z.string()) });
export const rescheduleResultSchema = z.object({ assembly: assemblySchema, reschedule: rescheduleSchema, warnings: z.array(z.string()) });

// ---------------------------------------------------------------------------
// Yasal cagri teslim takibi (KMK m.29)
// ---------------------------------------------------------------------------

export const SERVICE_METHODS = ['hand_signed', 'registered_mail', 'email_info'] as const;
export type ServiceMethod = (typeof SERVICE_METHODS)[number];
export const SERVICE_METHOD_LABELS: Record<ServiceMethod, string> = { hand_signed: 'İmza karşılığı elden', registered_mail: 'Taahhütlü mektup', email_info: 'E-posta bilgilendirme' };
export const SERVICE_STATUSES = ['pending', 'delivered', 'returned'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = { pending: 'Bekliyor', delivered: 'Teslim edildi', returned: 'İade' };
/** `late_delivery`: zamaninda postalandi, son gunden sonra teslim edildi (zamanlilik teslim tarihiyle). */
export const SERVICE_STATES = ['served', 'late_delivery', 'served_late', 'pending', 'returned', 'none'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];
export const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  served: 'Tebliğ edildi',
  late_delivery: 'Zamanında postalandı, geç teslim',
  served_late: 'Süre sonrası tebliğ',
  pending: 'Teslim bekleniyor',
  returned: 'İade döndü',
  none: 'Tebligat yok',
};
export const SERVICE_STATE_TONES = { served: 'success', late_delivery: 'warning', served_late: 'warning', pending: 'accent', returned: 'danger', none: 'neutral' } as const satisfies Record<ServiceState, string>;

export const serviceAttemptSchema = z.object({
  seq: z.number().int(),
  method: z.enum(SERVICE_METHODS),
  sentOn: z.string(),
  referenceNo: z.string().optional(),
  status: z.enum(SERVICE_STATUSES),
  statusOn: z.string().optional(),
  note: z.string().optional(),
  voidedAt: z.string().optional(),
  voidedBy: z.string().optional(),
  voidReason: z.string().optional(),
  /** Kaydedildigi andaki toplanti zamani / erteleme sirasi; `stale`: son ertelemeden once (yeni tarih icin gecersiz). */
  meetingAt: z.string().optional(),
  rescheduleSeq: z.number().int().optional(),
  stale: z.boolean().optional(),
  recordedAt: z.string(),
  recordedBy: z.string(),
});
export type ServiceAttempt = z.infer<typeof serviceAttemptSchema>;

export const serviceReportSchema = z.object({
  assemblyId: z.string(),
  kind: z.enum(ASSEMBLY_KINDS),
  secondMeeting: z.boolean(),
  rollFrozen: z.boolean(),
  scheduledAt: z.string().optional(),
  /** Guvenli okuma (tebligat gunu sayilmaz): son teslim gunu = toplanti - 16 gun. */
  deadline: z.string(),
  /** Tebligat gunu sayilirsa: toplanti - 15 gun. */
  deadlineLenient: z.string().optional(),
  daysToDeadline: z.number().int(),
  summary: z.object({
    owners: z.number().int(),
    served: z.number().int(),
    lateDelivery: z.number().int().optional(),
    servedLate: z.number().int(),
    pending: z.number().int(),
    returned: z.number().int(),
    none: z.number().int(),
    staleAttempts: z.number().int().optional(),
    unserved: z.number().int(),
  }),
  warnings: z.array(z.string()),
  rows: z.array(
    z.object({
      ownerId: z.string(),
      name: z.string().optional(),
      units: z.array(z.object({ unitId: z.string(), blockId: z.string(), number: z.string() })),
      state: z.enum(SERVICE_STATES),
      servedOn: z.string().optional(),
      attempts: z.array(serviceAttemptSchema),
      version: z.number().int(),
    }),
  ),
});
export type ServiceReport = z.infer<typeof serviceReportSchema>;
export type ServiceRow = ServiceReport['rows'][number];

export type ServiceAttemptInput = { version: number; method: ServiceMethod; sentOn: string; referenceNo?: string; status?: ServiceStatus; statusOn?: string; note?: string };
export type ServiceUpdateInput = { version: number; status: 'delivered' | 'returned'; statusOn: string; note?: string } | { version: number; void: true; reason: string };

// ---------------------------------------------------------------------------
// Toplanti disinda yazili riza
// ---------------------------------------------------------------------------

/** Yazili rizaya acik karar turleri (API `CONSENT_KINDS`; dayanak ve not API yanitinda). */
export const CONSENT_KINDS = ['common_area_change', 'management_plan_change', 'use_change', 'central_heating_conversion', 'major_disposition', 'additional_floor', 'custom'] as const satisfies readonly DecisionKind[];
export type ConsentKind = (typeof CONSENT_KINDS)[number];
/**
 * Ozel turde secilebilen cogunluklar (API ile ayni): yalnizca nitelikli. Basit cogunluk toplanti karari
 * ister (m.30, m.42/1); yazili rizayla toplanti atlanamaz.
 */
export const CONSENT_RULES: readonly MajorityRule[] = ['four_fifths_persons', 'four_fifths_votes', 'four_fifths_persons_and_land', 'two_thirds_votes', 'unanimous'];
/** Hisseli bolumde butun paydaslarin imzasi gereken (tasarruf niteligindeki) oybirligi turleri. */
export const ALL_COOWNER_KINDS: readonly DecisionKind[] = ['major_disposition', 'additional_floor', 'use_change'];
export const CONSENT_MAX_DAYS = 90;
export const CONSENT_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const CONSENT_STATUS_LABELS: Record<ConsentStatus, string> = { open: 'İmza toplanıyor', closed: 'Sonuç kesinleşti', cancelled: 'İptal edildi' };
export const CONSENT_STATUS_TONES = { open: 'accent', closed: 'success', cancelled: 'neutral' } as const satisfies Record<ConsentStatus, string>;
export const CONSENT_CHOICES = ['consent', 'object'] as const;
export type ConsentChoice = (typeof CONSENT_CHOICES)[number];
export const CONSENT_CHOICE_LABELS: Record<ConsentChoice, string> = { consent: 'Rıza', object: 'İtiraz' };
export const CONSENT_METHODS = ['wet_signature', 'notarized', 'e_signature', 'other'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];
export const CONSENT_METHOD_LABELS: Record<ConsentMethod, string> = { wet_signature: 'Islak imza', notarized: 'Noter onaylı', e_signature: 'Nitelikli e-imza', other: 'Diğer' };

export const consentSchema = z.object({
  consentId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  decisionKind: z.enum(DECISION_KINDS),
  rule: z.enum(MAJORITY_RULES),
  rollDate: z.string(),
  /** Son kayit gunu (acilis + 90 gun). */
  expiresOn: z.string().optional(),
  roll: z.object({ units: z.number().int() }).passthrough(),
  status: z.enum(CONSENT_STATUSES),
  entryCount: z.number().int().optional(),
  result: outcomeSchema.optional(),
  closedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type Consent = z.infer<typeof consentSchema>;

export const consentEntrySchema = z.object({
  unitId: z.string(),
  seq: z.number().int(),
  choice: z.enum(CONSENT_CHOICES),
  signerUserId: z.string(),
  /** Butun paydaslarin imzasi gereken turlerde imzalayanlar. */
  signerUserIds: z.array(z.string()).optional(),
  signerName: z.string().optional(),
  signedOn: z.string(),
  method: z.enum(CONSENT_METHODS),
  methodNote: z.string().optional(),
  document: z.object({ fileName: z.string(), contentType: z.string(), size: z.number() }).optional(),
  supersedes: z.number().int().optional(),
  correctionReason: z.string().optional(),
  recordedAt: z.string(),
});
export type ConsentEntry = z.infer<typeof consentEntrySchema>;

const legalSchema = z.object({ legal: z.string(), note: z.string() });
export const consentDetailSchema = z.object({
  consent: consentSchema,
  legal: legalSchema.optional(),
  outcome: outcomeSchema,
  rows: z.array(
    z.object({
      unitId: z.string(),
      blockId: z.string(),
      number: z.string(),
      landShare: share.optional(),
      owners: z.array(z.object({ userId: z.string(), name: z.string().optional() })),
      entry: consentEntrySchema.optional(),
      records: z.number().int().optional(),
      /** Talep acildiktan sonra malik degisti. */
      ownerChanged: z.boolean().optional(),
    }),
  ),
  warnings: z.array(z.string()).default([]),
  /** Bu turde hisseli bolumun butun paydaslari imzalar. */
  allCoOwners: z.boolean().optional(),
});
export type ConsentDetail = z.infer<typeof consentDetailSchema>;
export type ConsentRow = ConsentDetail['rows'][number];
export const consentCreatedSchema = z.object({ consent: consentSchema, legal: legalSchema });
export const consentRecordSchema = z.object({ entry: consentEntrySchema, outcome: outcomeSchema, documentPending: z.boolean().optional() });

export type ConsentInput = { title: string; description?: string; decisionKind: ConsentKind; majority?: MajorityRule };
export type ConsentEntryInput = {
  choice: ConsentChoice;
  signedOn: string;
  method: ConsentMethod;
  methodNote?: string;
  signerUserId?: string;
  /** Butun paydaslarin imzasi gereken turlerde hisseli bolumun imzalayan paydaslari. */
  signerUserIds?: string[];
  document?: { uploadId: string; fileName: string };
  correctionReason?: string;
};

// ---------------------------------------------------------------------------
// Sakin portali (yalnizca kat maliki; toplam sayilar, kisi / bolum verisi yok)
// ---------------------------------------------------------------------------

export const PORTAL_PHASES = ['upcoming', 'awaiting_minutes', 'held', 'cancelled'] as const;
export type PortalPhase = (typeof PORTAL_PHASES)[number];

export const portalAssemblySchema = z.object({
  assemblyId: z.string(),
  kind: z.enum(ASSEMBLY_KINDS),
  secondMeeting: z.boolean(),
  scheduledAt: z.string(),
  ...placeSchema,
  rollDate: z.string(),
  status: z.enum(ASSEMBLY_STATUSES),
  phase: z.enum(PORTAL_PHASES),
  cancelReason: z.string().optional(),
  cancelledAt: z.string().optional(),
  calledAt: z.string().optional(),
  lastCalledAt: z.string().optional(),
  reschedules: z.array(z.object({ previousScheduledAt: z.string(), scheduledAt: z.string(), placeChanged: z.boolean(), reason: z.string(), at: z.string() })).optional(),
  secondMeetingPlan: z.object({ scheduledAt: z.string(), ...placeSchema }).optional(),
  heldAt: z.string().optional(),
  agenda: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      decisionKind: z.enum(DECISION_KINDS).optional(),
      majority: z.enum(MAJORITY_RULES),
      /** Secim maddesi: aday sayisi (KVKK: diger sakinlerin adi portalda yok). */
      candidateCount: z.number().int().optional(),
      decision: z
        .object({
          decision: z.enum(['accepted', 'rejected']),
          rule: z.enum(MAJORITY_RULES),
          votes: choiceCounts,
          units: choiceCounts.nullable(),
          persons: choiceCounts.extend({ total: z.number().int() }).nullable().optional(),
          landShareBps: choiceCounts.nullable(),
          corrected: z.boolean(),
          recordedAt: z.string(),
          election: z
            .object({
              winnerName: z.string().nullable(),
              noWinner: z.string().optional(),
              candidates: z.array(
                z.object({ candidateId: z.string(), name: z.string(), votes: z.number().int(), persons: z.number().int(), units: z.number().int(), landShareBps: z.number().int().nullable(), elected: z.boolean() }),
              ),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
  quorum: z
    .object({
      met: z.boolean(),
      secondMeeting: z.boolean(),
      noAttendance: z.boolean(),
      presentOwners: z.number().int(),
      totalOwners: z.number().int(),
      presentVotes: z.number().int(),
      totalVotes: z.number().int(),
    })
    .optional(),
  minutesAvailable: z.boolean(),
});
export type PortalAssembly = z.infer<typeof portalAssemblySchema>;
export type PortalDecision = NonNullable<PortalAssembly['agenda'][number]['decision']>;

export const PORTAL_PHASE_LABELS: Record<PortalPhase, string> = {
  upcoming: 'Yaklaşan',
  awaiting_minutes: 'Tutanak bekleniyor',
  held: 'Toplantı yapıldı',
  cancelled: 'İptal edildi',
};
export const PORTAL_PHASE_TONES = { upcoming: 'accent', awaiting_minutes: 'warning', held: 'success', cancelled: 'neutral' } as const satisfies Record<PortalPhase, string>;

// ---------------------------------------------------------------------------
// Girdi tipleri ve etiketler
// ---------------------------------------------------------------------------

export type SecondMeetingPlanInput = { scheduledAt: string; location?: string; onlineUrl?: string };

export type AssemblyInput = {
  kind: AssemblyKind;
  scheduledAt: string;
  location?: string | null;
  onlineUrl?: string | null;
  /** Ikinci toplanti ise yeter sayisizligi tutanaga gecmis ilk toplanti. */
  firstMeetingId?: string | null;
  /** Ilk toplantida cagrida bildirilecek ikinci toplanti (KMK m.29); `null` temizler. */
  secondMeetingPlan?: SecondMeetingPlanInput | null;
  agenda: { title: string; description?: string; decisionKind?: DecisionKind; majority?: MajorityRule; candidates?: { name: string; userId?: string }[] }[];
};

export type AttendanceInput = { mode: AttendanceMode; attendeeUserId?: string; proxyUserId?: string; proxyName?: string };

export type TallyInput = { version: number; correctionReason?: string } & ({ yes: number; no: number; abstain: number } | { votes: Record<string, VoteChoice> } | { ballots: Record<string, string> });

/** Cagrisi gonderilmis toplantinin ertelenmesi / yer degisikligi (maliklere bildirim gider). */
export type RescheduleInput = {
  version: number;
  reason: string;
  scheduledAt?: string;
  location?: string | null;
  onlineUrl?: string | null;
  /** Ilk toplanti ertelenince ikinci toplanti plani yeniden bildirilir (KMK m.29/3); `null` kaldirir. */
  secondMeetingPlan?: SecondMeetingPlanInput | null;
};

export type MinutesInput = { version: number; chair?: string | null; clerks?: string[]; voteCounters?: string[]; notes?: Record<string, string>; generalNotes?: string };

export const KIND_LABELS: Record<AssemblyKind, string> = { ordinary: 'Olağan toplantı', extraordinary: 'Olağanüstü toplantı' };
export const MODE_LABELS: Record<AttendanceMode, string> = { present: 'Asaleten', proxy: 'Vekaleten', absent: 'Katılmadı' };
export const STATUS_LABELS: Record<AssemblyStatus, string> = { planned: 'Planlandı', held: 'Tutanak kesinleşti', cancelled: 'İptal edildi' };
export const STATUS_TONES = { planned: 'accent', held: 'success', cancelled: 'neutral' } as const satisfies Record<AssemblyStatus, string>;
export const DECISION_LABELS = { accepted: 'Kabul edildi', rejected: 'Reddedildi' } as const;

/** Yeter sayi ozeti (ekran metni); saglanmadiysa API'nin verdigi nedenler. */
export function quorumText(q: Quorum): string {
  if (q.secondMeeting) return 'İkinci toplantı: toplantı yeter sayısı aranmaz; kararlar gündem maddesinin gerekli çoğunluğuyla alınır.';
  if (q.met) return 'Toplantı yeter sayısı sağlandı (sayı ve arsa payı çoğunluğu).';
  return `Toplantı yeter sayısı sağlanmadı: ${q.reasons.join('; ')}. Gündem sayımı kaydedilemez.`;
}

/** Ikinci toplantiya baglanabilecek ilk toplantilar: iptal edilmemis, ikinci toplanti olmayan, yeter sayisizligi tutanakta. */
export const firstMeetingCandidates = (items: readonly Assembly[], selfId?: string) =>
  items.filter((a) => a.assemblyId !== selfId && a.status !== 'cancelled' && !a.secondMeeting && a.quorumRecord?.met === false);

/** Gerekli cogunlugun sayisal ifadesi (karar kaydindan). */
export function requiredText(o: DecisionOutcome): string {
  const fr = (f: { numerator: string; denominator: string }) => `${f.numerator}/${f.denominator}`;
  const parts: string[] = [];
  if (o.rule === 'unanimous') parts.push(`${o.required.units ?? 0} bölümün tamamı`);
  else if (o.required.votes !== null) parts.push(`en az ${o.required.votes} kabul oyu`);
  if (o.required.persons !== null) parts.push(`en az ${o.required.persons} kat maliki (kişi)`);
  if (o.required.landShare) parts.push(`en az ${fr(o.required.landShare)} arsa payı`);
  const base =
    o.rule === 'attendees' ? `katılan ${o.presentVotes} oy` : o.required.persons !== null ? `bütün kat malikleri ${o.persons?.total ?? '?'} kişi` : `bütün kat maliklerinin ${o.allVotes} oyu`;
  return `${parts.join(' ve ')} (${base})`;
}

/** Cagri metni: ilk / son gonderim. */
export function callText(calls: readonly CallSummary[] | undefined, format: (iso: string) => string): string | null {
  if (!calls?.length) return null;
  const first = calls[0] as CallSummary;
  const last = calls[calls.length - 1] as CallSummary;
  const base = `Çağrı ${format(first.calledAt)} tarihinde gönderildi (${first.recipients} kat maliki, toplantıdan ${first.daysBefore} gün önce)`;
  return calls.length > 1 ? `${base}; son yeniden gönderim ${format(last.calledAt)}.` : `${base}.`;
}
