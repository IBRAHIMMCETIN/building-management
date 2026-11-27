import { z } from 'zod';
import { fractionSchema } from './pollModel';

/*
 * Y1-3 kat malikleri kurulu (genel kurul) veri modeli: semalar, tipler, etiketler. API istemcisine
 * bagimli DEGILDIR. Uclar icin bkz. ./assemblies.ts.
 *
 *   GET  /api/assemblies | POST /api/assemblies | GET|PATCH /api/assemblies/:id
 *   PUT  /api/assemblies/:id/attendance/:unitId   { mode, attendeeUserId?, proxyUserId? | proxyName? }
 *   POST /api/assemblies/:id/quorum               { version } yeter sayiyi tutanaga gecir
 *   POST /api/assemblies/:id/agenda/:itemId/tally { version, yes, no, abstain }
 *   POST /api/assemblies/:id/cancel               { version, reason }
 *   GET  /api/assemblies/:id/attendance-sheet     hazirun cetveli PDF (imzali link)
 *
 * Oy listesi ilk katilim / yeter sayi / sayim / hazirun isteginde dondurulur. KMK m.30: toplanti
 * yeter sayisi kat maliklerinin sayi VE arsa payi cogunlugu (ikinci toplantida aranmaz); karar
 * katilanlarin oy cogunlugu. m.31: malik oyu toplam oylarin ucte biriyle sinirli, vekalet sinirli.
 */

export const ASSEMBLY_KINDS = ['ordinary', 'extraordinary'] as const;
export type AssemblyKind = (typeof ASSEMBLY_KINDS)[number];
export const ATTENDANCE_MODES = ['present', 'proxy', 'absent'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];
export const MAX_AGENDA_ITEMS = 30;
/** KMK m.30: ikinci toplanti ilk toplantidan en gec bu kadar gun sonra. */
export const SECOND_MEETING_MAX_DAYS = 15;

const share = z.object({ numerator: z.number().int(), denominator: z.number().int() });

const tallySchema = z.object({
  yes: z.number().int(),
  no: z.number().int(),
  abstain: z.number().int(),
  presentVotes: z.number().int(),
  decision: z.enum(['accepted', 'rejected']),
  recordedAt: z.string(),
});

export const assemblySchema = z.object({
  assemblyId: z.string(),
  kind: z.enum(ASSEMBLY_KINDS),
  secondMeeting: z.boolean(),
  firstMeetingId: z.string().optional(),
  scheduledAt: z.string(),
  location: z.string().optional(),
  onlineUrl: z.string().optional(),
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
  agenda: z.array(z.object({ itemId: z.string(), title: z.string(), description: z.string().optional(), tally: tallySchema.optional() })),
  status: z.enum(['planned', 'cancelled']),
  cancelReason: z.string().optional(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type Assembly = z.infer<typeof assemblySchema>;
export type AgendaItem = Assembly['agenda'][number];

/**
 * Toplanti yeter sayisinin sayi olcutu kat maliki (ayri kisiler; hisseli bolum temsilcisiyle bir kez),
 * karar olcutu katilanlarin oyu (bolum basina bir, kisi basina en fazla `voteCap`). `totalVotes`
 * butun oylar (sinirsiz).
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
  warnings: z.array(z.string()),
});
export type AssemblyUnit = z.infer<typeof assemblyUnitSchema>;

export const assemblyDetailSchema = z.object({ assembly: assemblySchema, rollFrozen: z.boolean(), quorum: quorumSchema, units: z.array(assemblyUnitSchema) });
export type AssemblyDetail = z.infer<typeof assemblyDetailSchema>;

export type AssemblyInput = {
  kind: AssemblyKind;
  scheduledAt: string;
  location?: string | null;
  onlineUrl?: string | null;
  /** Ikinci toplanti ise yeter sayisizligi tutanaga gecmis ilk toplanti. */
  firstMeetingId?: string | null;
  agenda: { title: string; description?: string }[];
};

export type AttendanceInput = { mode: AttendanceMode; attendeeUserId?: string; proxyUserId?: string; proxyName?: string };

export const KIND_LABELS: Record<AssemblyKind, string> = { ordinary: 'Olağan toplantı', extraordinary: 'Olağanüstü toplantı' };
export const MODE_LABELS: Record<AttendanceMode, string> = { present: 'Asaleten', proxy: 'Vekaleten', absent: 'Katılmadı' };

/** Yeter sayi ozeti (ekran metni); saglanmadiysa API'nin verdigi nedenler. */
export function quorumText(q: Quorum): string {
  if (q.secondMeeting) return 'İkinci toplantı: toplantı yeter sayısı aranmaz; kararlar katılanların oy çokluğuyla alınır.';
  if (q.met) return 'Toplantı yeter sayısı sağlandı (sayı ve arsa payı çoğunluğu).';
  return `Toplantı yeter sayısı sağlanmadı: ${q.reasons.join('; ')}. Gündem sayımı kaydedilemez.`;
}

/** Ikinci toplantiya baglanabilecek ilk toplantilar: planli, ikinci toplanti olmayan, yeter sayisizligi tutanakta. */
export const firstMeetingCandidates = (items: readonly Assembly[], selfId?: string) =>
  items.filter((a) => a.assemblyId !== selfId && a.status === 'planned' && !a.secondMeeting && a.quorumRecord?.met === false);
