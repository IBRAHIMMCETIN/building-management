/**
 * Y1-3 - Kat malikleri kurulu yeter sayilari ve oy sinirlari (KMK m.30, m.31). SAF fonksiyonlar.
 *
 * Oy sayimi (m.31): her kat malikinin her bagimsiz bolumu icin bir oyu vardir; birden fazla bolumu
 * olan malikin oyu toplam oylarin ucte birini (kesirler dikkate alinmadan) asamaz. Hisseli bolumu
 * paydaslarin sectigi tek kisi temsil eder: bolum tek oydur. Uygulama: malik grubu (tek malikte
 * malik, hisselide ayni paydas kumesi) basina sayilan oy `min(bolum, floor(bolum toplami / 3))`;
 * toplam oy ve katilan oy bu sinirla sayilir (pay ve payda tutarli).
 *
 * Toplanti yeter sayisi (m.30): kat maliklerinin SAYI (sinirli oy) ve ARSA PAYI cogunlugu, ikisi
 * birden (yarisindan fazlasi). Oy listesinde arsa payi girilmemis bolum varsa arsa payi olcutu
 * HESAPLANAMAZ ve yeter sayi saglanmamis sayilir. Ikinci toplantida (ilk toplantida yeter sayi
 * saglanamadi, en gec 15 gun sonra) yeter sayi aranmaz. Karar: katilanlarin oy cogunlugu.
 *
 * Vekalet (m.31): bir kisi oylarin %5'inden fazlasini temsil edemez; 40 veya daha az bolumlu
 * yapida en fazla iki kat malikine vekil olabilir. Vekil uye kimligiyle (userId), uye degilse
 * ad-soyadla tanimlanir.
 */
