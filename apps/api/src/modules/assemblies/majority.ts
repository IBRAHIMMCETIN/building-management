/**
 * Genel kurul devami - gundem maddesi basina KARAR YETER SAYISI (KMK m.19, m.24, m.28, m.30, m.34,
 * m.41, m.42, m.44, m.45). SAF fonksiyonlar, I/O yok. Hukuki yorum notlari README'de ("Hukuki
 * yorum"); asagidaki kurallar oradaki yorumla aynidir ve AVUKAT TEYIDI bekler.
 *
 * Sayim olcutu kanunun ifadesinden:
 *  - "sayi (ve arsa payi) cogunlugu" (m.30/1 yeter sayi, m.34 yonetici, m.41 denetci, m.42 yenilik)
 *    ve m.19/2 "kat maliklerinin ... yazili rizasi": kat maliki KISI sayisi, toplanti yeter sayisiyla
 *    ayni kimlik kurali (`ownerOf`: tek malikte malik, hisseli bolum oy listesindeki temsilcisiyle,
 *    yoksa bolum olarak bir kez). Kisi basina ucte bir siniri kisi sayiminda anlamsizdir.
 *  - "oyu" (m.28 "besde dordunun oyu", toplu yapi m.70 "ucte ikisi" ozel secenegi, m.30 katilanlarin
 *    oy coklugu): m.31 oyu - bolum basina bir oy, kisinin oyu `floor(butun oylar / 3)` ile sinirli
 *    (kisi: tek malikte malik, hisseli bolumde katilimdaki temsilci; `voterOf`). Butun kat
 *    maliklerinin oyunda sinir paydada da uygulanir (`allVotes`), aksi halde bolumlerin ucte birinden
 *    fazlasina sahip malik varken herkes kabul etse bile besde dort saglanamazdi. Sinirin tabani
 *    (`totalVotes`) sinirsiz bolum sayisidir ve kuculmez.
 *  - oybirligi (m.24/2, m.42/4, m.44, m.45): oy listesindeki HER bolum katilmis ve kabul etmis olmali.
 *
 * Nitelikli cogunlugun paydasi katilanlar degil, dondurulmus oy listesindeki tum bolumler / kisiler /
 * toplam arsa payidir. Arsa payi sinirlanmaz (BigInt, ortak payda). Arsa payi gereken kuralda arsa
 * payi girilmemis bolum varsa karar HESAPLANAMAZ (`landShareMissing`; servis 422 doner, ret yazmaz).
 */
