/**
 * Y1 - Oylama evresi, oy hakki ve sonuc hesabi. SAF fonksiyonlar, I/O yok.
 *
 * Paydalar ve oy hakki yayinda DONDURULAN oy listesinden (`rollSnapshot.ts`) okunur. Agirlik:
 * `per_unit` her bagimsiz bolum 1 oy; `land_share` bolumun arsa payi (ortak paydada BigInt;
 * kayan nokta ve tasma yok). Kazanan: secilen agirliga gore KULLANILAN oylarin salt cogunlugu.
 */
import type { IsoDate, IsoDateTime } from '../core/types.js';
import { coversDay } from '../finance/occupancy.js';
import type { VotingRollItem } from '../ownership/register.js';
import type { UnitMembership } from '../portal/types.js';
import { type RollEntry, type RollMeta, type RollVoter, commonDenominator, scaledWeight } from './rollSnapshot.js';
import type { Fraction, OptionTally, Poll, PollPhase, PollResults, PollUnitRow, PollVote } from './types.js';

export { commonDenominator, scaledWeight };

/** ISO zaman damgasinin Europe/Istanbul takvim gunu. */
export function istanbulDate(iso: IsoDateTime): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(iso));
}

/** Saklanan durum + zaman -> evre. `published` oylama `opensAt` oncesi planli, `closesAt` sonrasi bitmis. */
export function pollPhase(p: Pick<Poll, 'status' | 'opensAt' | 'closesAt'>, nowIso: IsoDateTime): PollPhase {
  if (p.status !== 'published') return p.status;
  if (nowIso < p.opensAt) return 'scheduled';
  if (nowIso >= p.closesAt) return 'closed';
  return 'open';
}

/** Oylamanin fiilen bittigi an (erken kapatma veya bitis zamani). */
export const effectiveCloseAt = (p: Pick<Poll, 'closedAt' | 'closesAt'>): IsoDateTime => p.closedAt ?? p.closesAt;

/**
 * Yayinda dondurulacak oy hakki sahipleri (oy listesi gunu, `rollDate`). Kat maliklerinde oy
 * listesindeki TUM paydaslar (hisseli mulkiyette herhangi biri bolumun tek oyunu kullanir);
 * sakinlerde buna ek olarak o gun gecerli tum uyelikler (kiraci dahil).
 */
export function eligibleVoters(
  poll: Pick<Poll, 'audience' | 'rollDate'>,
  roll: Pick<VotingRollItem, 'unitId' | 'owners'> | undefined,
  memberships: readonly UnitMembership[],
): RollVoter[] {
  const out = new Map<string, RollVoter['relation']>();
  if (!roll) return [];
  for (const o of roll.owners) out.set(o.userId, 'owner');
  if (poll.audience === 'residents') {
    for (const m of memberships) {
      if (m.unitId !== roll.unitId || !coversDay(m, poll.rollDate) || out.has(m.userId)) continue;
      out.set(m.userId, m.relation === 'owner' ? 'owner' : 'tenant');
    }
  }
  return [...out.entries()].map(([userId, relation]) => ({ userId, relation }));
}

/** Baz puan (10.000 = %100), yarim yukari yuvarlama. */
export function toBps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 20_000n + whole) / (2n * whole));
}

/** Kesir metni (BigInt): JSON'da guvenli tam sayi siniri asilmaz. */
export const fraction = (numerator: bigint, denominator: bigint): Fraction => ({ numerator: numerator.toString(), denominator: denominator.toString() });

/** Arsa payi olcutu yalnizca listedeki TUM bolumlerde arsa payi varsa hesaplanabilir. */
export const landShareComputable = (meta: Pick<RollMeta, 'denominator' | 'missingLandShare'>) => meta.denominator !== null && meta.missingLandShare === 0;

// ---------------------------------------------------------------------------
// Sonuc
// ---------------------------------------------------------------------------

/**
 * Oylama sonucu: `entries` yayinda dondurulan oy listesi (payda), `votes` bolum basina en fazla bir
 * oy; listede olmayan bolumun oyu sayilmaz.
 */
