/**
 * Y1-3 - Kat malikleri kurulu yeter sayilari ve oy sinirlari (KMK m.30, m.31). SAF fonksiyonlar.
 * Hukuki yorum notlari README'de ("Hukuki yorum"); asagidaki kurallar oradaki yorumla aynidir.
 *
 *  - "Butun oylar": her bagimsiz bolum bir oy, SINIRSIZ toplam (= bolum sayisi). Payda hicbir zaman
 *    kuculmez.
 *  - Oy siniri (m.31): birden fazla bolumun oyunu kullanan GERCEK KISININ oyu `floor(butun oylar / 3)`
 *    ile sinirlidir (kesir atilir; cok kucuk yapida en az 1). Kisi, bolumun oyunu kullanan kisidir:
 *    tek malikte malik, hisseli bolumde temsilci (toplantida katilan paydas, yoksa oy listesindeki
 *    temsilci). Sinir kisi basina, kisinin oyunu kullandigi TUM bolumler uzerinden hesaplanir.
 *  - Toplanti yeter sayisi (m.30): kat maliklerinin SAYICA (ayri kisiler; hisseli bolum temsilcisiyle
 *    bir kez) ve toplam ARSA PAYININ yarisindan fazlasi. Arsa payi girilmemis bolum varsa arsa payi
 *    olcutu hesaplanamaz ve yeter sayi saglanmamis sayilir. Ikinci toplantida aranmaz.
 *  - Karar: katilanlarin oylarinin cogunlugu (bolum basina bir oy, kisi siniri uygulanmis).
 *  - Vekalet (m.31): 40 ve alti bolumde bir kisi en fazla iki kat malikine (ayri kisi) vekil olur;
 *    ustunde butun oylarin (sinirsiz) %5'inden fazlasini temsil edemez.
 */
import { fraction, landShareComputable, toBps } from '../polls/results.js';
import type { RollEntry, RollMeta } from '../polls/rollSnapshot.js';
import type { Fraction } from '../polls/types.js';

export type ProxyRef = { userId?: string; name: string };
type Entry = Pick<RollEntry, 'unitId' | 'owners' | 'weight' | 'representativeUserId'>;
type Att = { unitId: string; mode: 'present' | 'proxy' | 'absent'; attendee?: { userId: string }; proxy?: ProxyRef };

