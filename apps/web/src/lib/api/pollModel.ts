import { z } from 'zod';
import { formatBps } from '@/lib/ownership/shares';

/*
 * Y1 anket / oylama veri modeli: semalar, tipler ve saf yardimcilar. API istemcisine bagimli
 * DEGILDIR; testler ve formlar buradan import eder. Uclar icin bkz. ./polls.ts.
 *
 *   Yonetici:  GET  /api/polls?status=draft|scheduled|open|closed|cancelled|all
 *              POST /api/polls                        -> taslak
 *              PATCH /api/polls/:id                   { version, ... } (yalnizca taslak)
 *              POST /api/polls/:id/publish            { version }
 *              POST /api/polls/:id/close              { version, reason } (erken kapatma)
 *              POST /api/polls/:id/cancel             { version } (taslak iptali)
 *              GET  /api/polls/:id/results | /participation
 *   Sakin:     GET  /api/portal/polls?unitId | /:id?unitId,  POST /:id/vote?unitId { optionId }
 *
 * Bolum basina tek oy: hisseli mulkiyette paydaslardan birinin sonraki oyu oncekinin yerine
 * gecer. Gizli oylamada (varsayilan) oylama surerken secenek dagilimi kimseye gosterilmez ve
 * yonetim hangi bolumun neyi sectigini hicbir zaman gormez.
 */

export const POLL_PHASES = ['draft', 'scheduled', 'open', 'closed', 'cancelled'] as const;
export type PollPhase = (typeof POLL_PHASES)[number];
export type PollPhaseFilter = PollPhase | 'all';

export const POLL_AUDIENCES = ['owners', 'residents'] as const;
export type PollAudience = (typeof POLL_AUDIENCES)[number];
export const POLL_WEIGHTINGS = ['per_unit', 'land_share'] as const;
export type PollWeighting = (typeof POLL_WEIGHTINGS)[number];

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

/** Toplam kesirleri BigInt metni (API: paydalar cok farkli olsa da tasma yok). */
export const fractionSchema = z.object({ numerator: z.string().regex(/^\d+$/), denominator: z.string().regex(/^\d+$/) });
export type Fraction = z.infer<typeof fractionSchema>;
/** Bolumun kendi arsa payi (tapudaki kesir). */
const shareSchema = z.object({ numerator: z.number().int(), denominator: z.number().int() });

const optionSchema = z.object({ optionId: z.string(), label: z.string() });
export type PollOption = z.infer<typeof optionSchema>;

