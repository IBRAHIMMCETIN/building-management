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
});

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
      tally: tallySchema.optional(),
    }),
  ),
  secondMeetingPlan: z.object({ scheduledAt: z.string(), ...placeSchema }).optional(),
  calls: z.array(callSummarySchema).optional(),
  minutes: minutesSchema.optional(),
  /** Ilk karar ani: sonra katilim degistirilemez. */
  attendanceLockedAt: z.string().optional(),
  status: z.enum(ASSEMBLY_STATUSES),
  heldAt: z.string().optional(),
  cancelReason: z.string().optional(),
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

export const decisionSchema = z.object({
  itemId: z.string(),
  seq: z.number().int(),
  outcome: outcomeSchema,
  unitVotes: z.record(z.string(), z.enum(VOTE_CHOICES)).optional(),
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
  calledAt: z.string().optional(),
  lastCalledAt: z.string().optional(),
  secondMeetingPlan: z.object({ scheduledAt: z.string(), ...placeSchema }).optional(),
  heldAt: z.string().optional(),
  agenda: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      decisionKind: z.enum(DECISION_KINDS).optional(),
      majority: z.enum(MAJORITY_RULES),
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
  agenda: { title: string; description?: string; decisionKind?: DecisionKind; majority?: MajorityRule }[];
};

export type AttendanceInput = { mode: AttendanceMode; attendeeUserId?: string; proxyUserId?: string; proxyName?: string };

export type TallyInput = { version: number; correctionReason?: string } & ({ yes: number; no: number; abstain: number } | { votes: Record<string, VoteChoice> });

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
