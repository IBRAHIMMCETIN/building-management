/**
 * Genel kurul devami - gundem maddesi basina KARAR YETER SAYISI (KMK m.19, m.24, m.28, m.30, m.34,
 * m.42, m.44, m.45). SAF fonksiyonlar, I/O yok. Hukuki yorum notlari README'de ("Hukuki yorum");
 * asagidaki kurallar oradaki yorumla aynidir ve AVUKAT TEYIDI bekler.
 *
 *  - `attendees`  : katilanlarin oy cogunlugu (m.30; mevcut davranis). Payda katilanlarin m.31 kisi
 *                   sinirli oyu.
 *  - `owners_and_land`: BUTUN kat maliklerinin sayi VE arsa payi cogunlugu (m.34 yonetici, m.42
 *                   faydali yenilik). Payda katilanlar degil, dondurulmus oy listesindeki tum bolumler.
 *  - `four_fifths_owners`: butun kat maliklerinin besde dordu, sayica (m.19/2, m.28).
 *  - `four_fifths_owners_and_land`: sayi VE arsa payi bakimindan besde dort (kanunda dogrudan
 *                   aranmaz; yonetim planinin daha agir cogunluk ongordugu kararlar icin, yalnizca
 *                   "ozel" karar turunde).
 *  - `unanimous`  : butun kat maliklerinin oybirligi (m.24, m.42/3, m.44, m.45): oy listesindeki
 *                   HER bolum katilmis ve kabul oyu vermis olmali; katilmayan bolum oybirligini bozar.
 *
 * Sayi olcutu m.31 oyudur: her bagimsiz bolum bir oy, bir kisinin oyu `floor(butun oylar / 3)` ile
 * sinirli (kisi: tek malikte malik, hisseli bolumde temsilci; `voterOf` / `ownerOf`). Nitelikli
 * cogunlugun paydasi "butun kat maliklerinin oyu"dur: tum bolumlerin ayni kisi siniriyla sayilan
 * oyu (`allVotes`). Payda da sinirlanir; aksi halde bolumlerin ucte birinden fazlasina sahip bir
 * malik oldugunda herkes kabul etse bile besde dort / oybirligi hic saglanamazdi. Sinirin tabani
 * (`totalVotes`) sinirsiz bolum sayisidir ve kuculmez. Arsa payi sinirlanmaz (BigInt, ortak payda).
 * Arsa payi gereken kurallarda arsa payi girilmemis bolum varsa olcut hesaplanamaz: karar alinmis
 * SAYILMAZ.
 */