export function tallyPoll(input: { poll: Poll & { roll: RollMeta }; entries: readonly RollEntry[]; votes: readonly PollVote[]; nowIso: IsoDateTime }): PollResults {
  const { poll, entries, nowIso } = input;
  const meta = poll.roll;
  const phase = pollPhase(poll, nowIso);
  const final = phase === 'closed';
  const landOk = landShareComputable(meta);
  const D = landOk ? BigInt(meta.denominator as string) : null;
  const weightOf = new Map(entries.map((e) => [e.unitId, BigInt(e.weight)]));
  const votes = input.votes.filter((v) => v.pollId === poll.pollId && weightOf.has(v.unitId));

  const eligibleLand = BigInt(meta.totalWeight);
  let castUnits = 0n;
  let castLand = 0n;
  const optUnits = new Map<string, bigint>(poll.options.map((o) => [o.optionId, 0n]));
  const optLand = new Map<string, bigint>(poll.options.map((o) => [o.optionId, 0n]));
  for (const v of votes) {
    if (!optUnits.has(v.optionId)) continue;
    const w = weightOf.get(v.unitId) ?? 0n;
    castUnits += 1n;
    castLand += w;
    optUnits.set(v.optionId, (optUnits.get(v.optionId) ?? 0n) + 1n);
    optLand.set(v.optionId, (optLand.get(v.optionId) ?? 0n) + w);
  }

  const warnings: string[] = [];
  if (meta.missingLandShare > 0) warnings.push(`${meta.missingLandShare} bölümün arsa payı girilmemiş; arsa payı toplamları hesaplanamıyor`);
  const noVoter = entries.filter((e) => e.voters.length === 0).length;
  if (noVoter > 0) warnings.push(poll.audience === 'owners' ? `${noVoter} bölümde oy kullanabilecek malik kaydı yok` : `${noVoter} bölümde oy kullanabilecek kayıtlı kişi yok`);

  const tallyHidden = poll.secret && !final;
  const results: PollResults = {
    pollId: poll.pollId,
    phase,
    final,
    weighting: poll.weighting,
    rollDate: poll.rollDate,
    eligible: { units: meta.units, landShare: D === null ? null : fraction(eligibleLand, D) },
    participation: {
      units: Number(castUnits),
      unitsBps: toBps(castUnits, BigInt(meta.units)),
      landShare: D === null ? null : fraction(castLand, D),
      landShareBps: D === null ? null : toBps(castLand, eligibleLand),
    },
    tallyHidden,
    warnings,
  };
  if (tallyHidden) return results;

  const options: OptionTally[] = poll.options.map((o) => {
    const u = optUnits.get(o.optionId) ?? 0n;
    const l = optLand.get(o.optionId) ?? 0n;
    return {
      optionId: o.optionId,
      label: o.label,
      units: Number(u),
      unitsBps: toBps(u, castUnits),
      landShare: D === null ? null : fraction(l, D),
      landShareBps: D === null ? null : toBps(l, castLand),
    };
  });
  // Arsa payi agirlikli oylama yayinda tum bolumlerde arsa payi ister; yine de hesaplanamazsa kazanan yok.
  const basisOk = poll.weighting === 'per_unit' || landOk;
  const basis = (id: string) => (poll.weighting === 'per_unit' ? optUnits.get(id) : optLand.get(id)) ?? 0n;
  const castBasis = poll.weighting === 'per_unit' ? castUnits : castLand;
  const winner = basisOk && castBasis > 0n ? poll.options.find((o) => basis(o.optionId) * 2n > castBasis) : undefined;
  return { ...results, options, winnerOptionId: winner?.optionId ?? null };
}

/**
 * Bolum bazinda katilim (yonetici). Gizli oylamada secim, zaman ve oy verenin iliskisi hicbir
 * evrede verilmez; "oy kullandi mi" bilgisi de oylamanin PLANLANAN bitisine kadar gizlidir
 * (servis kontrol eder).
 */
export function participationRows(poll: Pick<Poll, 'pollId' | 'secret'>, entries: readonly RollEntry[], votes: readonly PollVote[]): PollUnitRow[] {
  const voteOf = new Map(votes.filter((v) => v.pollId === poll.pollId).map((v) => [v.unitId, v]));
  return entries.map((r) => {
    const v = voteOf.get(r.unitId);
    return {
      unitId: r.unitId,
      blockId: r.blockId,
      number: r.number,
      ...(r.landShare ? { landShare: r.landShare } : {}),
      voted: Boolean(v),
      ...(v && !poll.secret ? { optionId: v.optionId, castAt: v.castAt, voterRelation: v.voterRelation } : {}),
      // Hisseli bolumde temsilci secimi oylamada gerekmez: paydaslardan herhangi biri oy kullanir.
      warnings: r.warnings.filter((w) => w !== 'temsilci yok'),
    };
  });
}
