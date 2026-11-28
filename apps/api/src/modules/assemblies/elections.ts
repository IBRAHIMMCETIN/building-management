/**
 * Genel kurul devami - cok adayli secim (yonetici KMK m.34, denetci KMK m.41). SAF fonksiyonlar.
 *
 *  - Her oy veren tek aday secer veya cekimser kalir; oy kimligi ve kisi kimligi majority.ts ile
 *    aynidir (ayni kisinin oyunu kullandigi bolumler, kisi sayiminda ayni malike dusen bolumler ayni
 *    pusulayi alir).
 *  - Aday basina majority.ts `decideByUnits` ile AYNI kurallar: o adayi secen bolumler "kabul",
 *    baska adayi secenler "ret", cekimserler "cekimser". Aday, maddenin kanuni cogunluguna (m.34 / m.41:
 *    butun kat maliklerinin kisi sayisi VE arsa payi cogunlugu) ulasirsa secilir. Kisi basina tek
 *    pusula oldugundan en fazla bir aday ulasabilir.
 *  - Hicbir aday ulasamazsa "secim yapilamadi": kanunda nispi cogunlukla (en cok oy alan) secim yolu
 *    yoktur. Yonetici icin kat malikleri yonetici atayamazsa sulh mahkemesine basvuru yolu acik
 *    kalir (m.34); denetci secimi zorunlu degildir (m.41 "verebilir"). README "Hukuki yorum".
 */