import { fraction, landShareComputable, toBps } from '../polls/results.js';
import type { RollEntry, RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';
import { ownerOf, voteCap, voterOf } from './quorum.js';

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

/** Arsa payi olcutu da aranan kurallar. */
export const LAND_RULES: readonly MajorityRule[] = ['persons_and_land', 'four_fifths_persons_and_land'];
/** Kat maliki KISI sayisiyla sayilan kurallar. */
export const PERSON_RULES: readonly MajorityRule[] = ['persons_and_land', 'four_fifths_persons', 'four_fifths_persons_and_land'];
/** Bolum bazinda oy girisi gereken kurallar (payda butun kat malikleri; kim kabul etti bilinmeli). */
export const QUALIFIED_RULES: readonly MajorityRule[] = MAJORITY_RULES.filter((r) => r !== 'attendees');
/** Hazir turde kullanilmayan, yalnizca "ozel" turde secilen kurallar. */
export const CUSTOM_ONLY_RULES: readonly MajorityRule[] = ['four_fifths_persons_and_land', 'two_thirds_votes'];

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

/** Hazir karar turleri ve kanundaki cogunluklari (`custom` disinda cogunluk degistirilemez). `hint`: ekranda uyari. */
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
  /** `counts`: yalnizca oy sayilari girildi; `units`: bolum bazinda oy (kisi ve arsa payi da hesaplanir). */
  mode: 'counts' | 'units';
  decision: 'accepted' | 'rejected';
  /** Oylar (m.31 kisi siniri uygulanmis). `notVoted`: katilip oy kullanmayanlar. */
  votes: ChoiceCounts;
  /** Kat maliki kisi sayilari (`ownerOf`; yalnizca bolum bazinda giris). `absent`: hic bolumu katilmayan. */
  persons: (ChoiceCounts & { absent: number; total: number }) | null;
  /** Bolum sayilari (sinirsiz; yalnizca bolum bazinda giris). `absent`: katilmayan bolum. */
  units: (ChoiceCounts & { absent: number }) | null;
  /** Kabul / ret / cekimser bolumlerin arsa payi (bolum bazinda giris ve tum bolumlerde arsa payi varsa). */
  landShare: { yes: Fraction; no: Fraction; abstain: Fraction } | null;
  landShareBps: { yes: number; no: number; abstain: number } | null;
  /** Katilanlarin sayilan oyu (sinirli). */
  presentVotes: number;
  /** Butun kat maliklerinin sayilan oyu (sinirli): "oyu" kurallarinin paydasi. */
  allVotes: number;
  /** Butun oylar (sinirsiz bolum sayisi; m.31 sinirinin tabani). */
  totalVotes: number;
  voteCap: number;
  totalLandShare: Fraction | null;
  landShareComputable: boolean;
  /** Kabul icin en az: oy veya kisi (kurala gore), gerekiyorsa arsa payi, oybirliginde bolum. */
  required: { votes: number | null; persons: number | null; landShare: Fraction | null; units: number | null };
  /** Ret nedenleri (kabulde bos). */
  reasons: string[];
  warnings: string[];
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const ceilFrac = (n: number, num: bigint, den: bigint) => Number(ceilDiv(BigInt(n) * num, den));

/** Kabul icin gereken en az oy / kisi (kurala gore), arsa payi (ortak paydada) ve bolum. */
export function requiredFor(rule: MajorityRule, c: { presentVotes: number; allVotes: number; totalPersons: number; totalLand: bigint; totalUnits: number }) {
  const none = { votes: null, persons: null, land: null, units: null } as { votes: number | null; persons: number | null; land: bigint | null; units: number | null };
  switch (rule) {
    case 'attendees':
      return { ...none, votes: Math.floor(c.presentVotes / 2) + 1 };
    case 'persons_and_land':
      return { ...none, persons: Math.floor(c.totalPersons / 2) + 1, land: c.totalLand / 2n + 1n };
    case 'four_fifths_persons':
      return { ...none, persons: ceilFrac(c.totalPersons, 4n, 5n) };
    case 'four_fifths_persons_and_land':
      return { ...none, persons: ceilFrac(c.totalPersons, 4n, 5n), land: ceilDiv(c.totalLand * 4n, 5n) };
    case 'four_fifths_votes':
      return { ...none, votes: ceilFrac(c.allVotes, 4n, 5n) };
    case 'two_thirds_votes':
      return { ...none, votes: ceilFrac(c.allVotes, 2n, 3n) };
    case 'unanimous':
      return { ...none, units: c.totalUnits };
  }
}

/** Arsa payi gereken kuralda arsa payi eksikse neden (karar hesaplanamaz); aksi halde null. */
export function landShareMissing(rule: MajorityRule, meta: Pick<RollMeta, 'denominator' | 'missingLandShare'>): string | null {
  if (!LAND_RULES.includes(rule) || landShareComputable(meta)) return null;
  return meta.missingLandShare > 0
    ? `${meta.missingLandShare} bölümün arsa payı girilmemiş; ${MAJORITY_LABELS[rule].toLocaleLowerCase('tr')} hesaplanamaz`
    : `Bölümlerde arsa payı girilmemiş; ${MAJORITY_LABELS[rule].toLocaleLowerCase('tr')} hesaplanamaz`;
}

/** Bolum kimlikleri: oy (`voterOf` katilanda, `ownerOf` katilmayanda) ve kisi (`ownerOf`, sabit). */
function identities(entries: readonly Entry[], attendance: readonly Att[]) {
  const attOf = new Map(attendance.map((a) => [a.unitId, a]));
  return entries.map((e) => {
    const a = attOf.get(e.unitId);
    const present = Boolean(a && a.mode !== 'absent');
    return { e, present, voter: present ? voterOf(e, a) : ownerOf(e), person: ownerOf(e) };
  });
}

/** Katilan bolumun oy kimligi (ekranda ayni kisinin bolumlerini birlikte oylamak icin). */
export function voterKeys(entries: readonly Entry[], attendance: readonly Att[]): Map<string, string> {
  return new Map(identities(entries, attendance).filter((x) => x.present).map((x) => [x.e.unitId, x.voter]));
}

/** Katilan bolumun kat maliki (kisi) kimligi: kisi sayimli kurallarda ayni kimlikli bolumler birlikte oylanir. */
export function personKeys(entries: readonly Entry[], attendance: readonly Att[]): Map<string, string> {
  return new Map(identities(entries, attendance).filter((x) => x.present).map((x) => [x.e.unitId, x.person]));
}

/**
 * Bolum bazinda oy girisinin dogrulamasi: yalnizca listede olan ve katilan bolumler; ayni kisinin
 * oyunu kullandigi bolumler ayni oyu alir (kisinin tek oyu vardir, m.31 siniri kisi basina). Kisi
 * sayimli kurallarda ayni kat malikine (kisi kimligi) dusen bolumler de ayni oyu alir. Sorun yoksa null.
 */
export function unitVotesIssue(entries: readonly Entry[], attendance: readonly Att[], votes: ReadonlyMap<string, VoteChoice>, rule: MajorityRule = 'attendees'): string | null {
  const ids = identities(entries, attendance);
  const byUnit = new Map(ids.map((x) => [x.e.unitId, x]));
  for (const unitId of votes.keys()) {
    const x = byUnit.get(unitId);
    if (!x) return `Bölüm (${unitId}) dondurulmuş oy listesinde yok`;
    if (!x.present) return `Bölüm (${unitId}) toplantıya katılmadı; oyu girilemez`;
  }
  const consistent = (key: 'voter' | 'person') => {
    const choiceOf = new Map<string, VoteChoice | undefined>();
    for (const x of ids) {
      if (!x.present) continue;
      const c = votes.get(x.e.unitId);
      if (choiceOf.has(x[key]) && choiceOf.get(x[key]) !== c) return false;
      choiceOf.set(x[key], c);
    }
    return true;
  };
  if (!consistent('voter')) return 'Aynı kişinin oyunu kullandığı bölümler aynı oyu almalıdır (kişinin tek oyu vardır; KMK m.31 sınırı kişi başına uygulanır)';
  if (PERSON_RULES.includes(rule) && !consistent('person')) {
    return 'Kişi sayımında aynı kat malikine düşen bölümler (birden fazla bölümü olan malik, hisseli bölüm temsilcisi) aynı oyu almalıdır';
  }
  return null;
}

function finish(input: {
  rule: MajorityRule;
  mode: DecisionOutcome['mode'];
  votes: ChoiceCounts;
  persons: DecisionOutcome['persons'];
  units: DecisionOutcome['units'];
  land: { yes: bigint; no: bigint; abstain: bigint } | null;
  presentVotes: number;
  allVotes: number;
  totalVotes: number;
  totalPersons: number;
  cap: number;
  cappedOwners: number;
  entries: readonly Entry[];
  meta: Meta;
}): DecisionOutcome {
  const { rule, votes, persons, presentVotes, allVotes, totalPersons } = input;
  const landOk = landShareComputable(input.meta);
  const D = landOk ? BigInt(input.meta.denominator as string) : null;
  const totalLand = BigInt(input.meta.totalWeight);
  const totalUnits = input.entries.length;
  const req = requiredFor(rule, { presentVotes, allVotes, totalPersons, totalLand, totalUnits });
  const reasons: string[] = [];
  const yesPersons = persons?.yes ?? 0;

  if (req.votes !== null && votes.yes < req.votes) {
    const base = rule === 'attendees' ? `katılanların oyunun (${presentVotes})` : `bütün kat maliklerinin oyunun (${allVotes})`;
    const part = rule === 'attendees' ? 'yarısından fazla değil' : rule === 'two_thirds_votes' ? `üçte ikisine (en az ${req.votes}) ulaşmadı` : `beşte dördüne (en az ${req.votes}) ulaşmadı`;
    reasons.push(`Kabul oyu (${votes.yes}) ${base} ${part}`);
  }
  if (req.persons !== null && yesPersons < req.persons) {
    const part = rule === 'persons_and_land' ? 'yarısından fazla değil' : `beşte dördüne (en az ${req.persons}) ulaşmadı`;
    reasons.push(persons ? `Kabul eden kat maliki (${yesPersons} kişi) bütün kat maliklerinin (${totalPersons} kişi) ${part}` : 'Kişi sayımı için bölüm bazında oy girilmelidir');
  }
  if (rule === 'unanimous') {
    const u = input.units;
    if (!u || u.yes !== totalUnits) {
      const parts = u ? [u.absent ? `${u.absent} bölüm katılmadı` : '', u.no + u.abstain + u.notVoted ? `${u.no + u.abstain + u.notVoted} bölüm kabul etmedi` : ''].filter(Boolean) : [];
      reasons.push(`Oybirliği için bütün bölümlerin (${totalUnits}) kabul oyu gerekir${parts.length ? `: ${parts.join(', ')}` : ''}`);
    }
  }
  if (req.land !== null || LAND_RULES.includes(rule)) {
    const missing = landShareMissing(rule, input.meta);
    if (missing) reasons.push(missing);
    else if (!input.land) reasons.push('Arsa payı ölçütü için bölüm bazında oy girilmelidir');
    else if (req.land !== null && input.land.yes < req.land) {
      reasons.push(rule === 'persons_and_land' ? 'Kabul eden bölümlerin arsa payı toplam arsa payının yarısından fazla değil' : 'Kabul eden bölümlerin arsa payı toplam arsa payının beşte dördüne ulaşmadı');
    }
  }

  const warnings: string[] = [];
  if (input.cappedOwners > 0 && !PERSON_RULES.includes(rule)) warnings.push(`KMK m.31: ${input.cappedOwners} kişinin oyu bütün oyların üçte biriyle (en fazla ${input.cap} oy) sınırlandı`);
  const land = input.land && D !== null ? input.land : null;
  return {
    rule,
    mode: input.mode,
    decision: reasons.length === 0 ? 'accepted' : 'rejected',
    votes,
    persons,
    units: input.units,
    landShare: land && D !== null ? { yes: fraction(land.yes, D), no: fraction(land.no, D), abstain: fraction(land.abstain, D) } : null,
    landShareBps: land ? { yes: toBps(land.yes, totalLand), no: toBps(land.no, totalLand), abstain: toBps(land.abstain, totalLand) } : null,
    presentVotes,
    allVotes,
    totalVotes: input.totalVotes,
    voteCap: input.cap,
    totalLandShare: D === null ? null : fraction(totalLand, D),
    landShareComputable: landOk,
    required: { votes: req.votes, persons: req.persons, landShare: req.land !== null && D !== null ? fraction(req.land, D) : null, units: req.units },
    reasons,
    warnings,
  };
}

/** Butun kat maliklerinin sinirli oyu, katilanlarin sinirli oyu ve kat maliki (kisi) sayisi. */
function tallyBase(entries: readonly Entry[], attendance: readonly Att[]) {
  const totalVotes = entries.length;
  const cap = voteCap(totalVotes);
  const all = new Map<string, number>();
  const present = new Map<string, number>();
  const persons = new Set<string>();
  for (const x of identities(entries, attendance)) {
    all.set(x.voter, (all.get(x.voter) ?? 0) + 1);
    if (x.present) present.set(x.voter, (present.get(x.voter) ?? 0) + 1);
    persons.add(x.person);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + Math.min(n, cap), 0);
  const cappedOwners = [...present.values()].filter((n) => n > cap).length;
  return { totalVotes, cap, allVotes: sum(all), presentVotes: sum(present), present, cappedOwners, totalPersons: persons.size };
}

/**
 * Bolum bazinda oydan karar: `votes` katilan bolumlerin secimi (girilmeyen katilan bolum "oy
 * kullanmadi"). Once `unitVotesIssue` ile (ayni kuralla) dogrulanmis olmali.
 */
export function decideByUnits(input: { rule: MajorityRule; entries: readonly Entry[]; meta: Meta; attendance: readonly Att[]; votes: ReadonlyMap<string, VoteChoice> }): DecisionOutcome {
  const { entries, attendance, votes } = input;
  const c = tallyBase(entries, attendance);
  const ids = identities(entries, attendance);
  const voterChoice = new Map<string, VoteChoice | undefined>();
  const personChoice = new Map<string, VoteChoice | 'notVoted' | 'absent'>();
  const units = { yes: 0, no: 0, abstain: 0, notVoted: 0, absent: 0 };
  const land = { yes: 0n, no: 0n, abstain: 0n };
  const rank = { absent: 0, notVoted: 1, yes: 2, no: 2, abstain: 2 } as const;
  for (const x of ids) {
    const choice = x.present ? votes.get(x.e.unitId) : undefined;
    const p: VoteChoice | 'notVoted' | 'absent' = !x.present ? 'absent' : (choice ?? 'notVoted');
    const prev = personChoice.get(x.person);
    if (!prev || rank[p] > rank[prev]) personChoice.set(x.person, p);
    if (!x.present) {
      units.absent += 1;
      continue;
    }
    voterChoice.set(x.voter, choice);
    if (!choice) {
      units.notVoted += 1;
      continue;
    }
    units[choice] += 1;
    land[choice] += BigInt(x.e.weight);
  }
  const v: ChoiceCounts = { yes: 0, no: 0, abstain: 0, notVoted: 0 };
  for (const [id, n] of c.present) v[voterChoice.get(id) ?? 'notVoted'] += Math.min(n, c.cap);
  const persons = { yes: 0, no: 0, abstain: 0, notVoted: 0, absent: 0, total: c.totalPersons };
  for (const p of personChoice.values()) persons[p] += 1;
  return finish({ ...input, mode: 'units', votes: v, persons, units, land, presentVotes: c.presentVotes, allVotes: c.allVotes, totalVotes: c.totalVotes, totalPersons: c.totalPersons, cap: c.cap, cappedOwners: c.cappedOwners });
}

/** Yalnizca oy sayilari (sinirli) girilen sayim: yalnizca `attendees` kuralinda. */
export function decideByCounts(input: { entries: readonly Entry[]; meta: Meta; attendance: readonly Att[]; yes: number; no: number; abstain: number }): DecisionOutcome {
  const c = tallyBase(input.entries, input.attendance);
  const votes: ChoiceCounts = { yes: input.yes, no: input.no, abstain: input.abstain, notVoted: Math.max(0, c.presentVotes - input.yes - input.no - input.abstain) };
  return finish({ ...input, rule: 'attendees', mode: 'counts', votes, persons: null, units: null, land: null, presentVotes: c.presentVotes, allVotes: c.allVotes, totalVotes: c.totalVotes, totalPersons: c.totalPersons, cap: c.cap, cappedOwners: c.cappedOwners });
}

/** Karar turunden cogunluk: hazir turde kanundaki, `custom`'da secilen. */
export const ruleOfKind = (kind: DecisionKind, custom?: MajorityRule): MajorityRule | undefined => (kind === 'custom' ? custom : DECISION_PRESETS[kind].rule);