import { fraction, landShareComputable, toBps } from '../polls/results.js';
import type { RollEntry, RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';

export type ProxyRef = { userId?: string; name: string };
type Entry = Pick<RollEntry, 'unitId' | 'owners' | 'weight'>;
type Att = { unitId: string; mode: 'present' | 'proxy' | 'absent'; proxy?: ProxyRef };

export type Quorum = {
  totalUnits: number;
  presentUnits: number;
  proxyUnits: number;
  /** m.31 sinirli oy sayilari (yeter sayi ve karar bunlarla). */
  totalVotes: number;
  presentVotes: number;
  /** Oyu ucte birle sinirlanan malik grubu sayisi. */
  cappedOwners: number;
  unitsBps: number;
  landShareComputable: boolean;
  totalLandShare: Fraction | null;
  presentLandShare: Fraction | null;
  landShareBps: number | null;
  unitsMajority: boolean;
  landShareMajority: boolean;
  secondMeeting: boolean;
  /** Toplanti yeter sayisi saglandi mi (ikinci toplantida her zaman true). */
  met: boolean;
  /** Bir gundem maddesinin kabulu icin gereken en az kabul oyu. */
  decisionThreshold: number;
  /** Saglanmadiysa nedenleri. */
  reasons: string[];
  warnings: string[];
};

/** Bolumun malik grubu: tek malikte malik, hisselide paydas kumesi (tek temsilci); malik yoksa bolum. */
export const ownerGroup = (e: Pick<RollEntry, 'unitId' | 'owners'>) => (e.owners.length ? e.owners.map((o) => o.userId).sort().join('+') : `unit:${e.unitId}`);

/** Birden fazla bolumu olan malikin en fazla oyu: toplam oylarin ucte biri, kesir atilir (en az 1). */
export const voteCap = (totalUnits: number) => Math.max(1, Math.floor(totalUnits / 3));

/** m.31 sinirli toplam ve katilan oy. */
export function countVotes(entries: readonly Pick<RollEntry, 'unitId' | 'owners'>[], present: ReadonlySet<string>) {
  const cap = voteCap(entries.length);
  const groups = new Map<string, { units: number; present: number }>();
  for (const e of entries) {
    const g = groups.get(ownerGroup(e)) ?? { units: 0, present: 0 };
    groups.set(ownerGroup(e), { units: g.units + 1, present: g.present + (present.has(e.unitId) ? 1 : 0) });
  }
  let totalVotes = 0;
  let presentVotes = 0;
  let cappedOwners = 0;
  for (const g of groups.values()) {
    const allowed = g.units > 1 ? Math.min(g.units, cap) : g.units;
    if (allowed < g.units) cappedOwners += 1;
    totalVotes += allowed;
    presentVotes += Math.min(g.present, allowed);
  }
  return { totalVotes, presentVotes, cappedOwners, cap };
}

/** Vekalet siniri: 40 ve alti bolumde en fazla iki kat maliki; ustunde oylarin %5'i (kesir atilir). */
export function proxyLimit(totalUnits: number, totalVotes: number): { kind: 'owners' | 'votes'; max: number } {
  return totalUnits <= 40 ? { kind: 'owners', max: 2 } : { kind: 'votes', max: Math.floor((totalVotes * 5) / 100) };
}

/** Vekil kimligi: uye ise userId, degilse bosluk / harf farki gozetilmeyen ad. */
export const proxyKey = (p: ProxyRef) => (p.userId ? `user:${p.userId}` : `name:${p.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr')}`);

/** Vekaletler (yeni kayit dahil) sinirlari asiyorsa nedeni; aksi halde null. */
export function proxyViolation(entries: readonly Pick<RollEntry, 'unitId' | 'owners'>[], attendance: readonly Att[], proxy: ProxyRef): string | null {
  const key = proxyKey(proxy);
  const byUnit = new Map(entries.map((e) => [e.unitId, e]));
  const represented = attendance.filter((a) => a.mode === 'proxy' && a.proxy && proxyKey(a.proxy) === key && byUnit.has(a.unitId));
  const { totalVotes } = countVotes(entries, new Set());
  const limit = proxyLimit(entries.length, totalVotes);
  if (limit.kind === 'owners') {
    const owners = new Set(represented.map((a) => ownerGroup(byUnit.get(a.unitId) as Entry)));
    return owners.size > limit.max ? `${proxy.name} en fazla ${limit.max} kat malikine vekil olabilir (KMK m.31; 40 veya daha az bölüm)` : null;
  }
  return represented.length > limit.max ? `${proxy.name} oyların %5'inden fazlasını (en fazla ${limit.max} oy) temsil edemez (KMK m.31)` : null;
}

export function assemblyQuorum(input: { entries: readonly Entry[]; meta: Pick<RollMeta, 'denominator' | 'missingLandShare' | 'totalWeight'>; attendance: readonly Att[]; secondMeeting: boolean }): Quorum {
  const { entries, meta, secondMeeting } = input;
  const byUnit = new Map(entries.map((e) => [e.unitId, e]));
  const present = input.attendance.filter((a) => a.mode !== 'absent' && byUnit.has(a.unitId));
  const presentIds = new Set(present.map((a) => a.unitId));
  const votes = countVotes(entries, presentIds);
  const landOk = landShareComputable(meta);
  const D = landOk ? BigInt(meta.denominator as string) : null;
  const totalLand = BigInt(meta.totalWeight);
  const presentLand = present.reduce((s, a) => s + BigInt(byUnit.get(a.unitId)?.weight ?? '0'), 0n);
  const unitsMajority = votes.presentVotes * 2 > votes.totalVotes;
  const landShareMajority = landOk && totalLand > 0n && presentLand * 2n > totalLand;

  const reasons: string[] = [];
  if (!unitsMajority) reasons.push(`Katılan oy (${votes.presentVotes}/${votes.totalVotes}) toplam oyların yarısından fazla değil`);
  if (!landOk) {
    reasons.push(
      meta.missingLandShare > 0
        ? `${meta.missingLandShare} bölümün arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, yeter sayı sağlanmış sayılmaz`
        : 'Bölümlerde arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, yeter sayı sağlanmış sayılmaz',
    );
  } else if (!landShareMajority) reasons.push('Katılanların arsa payı toplamın yarısından fazla değil');

  const warnings: string[] = [];
  if (votes.cappedOwners > 0) warnings.push(`KMK m.31: ${votes.cappedOwners} malikin oyu toplam oyların üçte biriyle (en fazla ${votes.cap} oy) sınırlandı`);
  const met = secondMeeting || (unitsMajority && landShareMajority);

  return {
    totalUnits: entries.length,
    presentUnits: present.length,
    proxyUnits: present.filter((a) => a.mode === 'proxy').length,
    totalVotes: votes.totalVotes,
    presentVotes: votes.presentVotes,
    cappedOwners: votes.cappedOwners,
    unitsBps: toBps(BigInt(votes.presentVotes), BigInt(votes.totalVotes)),
    landShareComputable: landOk,
    totalLandShare: D === null ? null : fraction(totalLand, D),
    presentLandShare: D === null ? null : fraction(presentLand, D),
    landShareBps: D === null ? null : toBps(presentLand, totalLand),
    unitsMajority,
    landShareMajority,
    secondMeeting,
    met,
    decisionThreshold: Math.floor(votes.presentVotes / 2) + 1,
    reasons: met ? [] : reasons,
    warnings,
  };
}

/** Katilanlarin oy cogunlugu: kabul oyu katilan (sinirli) oyun yarisindan fazla. */
export const decide = (yes: number, presentVotes: number): 'accepted' | 'rejected' => (yes * 2 > presentVotes ? 'accepted' : 'rejected');