import type { RollEntry, RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';
import { type DecisionKind, type DecisionOutcome, type MajorityRule, type VoteChoice, decideByUnits, unitVotesIssue } from './majority.js';
import type { ElectionCandidate } from './types.js';

/** Aday girilebilen karar turleri. */
export const ELECTION_KINDS: readonly DecisionKind[] = ['manager_election', 'auditor_election'];
export const ABSTAIN = 'abstain';

export type CandidateResult = {
  candidateId: string;
  name: string;
  userId?: string;
  /** Adayi secen oy (KMK m.31 kisi siniri uygulanmis). */
  votes: number;
  /** Adayi secen kat maliki (kisi). */
  persons: number;
  units: number;
  landShare: Fraction | null;
  landShareBps: number | null;
  elected: boolean;
  reasons: string[];
};

type Counts = { votes: number; persons: number; units: number };

export type ElectionResult = {
  rule: MajorityRule;
  candidates: CandidateResult[];
  /** Secilen aday; `null`: secim yapilamadi. */
  winnerCandidateId: string | null;
  abstain: Counts;
  notVoted: Counts;
  absent: { persons: number; units: number };
  required: { persons: number | null; landShare: Fraction | null };
  totalPersons: number;
  totalLandShare: Fraction | null;
  /** Secim yapilamadi aciklamasi. */
  noWinner?: string;
  warnings: string[];
};

type Entry = Pick<RollEntry, 'unitId' | 'owners' | 'weight' | 'representativeUserId'>;
type Att = { unitId: string; mode: 'present' | 'proxy' | 'absent'; attendee?: { userId: string } };
type Meta = Pick<RollMeta, 'denominator' | 'missingLandShare' | 'totalWeight'>;

export const isElectionKind = (k: DecisionKind | undefined) => Boolean(k && ELECTION_KINDS.includes(k));

export const noWinnerText = (kind: DecisionKind | undefined) =>
  kind === 'manager_election'
    ? 'Seçim yapılamadı: hiçbir aday bütün kat maliklerinin sayı ve arsa payı çoğunluğuna ulaşmadı (KMK m.34). Kanunda en çok oy alanın seçilmesi yolu yoktur; yeniden oylama yapılabilir veya kat maliklerinden biri sulh mahkemesinden yönetici atanmasını isteyebilir.'
    : 'Seçim yapılamadı: hiçbir aday bütün kat maliklerinin sayı ve arsa payı çoğunluğuna ulaşmadı (KMK m.41). Kanunda en çok oy alanın seçilmesi yolu yoktur.';

/** Pusula dogrulamasi: aday kimligi veya `abstain`; oy / kisi kimligi tutarliligi majority.ts ile ayni. */
export function ballotsIssue(input: { rule: MajorityRule; entries: readonly Entry[]; attendance: readonly Att[]; ballots: ReadonlyMap<string, string>; candidates: readonly ElectionCandidate[] }): string | null {
  const ids = new Set(input.candidates.map((c) => c.candidateId));
  for (const v of input.ballots.values()) {
    if (v !== ABSTAIN && !ids.has(v)) return 'Oy pusulası bu maddenin adaylarından biri veya çekimser (abstain) olmalıdır';
  }
  const issue = unitVotesIssue(input.entries, input.attendance, input.ballots, input.rule);
  return issue ? issue.replace('aynı oyu', 'aynı adayı') : null;
}

/**
 * Secim sonucu. `outcome`: secilen adayin karar sonucu (kabul); secilen yoksa en cok kisi / oy /
 * arsa payi alan adayin sonucu "ret" olarak, gerekce "secim yapilamadi".
 */
export function decideElection(input: {
  kind: DecisionKind;
  rule: MajorityRule;
  entries: readonly Entry[];
  meta: Meta;
  attendance: readonly Att[];
  ballots: ReadonlyMap<string, string>;
  candidates: readonly ElectionCandidate[];
}): { outcome: DecisionOutcome; election: ElectionResult } {
  const per = input.candidates.map((c) => {
    const votes = new Map<string, VoteChoice>();
    for (const [unitId, b] of input.ballots) votes.set(unitId, b === c.candidateId ? 'yes' : b === ABSTAIN ? 'abstain' : 'no');
    return { c, o: decideByUnits({ rule: input.rule, entries: input.entries, meta: input.meta, attendance: input.attendance, votes }) };
  });
  const results: CandidateResult[] = per.map(({ c, o }) => ({
    candidateId: c.candidateId,
    name: c.name,
    ...(c.userId ? { userId: c.userId } : {}),
    votes: o.votes.yes,
    persons: o.persons?.yes ?? 0,
    units: o.units?.yes ?? 0,
    landShare: o.landShare?.yes ?? null,
    landShareBps: o.landShareBps?.yes ?? null,
    elected: o.decision === 'accepted',
    reasons: o.reasons,
  }));
  const winners = per.filter((x) => x.o.decision === 'accepted');
  // Kisi basina tek pusula: iki aday birden kisi cogunluguna ulasamaz. Savunma: birden fazlaysa kimse secilmez.
  const winner = winners.length === 1 ? winners[0] : undefined;
  const rank = [...per].sort(
    (x, y) =>
      (y.o.persons?.yes ?? 0) - (x.o.persons?.yes ?? 0) || y.o.votes.yes - x.o.votes.yes || (y.o.landShareBps?.yes ?? 0) - (x.o.landShareBps?.yes ?? 0),
  );
  const base = (winner ?? rank[0]) as (typeof per)[number];
  const ref = base.o;
  const warnings = [...ref.warnings];
  if (input.kind === 'auditor_election') {
    const owners = new Set(input.entries.flatMap((e) => e.owners.map((o) => o.userId)));
    const outside = input.candidates.filter((c) => !c.userId || !owners.has(c.userId));
    if (outside.length) warnings.push(`KMK m.41: denetçi kat malikleri arasından seçilir; ${outside.map((c) => c.name).join(', ')} oy listesinde kat maliki olarak eşleşmedi.`);
  }
  const noWinner = winner ? undefined : noWinnerText(input.kind);
  const election: ElectionResult = {
    rule: input.rule,
    candidates: results,
    winnerCandidateId: winner ? winner.c.candidateId : null,
    abstain: { votes: ref.votes.abstain, persons: ref.persons?.abstain ?? 0, units: ref.units?.abstain ?? 0 },
    notVoted: { votes: ref.votes.notVoted, persons: ref.persons?.notVoted ?? 0, units: ref.units?.notVoted ?? 0 },
    absent: { persons: ref.persons?.absent ?? 0, units: ref.units?.absent ?? 0 },
    required: { persons: ref.required.persons, landShare: ref.required.landShare },
    totalPersons: ref.persons?.total ?? 0,
    totalLandShare: ref.totalLandShare,
    ...(noWinner ? { noWinner } : {}),
    warnings,
  };
  const outcome: DecisionOutcome = winner ? { ...ref, warnings } : { ...ref, decision: 'rejected', reasons: [noWinner as string, ...ref.reasons.map((r) => `${base.c.name}: ${r}`)], warnings };
  return { outcome, election };
}