export type Quorum = {
  totalUnits: number;
  presentUnits: number;
  proxyUnits: number;
  /** Kat maliki sayisi (ayri kisiler; hisseli bolum temsilcisiyle bir kez): toplanti yeter sayisinin sayi olcutu. */
  totalOwners: number;
  presentOwners: number;
  ownersBps: number;
  /** Butun oylar (sinirsiz, bolum basina bir). */
  totalVotes: number;
  /** Katilanlarin sayilan oyu (m.31 kisi siniri uygulanmis): karar bununla. */
  presentVotes: number;
  /** Kisi basina en fazla oy: floor(butun oylar / 3). */
  voteCap: number;
  /** Oyu sinirlanan kisi sayisi. */
  cappedOwners: number;
  landShareComputable: boolean;
  totalLandShare: Fraction | null;
  presentLandShare: Fraction | null;
  landShareBps: number | null;
  ownersMajority: boolean;
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

/** Kisi basina oy siniri: butun oylarin ucte biri, kesir atilir (bolum sayisi 3'ten azsa 1). */
export const voteCap = (totalVotes: number) => Math.max(1, Math.floor(totalVotes / 3));

/**
 * Bolumun oyunu kullanan gercek kisi: tek malikte malik; hisseli bolumde toplantida katilan paydas,
 * yoksa oy listesindeki temsilci. Belirlenemiyorsa bolumun kendisi (baska bolumle birlestirilmez).
 */
export function voterOf(e: Pick<RollEntry, 'unitId' | 'owners' | 'representativeUserId'>, att?: Pick<Att, 'attendee'>): string {
  if (e.owners.length === 1) return `user:${e.owners[0]?.userId}`;
  const rep = att?.attendee?.userId ?? e.representativeUserId;
  if (rep && e.owners.some((o) => o.userId === rep)) return `user:${rep}`;
  return `unit:${e.unitId}`;
}

/** Kisi basina bolum sayilari ve m.31 sinirli oylar. */
export function countVotes(entries: readonly Pick<RollEntry, 'unitId' | 'owners' | 'representativeUserId'>[], attendance: readonly Att[]) {
  const attOf = new Map(attendance.map((a) => [a.unitId, a]));
  const totalVotes = entries.length;
  const cap = voteCap(totalVotes);
  const persons = new Map<string, { units: number; present: number }>();
  for (const e of entries) {
    const a = attOf.get(e.unitId);
    const key = voterOf(e, a);
    const p = persons.get(key) ?? { units: 0, present: 0 };
    persons.set(key, { units: p.units + 1, present: p.present + (a && a.mode !== 'absent' ? 1 : 0) });
  }
  let presentVotes = 0;
  let cappedOwners = 0;
  let presentOwners = 0;
  for (const p of persons.values()) {
    if (p.units > cap) cappedOwners += 1;
    presentVotes += Math.min(p.present, cap);
    if (p.present > 0) presentOwners += 1;
  }
  return { totalVotes, presentVotes, cap, cappedOwners, totalOwners: persons.size, presentOwners };
}

/** Vekalet siniri: 40 ve alti bolumde en fazla iki kat maliki; ustunde butun oylarin %5'i (kesir atilir). */
export function proxyLimit(totalVotes: number): { kind: 'owners' | 'votes'; max: number } {
  return totalVotes <= 40 ? { kind: 'owners', max: 2 } : { kind: 'votes', max: Math.floor((totalVotes * 5) / 100) };
}

/** Vekil kimligi: uye ise userId, degilse bosluk / harf farki gozetilmeyen ad. */
export const proxyKey = (p: ProxyRef) => (p.userId ? `user:${p.userId}` : `name:${p.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr')}`);

/** Vekaletler (yeni kayit dahil) sinirlari asiyorsa nedeni; aksi halde null. */
export function proxyViolation(entries: readonly Pick<RollEntry, 'unitId' | 'owners' | 'representativeUserId'>[], attendance: readonly Att[], proxy: ProxyRef): string | null {
  const key = proxyKey(proxy);
  const byUnit = new Map(entries.map((e) => [e.unitId, e]));
  const represented = attendance.filter((a) => a.mode === 'proxy' && a.proxy && proxyKey(a.proxy) === key && byUnit.has(a.unitId));
  const limit = proxyLimit(entries.length);
  if (limit.kind === 'owners') {
    const owners = new Set(represented.map((a) => voterOf(byUnit.get(a.unitId) as Entry, a)));
    return owners.size > limit.max ? `${proxy.name} en fazla ${limit.max} kat malikine vekil olabilir (KMK m.31; 40 veya daha az bölüm)` : null;
  }
  return represented.length > limit.max ? `${proxy.name} bütün oyların %5'inden fazlasını (en fazla ${limit.max} oy) temsil edemez (KMK m.31)` : null;
}

export function assemblyQuorum(input: { entries: readonly Entry[]; meta: Pick<RollMeta, 'denominator' | 'missingLandShare' | 'totalWeight'>; attendance: readonly Att[]; secondMeeting: boolean }): Quorum {
  const { entries, meta, secondMeeting } = input;
  const byUnit = new Map(entries.map((e) => [e.unitId, e]));
  const attendance = input.attendance.filter((a) => byUnit.has(a.unitId));
  const present = attendance.filter((a) => a.mode !== 'absent');
  const votes = countVotes(entries, attendance);
  const landOk = landShareComputable(meta);
  const D = landOk ? BigInt(meta.denominator as string) : null;
  const totalLand = BigInt(meta.totalWeight);
  const presentLand = present.reduce((s, a) => s + BigInt(byUnit.get(a.unitId)?.weight ?? '0'), 0n);
  const ownersMajority = votes.presentOwners * 2 > votes.totalOwners;
  const landShareMajority = landOk && totalLand > 0n && presentLand * 2n > totalLand;

  const reasons: string[] = [];
  if (!ownersMajority) reasons.push(`Katılan kat maliki (${votes.presentOwners}/${votes.totalOwners} kişi) toplamın yarısından fazla değil`);
  if (!landOk) {
    reasons.push(
      meta.missingLandShare > 0
        ? `${meta.missingLandShare} bölümün arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, yeter sayı sağlanmış sayılmaz`
        : 'Bölümlerde arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, yeter sayı sağlanmış sayılmaz',
    );
  } else if (!landShareMajority) reasons.push('Katılanların arsa payı toplamın yarısından fazla değil');

  const warnings: string[] = [];
  if (votes.cappedOwners > 0) warnings.push(`KMK m.31: ${votes.cappedOwners} kişinin oyu bütün oyların üçte biriyle (en fazla ${votes.cap} oy) sınırlandı`);
  const met = secondMeeting || (ownersMajority && landShareMajority);

  return {
    totalUnits: entries.length,
    presentUnits: present.length,
    proxyUnits: present.filter((a) => a.mode === 'proxy').length,
    totalOwners: votes.totalOwners,
    presentOwners: votes.presentOwners,
    ownersBps: toBps(BigInt(votes.presentOwners), BigInt(votes.totalOwners)),
    totalVotes: votes.totalVotes,
    presentVotes: votes.presentVotes,
    voteCap: votes.cap,
    cappedOwners: votes.cappedOwners,
    landShareComputable: landOk,
    totalLandShare: D === null ? null : fraction(totalLand, D),
    presentLandShare: D === null ? null : fraction(presentLand, D),
    landShareBps: D === null ? null : toBps(presentLand, totalLand),
    ownersMajority,
    landShareMajority,
    secondMeeting,
    met,
    decisionThreshold: Math.floor(votes.presentVotes / 2) + 1,
    reasons: met ? [] : reasons,
    warnings,
  };
}

/** Katilanlarin oy cogunlugu: kabul oyu katilanlarin sayilan oyunun yarisindan fazla. */
export const decide = (yes: number, presentVotes: number): 'accepted' | 'rejected' => (yes * 2 > presentVotes ? 'accepted' : 'rejected');
