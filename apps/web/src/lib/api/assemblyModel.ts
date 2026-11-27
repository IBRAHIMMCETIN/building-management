import { z } from 'zod';

/*
 * Y1-3 kat malikleri kurulu (genel kurul) veri modeli: semalar, tipler, etiketler. API istemcisine
 * bagimli DEGILDIR. Uclar icin bkz. ./assemblies.ts.
 *
 *   GET  /api/assemblies | POST /api/assemblies | GET|PATCH /api/assemblies/:id
 *   PUT  /api/assemblies/:id/attendance/:unitId   { mode, attendeeName?, proxyName? }
 *   POST /api/assemblies/:id/agenda/:itemId/tally { version, yes, no, abstain }
 *   POST /api/assemblies/:id/cancel               { version, reason }
 *   GET  /api/assemblies/:id/attendance-sheet     hazirun cetveli PDF (imzali link)
 *
 * KMK m.30: toplanti yeter sayisi kat maliklerinin sayi VE arsa payi cogunlugu (ikinci toplantida
 * aranmaz); karar katilanlarin sayi cogunlugu.
 */

export const ASSEMBLY_KINDS = ['ordinary', 'extraordinary'] as const;
export type AssemblyKind = (typeof ASSEMBLY_KINDS)[number];
export const ATTENDANCE_MODES = ['present', 'proxy', 'absent'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];
export const MAX_AGENDA_ITEMS = 30;

const fraction = z.object({ numerator: z.number().int(), denominator: z.number().int() });

const tallySchema = z.object({
  yes: z.number().int(),
  no: z.number().int(),
  abstain: z.number().int(),
  presentUnits: z.number().int(),
  decision: z.enum(['accepted', 'rejected']),
  recordedAt: z.string(),
});

export const assemblySchema = z.object({
  assemblyId: z.string(),
  kind: z.enum(ASSEMBLY_KINDS),
  secondMeeting: z.boolean(),
  scheduledAt: z.string(),
  location: z.string().optional(),
  onlineUrl: z.string().optional(),
  rollDate: z.string(),
  agenda: z.array(z.object({ itemId: z.string(), title: z.string(), description: z.string().optional(), tally: tallySchema.optional() })),
  status: z.enum(['planned', 'cancelled']),
  cancelReason: z.string().optional(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type Assembly = z.infer<typeof assemblySchema>;
export type AgendaItem = Assembly['agenda'][number];

export const quorumSchema = z.object({
  totalUnits: z.number().int(),
  presentUnits: z.number().int(),
  proxyUnits: z.number().int(),
  unitsBps: z.number().int(),
  totalLandShare: fraction.nullable(),
  presentLandShare: fraction.nullable(),
  landShareBps: z.number().int().nullable(),
  unitsMajority: z.boolean(),
  landShareMajority: z.boolean(),
  secondMeeting: z.boolean(),
  met: z.boolean(),
  decisionThreshold: z.number().int(),
  warnings: z.array(z.string()),
});
export type Quorum = z.infer<typeof quorumSchema>;

export const assemblyUnitSchema = z.object({
  unitId: z.string(),
  blockId: z.string(),
  number: z.string(),
  landShare: fraction.optional(),
  owners: z.array(z.object({ userId: z.string(), name: z.string().optional(), share: fraction.optional() })),
  attendance: z
    .object({ mode: z.enum(ATTENDANCE_MODES), attendeeName: z.string().optional(), proxyName: z.string().optional(), recordedAt: z.string(), version: z.number().int() })
    .optional(),
  warnings: z.array(z.string()),
});
export type AssemblyUnit = z.infer<typeof assemblyUnitSchema>;

export const assemblyDetailSchema = z.object({ assembly: assemblySchema, quorum: quorumSchema, units: z.array(assemblyUnitSchema) });
export type AssemblyDetail = z.infer<typeof assemblyDetailSchema>;

export type AssemblyInput = {
  kind: AssemblyKind;
  scheduledAt: string;
  location?: string | null;
  onlineUrl?: string | null;
  secondMeeting: boolean;
  agenda: { title: string; description?: string }[];
};

export const KIND_LABELS: Record<AssemblyKind, string> = { ordinary: 'Olağan toplantı', extraordinary: 'Olağanüstü toplantı' };
export const MODE_LABELS: Record<AttendanceMode, string> = { present: 'Asaleten', proxy: 'Vekaleten', absent: 'Katılmadı' };

/** Yeter sayi ozeti (ekran metni). */
export function quorumText(q: Quorum): string {
  if (q.secondMeeting) return 'İkinci toplantı: toplantı yeter sayısı aranmaz; kararlar katılanların sayı çoğunluğuyla alınır.';
  if (q.met) return 'Toplantı yeter sayısı sağlandı (sayı ve arsa payı çoğunluğu).';
  const missing = [!q.unitsMajority && 'bölüm sayısı', !q.landShareMajority && 'arsa payı'].filter(Boolean).join(' ve ');
  return `Toplantı yeter sayısı sağlanmadı: ${missing} çoğunluğu yok. Gündem sayımı kaydedilemez.`;
}
