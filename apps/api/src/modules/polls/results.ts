/**
 * Y1 - Oylama evresi, oy hakki ve sonuc hesabi. SAF fonksiyonlar, I/O yok.
 *
 * Agirlik: `per_unit` her bagimsiz bolum 1 oy; `land_share` bolumun arsa payi. Arsa paylari
 * BigInt ile ortak paydaya (bolum paydalarinin EKOK'u) cevrilip toplanir; kayan nokta yoktur.
 * Kazanan: secilen agirliga gore KULLANILAN oylarin salt cogunlugu (yarisindan fazlasi).
 */
import type { IsoDate, IsoDateTime, LandShare } from '../core/types.js';
import { coversDay } from '../finance/occupancy.js';
import type { VotingRollItem } from '../ownership/register.js';
import type { UnitMembership } from '../portal/types.js';
import type { Fraction, OptionTally, Poll, PollPhase, PollResults, PollUnitRow, PollVote, VoterRelation } from './types.js';

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
 * Bolumun oy listesi gunundeki (`rollDate`) oy hakki sahipleri. Kat maliklerinde oy listesindeki
 * TUM paydaslar (hisseli mulkiyette herhangi biri bolumun tek oyunu kullanir); sakinlerde buna ek
 * olarak o gun gecerli tum uyelikler (kiraci dahil).
 */
export function eligibleVoters(
  poll: Pick<Poll, 'audience' | 'rollDate'>,
  roll: Pick<VotingRollItem, 'unitId' | 'owners'> | undefined,
  memberships: readonly UnitMembership[],
): Map<string, VoterRelation> {
  const out = new Map<string, VoterRelation>();
  if (!roll) return out;
  for (const o of roll.owners) out.set(o.userId, 'owner');
  if (poll.audience === 'residents') {
    for (const m of memberships) {
      if (m.unitId !== roll.unitId || !coversDay(m, poll.rollDate) || out.has(m.userId)) continue;
      out.set(m.userId, m.relation === 'owner' ? 'owner' : 'tenant');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agirlik aritmetigi (BigInt)
// ---------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

const validShare = (s: LandShare | undefined): s is LandShare =>
  !!s && Number.isSafeInteger(s.numerator) && Number.isSafeInteger(s.denominator) && s.numerator >= 0 && s.denominator > 0;

/** Tum arsa paylarinin ortak paydasi (EKOK); hic arsa payi yoksa `null`. */
export function commonDenominator(shares: readonly (LandShare | undefined)[]): bigint | null {
  let l: bigint | null = null;
  for (const s of shares) {
    if (!validShare(s)) continue;
    const d = BigInt(s.denominator);
    l = l === null ? d : (l / gcd(l, d)) * d;
  }
  return l;
}

/** Arsa payinin ortak paydadaki pay degeri (yoksa 0). */
export const scaledWeight = (s: LandShare | undefined, denominator: bigint | null): bigint =>
  validShare(s) && denominator !== null ? BigInt(s.numerator) * (denominator / BigInt(s.denominator)) : 0n;

/** Baz puan (10.000 = %100), yarim yukari yuvarlama. */
export function toBps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 20_000n + whole) / (2n * whole));
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (numerator > max || denominator > max) {
    // Uygulamada olusmaz (arsa paylari ortak paydali girilir); yine de sessiz tasma yerine acik hata.
    throw new Error('Arsa payi toplami guvenli tam sayi sinirini asiyor');
  }
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

// ---------------------------------------------------------------------------
// Sonuc
// ---------------------------------------------------------------------------

type RollRow = Pick<VotingRollItem, 'unitId' | 'blockId' | 'number' | 'landShare' | 'owners' | 'warnings'>;

/**
 * Oylama sonucu. `roll`: oy listesi gunundeki tum aktif bolumler (payda). `votes`: bolum basina
 * en fazla bir oy; listede olmayan bolumun (sonradan pasife alinmis) oyu sayilmaz.
 */
export function tallyPoll(input: { poll: Poll; roll: readonly RollRow[]; votes: readonly PollVote[]; nowIso: IsoDateTime }): PollResults {
  const { poll, roll, nowIso } = input;
  const phase = pollPhase(poll, nowIso);
  const final = phase === 'closed';
  const L = commonDenominator(roll.map((r) => r.landShare));
  const byUnit = new Map(roll.map((r) => [r.unitId, r]));
  const votes = input.votes.filter((v) => v.pollId === poll.pollId && byUnit.has(v.unitId));

  const eligibleLand = roll.reduce((s, r) => s + scaledWeight(r.landShare, L), 0n);
  let castUnits = 0n;
  let castLand = 0n;
  const optUnits = new Map<string, bigint>(poll.options.map((o) => [o.optionId, 0n]));
  const optLand = new Map<string, bigint>(poll.options.map((o) => [o.optionId, 0n]));
  for (const v of votes) {
    if (!optUnits.has(v.optionId)) continue;
    const w = scaledWeight(byUnit.get(v.unitId)?.landShare, L);
    castUnits += 1n;
    castLand += w;
    optUnits.set(v.optionId, (optUnits.get(v.optionId) ?? 0n) + 1n);
    optLand.set(v.optionId, (optLand.get(v.optionId) ?? 0n) + w);
  }

  const warnings: string[] = [];
  const missingLand = roll.filter((r) => !validShare(r.landShare)).length;
  if (missingLand > 0 && (poll.weighting === 'land_share' || L !== null)) {
    warnings.push(`${missingLand} bölümün arsa payı girilmemiş; arsa payı toplamlarına katılmadı`);
  }
  if (poll.audience === 'owners') {
    const noOwner = roll.filter((r) => r.owners.length === 0).length;
    if (noOwner > 0) warnings.push(`${noOwner} bölümde oy kullanabilecek malik kaydı yok`);
  }

  const tallyHidden = poll.secret && !final;
  const results: PollResults = {
    pollId: poll.pollId,
    phase,
    final,
    weighting: poll.weighting,
    rollDate: poll.rollDate,
    eligible: { units: roll.length, landShare: L === null ? null : fraction(eligibleLand, L) },
    participation: {
      units: Number(castUnits),
      unitsBps: toBps(castUnits, BigInt(roll.length)),
      landShare: L === null ? null : fraction(castLand, L),
      landShareBps: L === null ? null : toBps(castLand, eligibleLand),
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
      landShare: L === null ? null : fraction(l, L),
      landShareBps: L === null ? null : toBps(l, castLand),
    };
  });
  const basis = (id: string) => (poll.weighting === 'per_unit' ? optUnits.get(id) : optLand.get(id)) ?? 0n;
  const castBasis = poll.weighting === 'per_unit' ? castUnits : castLand;
  const winner = castBasis > 0n ? poll.options.find((o) => basis(o.optionId) * 2n > castBasis) : undefined;
  return { ...results, options, winnerOptionId: winner?.optionId ?? null };
}

/**
 * Bolum bazinda katilim (yonetici). Gizli oylamada YALNIZCA "oy kullandi mi" bilgisi verilir; secim,
 * zaman ve oy verenin iliskisi hicbir evrede gosterilmez.
 */
export function participationRows(poll: Pick<Poll, 'pollId' | 'secret'>, roll: readonly RollRow[], votes: readonly PollVote[]): PollUnitRow[] {
  const voteOf = new Map(votes.filter((v) => v.pollId === poll.pollId).map((v) => [v.unitId, v]));
  return roll.map((r) => {
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