export const pollSchema = z.object({
  pollId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  options: z.array(optionSchema),
  audience: z.enum(POLL_AUDIENCES),
  weighting: z.enum(POLL_WEIGHTINGS),
  secret: z.boolean(),
  resultsVisibleBeforeClose: z.boolean(),
  opensAt: z.string(),
  closesAt: z.string(),
  rollDate: z.string(),
  status: z.enum(['draft', 'published', 'closed', 'cancelled']),
  phase: z.enum(POLL_PHASES),
  publishedAt: z.string().optional(),
  closedAt: z.string().optional(),
  closeReason: z.string().optional(),
  closedEarly: z.boolean().optional(),
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type Poll = z.infer<typeof pollSchema>;

export const pollResultsSchema = z.object({
  pollId: z.string(),
  phase: z.enum(POLL_PHASES),
  final: z.boolean(),
  weighting: z.enum(POLL_WEIGHTINGS),
  rollDate: z.string(),
  eligible: z.object({ units: z.number().int(), landShare: fractionSchema.nullable() }),
  participation: z.object({
    units: z.number().int(),
    unitsBps: z.number().int(),
    landShare: fractionSchema.nullable(),
    landShareBps: z.number().int().nullable(),
  }),
  tallyHidden: z.boolean(),
  options: z
    .array(
      z.object({
        optionId: z.string(),
        label: z.string(),
        units: z.number().int(),
        unitsBps: z.number().int(),
        landShare: fractionSchema.nullable(),
        landShareBps: z.number().int().nullable(),
      }),
    )
    .optional(),
  winnerOptionId: z.string().nullable().optional(),
  warnings: z.array(z.string()),
});
export type PollResults = z.infer<typeof pollResultsSchema>;

/** Gizli oylamada `hidden`: hangi bolumun oy kullandigi planlanan bitise (`hiddenUntil`) kadar gizli. */
export const participationSchema = z.object({
  secret: z.boolean(),
  hidden: z.boolean(),
  hiddenUntil: z.string().optional(),
  votedUnits: z.number().int(),
  items: z.array(
    z.object({
      unitId: z.string(),
      blockId: z.string(),
      number: z.string(),
      landShare: shareSchema.optional(),
      voted: z.boolean(),
      optionId: z.string().optional(),
      castAt: z.string().optional(),
      voterRelation: z.enum(['owner', 'tenant']).optional(),
      warnings: z.array(z.string()),
    }),
  ),
});
export type PollParticipation = z.infer<typeof participationSchema>;
export type PollUnitRow = PollParticipation['items'][number];

export const portalPollSchema = z.object({
  pollId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  options: z.array(optionSchema),
  audience: z.enum(POLL_AUDIENCES),
  weighting: z.enum(POLL_WEIGHTINGS),
  secret: z.boolean(),
  resultsVisibleBeforeClose: z.boolean(),
  opensAt: z.string(),
  closesAt: z.string(),
  closedAt: z.string().optional(),
  closedEarly: z.boolean().optional(),
  rollDate: z.string(),
  phase: z.enum(POLL_PHASES),
  unitId: z.string(),
  eligible: z.boolean(),
  canVote: z.boolean(),
  ineligibleReason: z.string().optional(),
  myVote: z.object({ castByMe: z.boolean(), optionId: z.string().optional(), castAt: z.string().optional() }).optional(),
  resultsAvailable: z.boolean(),
  /** Ara sonuc acik ama bolum henuz oy kullanmadi: oy verince gorulur. */
  resultsAfterVote: z.boolean(),
  results: pollResultsSchema.optional(),
});
export type PortalPoll = z.infer<typeof portalPollSchema>;

export type CreatePollInput = {
  title: string;
  description?: string;
  options: string[];
  audience: PollAudience;
  weighting: PollWeighting;
  secret: boolean;
  resultsVisibleBeforeClose: boolean;
  opensAt?: string;
  closesAt: string;
};

/** Guncelleme: `null` aciklamayi temizler, `opensAt: null` yayin anina baglar. */
export type UpdatePollInput = Omit<CreatePollInput, 'description' | 'opensAt'> & {
  version: number;
  description: string | null;
  opensAt: string | null;
};

// ---------------------------------------------------------------------------
// Etiketler ve saf yardimcilar
// ---------------------------------------------------------------------------

export const PHASE_LABELS: Record<PollPhase, string> = {
  draft: 'Taslak',
  scheduled: 'Planlandı',
  open: 'Oylamada',
  closed: 'Sona erdi',
  cancelled: 'İptal edildi',
};

export const PHASE_TONES: Record<PollPhase, 'neutral' | 'success' | 'accent' | 'warning'> = {
  draft: 'warning',
  scheduled: 'accent',
  open: 'success',
  closed: 'neutral',
  cancelled: 'neutral',
};

export const AUDIENCE_LABELS: Record<PollAudience, string> = {
  owners: 'Kat malikleri',
  residents: 'Tüm sakinler',
};

export const AUDIENCE_HINTS: Record<PollAudience, string> = {
  owners: 'Mülkiyet siciline göre malikler oy kullanır; kiracılar oy kullanamaz.',
  residents: 'Malik ve kiracılar oy kullanabilir; her bölüm yine tek oy sayılır.',
};

export const WEIGHTING_LABELS: Record<PollWeighting, string> = {
  per_unit: 'Bölüm başına bir oy',
  land_share: 'Arsa payına göre',
};

export const WEIGHTING_HINTS: Record<PollWeighting, string> = {
  per_unit: 'Her bağımsız bölüm eşit bir oy sayılır (sayıca çoğunluk).',
  land_share: 'Oylar bölümün arsa payıyla ağırlıklandırılır; tüm bölümlerde arsa payı girilmiş olmalı.',
};

/** "120/1200" (payda ortak; sadeleştirilmez, tapudaki gibi okunur). */
export const formatFraction = (f: Fraction | { numerator: number; denominator: number }) =>
  `${BigInt(f.numerator).toLocaleString('tr-TR')}/${BigInt(f.denominator).toLocaleString('tr-TR')}`;

export { formatBps };

/** Sonuc cumlesi: kazanan yoksa nedeni. */
export function outcomeText(r: Pick<PollResults, 'final' | 'tallyHidden' | 'winnerOptionId' | 'options' | 'participation' | 'weighting'>): string {
  if (r.tallyHidden) return 'Gizli oylama: sonuçlar oylama bitince açıklanır.';
  if (r.participation.units === 0) return 'Henüz oy kullanılmadı.';
  const winner = r.options?.find((o) => o.optionId === r.winnerOptionId);
  const basis = r.weighting === 'land_share' ? 'arsa payı' : 'bölüm sayısı';
  if (winner) return `${r.final ? 'Sonuç' : 'Şu an önde'}: “${winner.label}” kullanılan oyların salt çoğunluğunu aldı (${basis}).`;
  return `Hiçbir seçenek kullanılan oyların yarısından fazlasını almadı (${basis}); salt çoğunluk ${r.final ? 'sağlanamadı' : 'henüz yok'}.`;
}

/** Secenegin karar olcutundeki payi (cubuk genisligi, baz puan). */
export const optionBasisBps = (o: NonNullable<PollResults['options']>[number], weighting: PollWeighting) =>
  weighting === 'land_share' ? (o.landShareBps ?? 0) : o.unitsBps;

/** Sakin icin oy durumu metni. */
export function myVoteText(p: Pick<PortalPoll, 'myVote' | 'options' | 'secret'>): string | null {
  if (!p.myVote) return null;
  const label = p.options.find((o) => o.optionId === p.myVote?.optionId)?.label;
  if (p.myVote.castByMe) return label ? `Oyunuz: ${label}` : 'Oyunuz kaydedildi';
  return label ? `Dairenizin oyu başka bir paydaş tarafından kullanıldı: ${label}` : 'Dairenizin oyu başka bir paydaş tarafından kullanıldı.';
}