import { fraction, landShareComputable, toBps } from '../polls/results.js';
import type { RollEntry, RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';
import { ownerOf, voteCap, voterOf } from './quorum.js';

export const MAJORITY_RULES = ['attendees', 'owners_and_land', 'four_fifths_owners', 'four_fifths_owners_and_land', 'unanimous'] as const;
export type MajorityRule = (typeof MAJORITY_RULES)[number];

/** Arsa payi olcutu da aranan kurallar. */
export const LAND_RULES: readonly MajorityRule[] = ['owners_and_land', 'four_fifths_owners_and_land'];
/** Bolum bazinda oy girisi gereken kurallar (payda butun kat malikleri; arsa payi icin hangi bolumun kabul ettigi bilinmeli). */
export const QUALIFIED_RULES: readonly MajorityRule[] = ['owners_and_land', 'four_fifths_owners', 'four_fifths_owners_and_land', 'unanimous'];

export const MAJORITY_LABELS: Record<MajorityRule, string> = {
  attendees: 'Katılanların oy çokluğu',
  owners_and_land: 'Bütün kat maliklerinin sayı ve arsa payı çoğunluğu',
  four_fifths_owners: 'Bütün kat maliklerinin beşte dördü (sayıca)',
  four_fifths_owners_and_land: 'Bütün kat maliklerinin sayı ve arsa payı bakımından beşte dördü',
  unanimous: 'Bütün kat maliklerinin oybirliği',
};

export const DECISION_KINDS = [
  'general',
  'operating_budget',
  'manager_election',
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

/** Hazir karar turleri ve kanundaki cogunluklari (`custom` disinda cogunluk degistirilemez). */
export const DECISION_PRESETS: Record<Exclude<DecisionKind, 'custom'>, { rule: MajorityRule; label: string; legal: string }> = {
  general: { rule: 'attendees', label: 'Genel karar', legal: 'KMK m.30' },
  operating_budget: { rule: 'attendees', label: 'İşletme projesi', legal: 'KMK m.37, m.30' },
  manager_election: { rule: 'owners_and_land', label: 'Yönetici seçimi', legal: 'KMK m.34' },
  beneficial_improvement: { rule: 'owners_and_land', label: 'Ortak yerlerde faydalı yenilik / ilave, ısı yalıtımı, yakıt veya ısıtma sistemi değişikliği', legal: 'KMK m.42' },
  common_area_change: { rule: 'four_fifths_owners', label: 'Ortak yerlerde inşaat, onarım, tesis veya dış cephede farklı renk boya', legal: 'KMK m.19/2' },
  management_plan_change: { rule: 'four_fifths_owners', label: 'Yönetim planı değişikliği', legal: 'KMK m.28' },
  use_change: { rule: 'unanimous', label: 'Konut bölümünün işyeri vb. olarak kullanılması (kullanım amacı değişikliği)', legal: 'KMK m.24' },
  central_heating_conversion: { rule: 'unanimous', label: '2.000 m² ve üzeri binada merkezi ısıtmadan bireysel ısıtmaya geçiş', legal: 'KMK m.42/3' },
  major_disposition: { rule: 'unanimous', label: 'Ana gayrimenkulün hakla kayıtlanması, arsanın bölünmesi, çatı / dış duvar reklam kirası', legal: 'KMK m.45' },
  additional_floor: { rule: 'unanimous', label: 'Kat veya bağımsız bölüm ilavesi', legal: 'KMK m.44' },
};

export const CUSTOM_KIND_LABEL = 'Özel (yönetim planı / diğer)';

export const kindLabel = (k: DecisionKind) => (k === 'custom' ? CUSTOM_KIND_LABEL : DECISION_PRESETS[k].label);

export const VOTE_CHOICES = ['yes', 'no', 'abstain'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

type Entry = Pick<RollEntry, 'unitId' | 'owners' | 'weight' | 'representativeUserId'>;
type Att = { unitId: string; mode: 'present' | 'proxy' | 'absent'; attendee?: { userId: string } };
type Meta = Pick<RollMeta, 'denominator' | 'missingLandShare' | 'totalWeight'>;

export type ChoiceCounts = { yes: number; no: number; abstain: number; notVoted: number };

export type DecisionOutcome = {
  rule: MajorityRule;
  /** `counts`: yalnizca oy sayilari girildi; `units`: bolum bazinda oy (arsa payi da hesaplanir). */
  mode: 'counts' | 'units';
  decision: 'accepted' | 'rejected';
  /** Oylar (m.31 kisi siniri uygulanmis). `notVoted`: katilip oy kullanmayanlar. */
  votes: ChoiceCounts;
  /** Bolum sayilari (sinirsiz; yalnizca bolum bazinda giriste). `absent`: katilmayan bolum. */
  units: (ChoiceCounts & { absent: number }) | null;
  /** Kabul / ret / cekimser bolumlerin arsa payi (bolum bazinda giris ve tum bolumlerde arsa payi varsa). */
  landShare: { yes: Fraction; no: Fraction; abstain: Fraction } | null;
  landShareBps: { yes: number; no: number; abstain: number } | null;
  /** Katilanlarin sayilan oyu (sinirli). */
  presentVotes: number;
  /** Butun kat maliklerinin sayilan oyu (sinirli): nitelikli cogunlugun paydasi. */
  allVotes: number;
  /** Butun oylar (sinirsiz bolum sayisi; m.31 sinirinin tabani). */
  totalVotes: number;
  voteCap: number;
  totalLandShare: Fraction | null;
  landShareComputable: boolean;
  /** Kabul icin en az: oy, (gerekiyorsa) arsa payi, (oybirliginde) bolum. */
  required: { votes: number; landShare: Fraction | null; units: number | null };
  /** Ret nedenleri (kabulde bos). */
  reasons: string[];
  warnings: string[];
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Kabul icin gereken en az oy (sinirli), arsa payi (ortak paydada) ve bolum. */
export function requiredFor(rule: MajorityRule, presentVotes: number, allVotes: number, totalLand: bigint, totalUnits: number) {
  switch (rule) {
    case 'attendees':
      return { votes: Math.floor(presentVotes / 2) + 1, land: null, units: null };
    case 'owners_and_land':
      return { votes: Math.floor(allVotes / 2) + 1, land: totalLand / 2n + 1n, units: null };
    case 'four_fifths_owners':
      return { votes: Number(ceilDiv(BigInt(allVotes) * 4n, 5n)), land: null, units: null };
    case 'four_fifths_owners_and_land':
      return { votes: Number(ceilDiv(BigInt(allVotes) * 4n, 5n)), land: ceilDiv(totalLand * 4n, 5n), units: null };
    case 'unanimous':
      return { votes: allVotes, land: null, units: totalUnits };
  }
}

/** Bolum kimligi: katilan bolumde oyu kullanan kisi (`voterOf`), katilmayanda oy listesindeki malik (`ownerOf`). */
function identities(entries: readonly Entry[], attendance: readonly Att[]) {
  const attOf = new Map(attendance.map((a) => [a.unitId, a]));
  return entries.map((e) => {
    const a = attOf.get(e.unitId);
    const present = Boolean(a && a.mode !== 'absent');
    return { e, present, id: present ? voterOf(e, a) : ownerOf(e) };
  });
}

/** Katilan bolumun oy kimligi (ekranda ayni kisinin bolumlerini birlikte oylamak icin). */
export function voterKeys(entries: readonly Entry[], attendance: readonly Att[]): Map<string, string> {
  return new Map(identities(entries, attendance).filter((x) => x.present).map((x) => [x.e.unitId, x.id]));
}

/**
 * Bolum bazinda oy girisinin dogrulamasi: yalnizca listede olan ve katilan bolumler; ayni kisinin
 * oyunu kullandigi bolumler ayni oyu alir (kisinin oyu tek, m.31 siniri kisi basina). Sorun yoksa null.
 */
export function unitVotesIssue(entries: readonly Entry[], attendance: readonly Att[], votes: ReadonlyMap<string, VoteChoice>): string | null {
  const ids = identities(entries, attendance);
  const byUnit = new Map(ids.map((x) => [x.e.unitId, x]));
  for (const unitId of votes.keys()) {
    const x = byUnit.get(unitId);
    if (!x) return `Bölüm (${unitId}) dondurulmuş oy listesinde yok`;
    if (!x.present) return `Bölüm (${unitId}) toplantıya katılmadı; oyu girilemez`;
  }
  const choiceOf = new Map<string, VoteChoice | undefined>();
  for (const x of ids) {
    if (!x.present) continue;
    const c = votes.get(x.e.unitId);
    if (choiceOf.has(x.id) && choiceOf.get(x.id) !== c) {
      return 'Aynı kişinin oyunu kullandığı bölümler aynı oyu almalıdır (kişinin tek oyu vardır; KMK m.31 sınırı kişi başına uygulanır)';
    }
    choiceOf.set(x.id, c);
  }
  return null;
}

function landAndUnits(entries: readonly Entry[], meta: Meta) {
  const landOk = landShareComputable(meta);
  const D = landOk ? BigInt(meta.denominator as string) : null;
  const totalLand = BigInt(meta.totalWeight);
  return { landOk, D, totalLand, totalUnits: entries.length };
}

function finish(input: {
  rule: MajorityRule;
  mode: DecisionOutcome['mode'];
  votes: ChoiceCounts;
  units: DecisionOutcome['units'];
  land: { yes: bigint; no: bigint; abstain: bigint } | null;
  presentVotes: number;
  allVotes: number;
  totalVotes: number;
  cap: number;
  cappedOwners: number;
  entries: readonly Entry[];
  meta: Meta;
}): DecisionOutcome {
  const { rule, votes, presentVotes, allVotes } = input;
  const { landOk, D, totalLand, totalUnits } = landAndUnits(input.entries, input.meta);
  const req = requiredFor(rule, presentVotes, allVotes, totalLand, totalUnits);
  const reasons: string[] = [];
  const yes = votes.yes;
  const needsLand = LAND_RULES.includes(rule);
  const yesLand = input.land?.yes ?? 0n;

  switch (rule) {
    case 'attendees':
      if (!(yes * 2 > presentVotes)) reasons.push(`Kabul oyu (${yes}) katılanların oyunun (${presentVotes}) yarısından fazla değil`);
      break;
    case 'owners_and_land':
      if (!(yes * 2 > allVotes)) reasons.push(`Kabul oyu (${yes}) bütün kat maliklerinin oyunun (${allVotes}) yarısından fazla değil`);
      break;
    case 'four_fifths_owners':
    case 'four_fifths_owners_and_land':
      if (!(yes * 5 >= allVotes * 4)) reasons.push(`Kabul oyu (${yes}) bütün kat maliklerinin oyunun (${allVotes}) beşte dördüne (en az ${req.votes}) ulaşmadı`);
      break;
    case 'unanimous': {
      const u = input.units;
      if (!u || u.yes !== totalUnits) {
        const parts = u ? [u.absent ? `${u.absent} bölüm katılmadı` : '', u.no + u.abstain + u.notVoted ? `${u.no + u.abstain + u.notVoted} bölüm kabul etmedi` : ''].filter(Boolean) : [];
        reasons.push(`Oybirliği için bütün bölümlerin (${totalUnits}) kabul oyu gerekir${parts.length ? `: ${parts.join(', ')}` : ''}`);
      }
      break;
    }
  }
  if (needsLand) {
    if (!landOk) {
      reasons.push(
        input.meta.missingLandShare > 0
          ? `${input.meta.missingLandShare} bölümün arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, karar alınmış sayılmaz`
          : 'Bölümlerde arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, karar alınmış sayılmaz',
      );
    } else if (!input.land) {
      reasons.push('Arsa payı ölçütü için bölüm bazında oy girilmelidir');
    } else if (rule === 'owners_and_land' ? !(yesLand * 2n > totalLand) : !(yesLand * 5n >= totalLand * 4n)) {
      reasons.push(rule === 'owners_and_land' ? 'Kabul eden bölümlerin arsa payı toplam arsa payının yarısından fazla değil' : 'Kabul eden bölümlerin arsa payı toplam arsa payının beşte dördüne ulaşmadı');
    }
  }

  const warnings: string[] = [];
  if (input.cappedOwners > 0) warnings.push(`KMK m.31: ${input.cappedOwners} kişinin oyu bütün oyların üçte biriyle (en fazla ${input.cap} oy) sınırlandı`);
  const land = input.land && D !== null ? input.land : null;
  return {
    rule,
    mode: input.mode,
    decision: reasons.length === 0 ? 'accepted' : 'rejected',
    votes,
    units: input.units,
    landShare: land && D !== null ? { yes: fraction(land.yes, D), no: fraction(land.no, D), abstain: fraction(land.abstain, D) } : null,
    landShareBps: land ? { yes: toBps(land.yes, totalLand), no: toBps(land.no, totalLand), abstain: toBps(land.abstain, totalLand) } : null,
    presentVotes,
    allVotes,
    totalVotes: input.totalVotes,
    voteCap: input.cap,
    totalLandShare: D === null ? null : fraction(totalLand, D),
    landShareComputable: landOk,
    required: { votes: req.votes, landShare: req.land !== null && D !== null ? fraction(req.land, D) : null, units: req.units },
    reasons,
    warnings,
  };
}

/** Butun kat maliklerinin sinirli oyu ve katilanlarin sinirli oyu (ayni kimliklerle). */
function capped(entries: readonly Entry[], attendance: readonly Att[]) {
  const totalVotes = entries.length;
  const cap = voteCap(totalVotes);
  const all = new Map<string, number>();
  const present = new Map<string, number>();
  for (const x of identities(entries, attendance)) {
    all.set(x.id, (all.get(x.id) ?? 0) + 1);
    if (x.present) present.set(x.id, (present.get(x.id) ?? 0) + 1);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + Math.min(n, cap), 0);
  const cappedOwners = [...present.values()].filter((n) => n > cap).length;
  return { totalVotes, cap, allVotes: sum(all), presentVotes: sum(present), present, cappedOwners };
}

/**
 * Bolum bazinda oydan karar: `votes` katilan bolumlerin secimi (girilmeyen katilan bolum "oy
 * kullanmadi"). Once `unitVotesIssue` ile dogrulanmis olmali.
 */
export function decideByUnits(input: { rule: MajorityRule; entries: readonly Entry[]; meta: Meta; attendance: readonly Att[]; votes: ReadonlyMap<string, VoteChoice> }): DecisionOutcome {
  const { entries, attendance, votes } = input;
  const c = capped(entries, attendance);
  const ids = identities(entries, attendance);
  const choiceOfId = new Map<string, VoteChoice | undefined>();
  const units = { yes: 0, no: 0, abstain: 0, notVoted: 0, absent: 0 };
  const land = { yes: 0n, no: 0n, abstain: 0n };
  for (const x of ids) {
    if (!x.present) {
      units.absent += 1;
      continue;
    }
    const choice = votes.get(x.e.unitId);
    choiceOfId.set(x.id, choice);
    if (!choice) {
      units.notVoted += 1;
      continue;
    }
    units[choice] += 1;
    land[choice] += BigInt(x.e.weight);
  }
  const v: ChoiceCounts = { yes: 0, no: 0, abstain: 0, notVoted: 0 };
  for (const [id, n] of c.present) {
    const choice = choiceOfId.get(id);
    v[choice ?? 'notVoted'] += Math.min(n, c.cap);
  }
  return finish({ ...input, mode: 'units', votes: v, units, land, presentVotes: c.presentVotes, allVotes: c.allVotes, totalVotes: c.totalVotes, cap: c.cap, cappedOwners: c.cappedOwners });
}

/** Yalnizca oy sayilari (sinirli) girilen sayim: yalnizca `attendees` kuralinda. */
export function decideByCounts(input: { entries: readonly Entry[]; meta: Meta; attendance: readonly Att[]; yes: number; no: number; abstain: number }): DecisionOutcome {
  const c = capped(input.entries, input.attendance);
  const votes: ChoiceCounts = { yes: input.yes, no: input.no, abstain: input.abstain, notVoted: Math.max(0, c.presentVotes - input.yes - input.no - input.abstain) };
  return finish({ ...input, rule: 'attendees', mode: 'counts', votes, units: null, land: null, presentVotes: c.presentVotes, allVotes: c.allVotes, totalVotes: c.totalVotes, cap: c.cap, cappedOwners: c.cappedOwners });
}

/** Karar turunden cogunluk: hazir turde kanundaki, `custom`'da secilen. */
export const ruleOfKind = (kind: DecisionKind, custom?: MajorityRule): MajorityRule | undefined => (kind === 'custom' ? custom : DECISION_PRESETS[kind].rule);
