/**
 * Y1-3 - Kat malikleri kurulu yeter sayilari (KMK m.30). SAF fonksiyonlar, I/O yok.
 *
 *  - Toplanti yeter sayisi: kat maliklerinin SAYI ve ARSA PAYI cogunlugu (ikisi birden; yarisindan
 *    fazlasi). Sayi, oy listesindeki bagimsiz bolum basina bir oydur (hisseli bolum tek oy).
 *    Asaleten ve vekaleten katilim birlikte sayilir.
 *  - Ikinci toplanti (ilk toplantida yeter sayi saglanamadi): toplanti yeter sayisi aranmaz.
 *  - Karar yeter sayisi: katilanlarin sayi cogunlugu (kabul > katilan bolum / 2). Cekimser ve
 *    oy kullanmayan katilimci kabul sayilmaz.
 * Ozel cogunluk gerektiren kararlar (KMK'da 4/5, oybirligi vb.) bu kapsamda degildir.
 */
import type { VotingRollItem } from '../ownership/register.js';
import { commonDenominator, fraction, scaledWeight, toBps } from '../polls/results.js';
import type { Fraction } from '../polls/types.js';
import type { AssemblyAttendance } from './types.js';

export type Quorum = {
  totalUnits: number;
  presentUnits: number;
  proxyUnits: number;
  unitsBps: number;
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
  warnings: string[];
};

type RollRow = Pick<VotingRollItem, 'unitId' | 'landShare' | 'owners'>;

export function assemblyQuorum(input: { roll: readonly RollRow[]; attendance: readonly AssemblyAttendance[]; secondMeeting: boolean }): Quorum {
  const { roll, secondMeeting } = input;
  const inRoll = new Map(roll.map((r) => [r.unitId, r]));
  const present = input.attendance.filter((a) => a.mode !== 'absent' && inRoll.has(a.unitId));
  const L = commonDenominator(roll.map((r) => r.landShare));
  const totalLand = roll.reduce((s, r) => s + scaledWeight(r.landShare, L), 0n);
  const presentLand = present.reduce((s, a) => s + scaledWeight(inRoll.get(a.unitId)?.landShare, L), 0n);
  const totalUnits = roll.length;
  const presentUnits = present.length;
  const unitsMajority = presentUnits * 2 > totalUnits;
  const landShareMajority = L !== null && totalLand > 0n && presentLand * 2n > totalLand;

  const warnings: string[] = [];
  const missingLand = roll.filter((r) => !r.landShare).length;
  if (L === null) warnings.push('Bölümlerde arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor');
  else if (missingLand > 0) warnings.push(`${missingLand} bölümün arsa payı girilmemiş; arsa payı toplamına katılmadı`);

  const proxies = new Map<string, { name: string; count: number }>();
  for (const a of present) {
    if (a.mode !== 'proxy' || !a.proxyName) continue;
    const key = a.proxyName.trim().toLocaleLowerCase('tr');
    const cur = proxies.get(key) ?? { name: a.proxyName.trim(), count: 0 };
    proxies.set(key, { ...cur, count: cur.count + 1 });
  }
  for (const p of proxies.values()) {
    if (p.count > 1) warnings.push(`Aynı vekil birden fazla bölümü temsil ediyor (${p.name}: ${p.count} bölüm); KMK m.31 vekâlet sınırlarını kontrol edin`);
  }
  const unitsByOwner = new Map<string, number>();
  for (const r of roll) if (r.owners.length === 1) unitsByOwner.set(r.owners[0]?.userId ?? '', (unitsByOwner.get(r.owners[0]?.userId ?? '') ?? 0) + 1);
  if ([...unitsByOwner.values()].some((n) => n * 3 > totalUnits && n > 1)) {
    warnings.push('Bir malikin bölüm sayısı toplam oyların üçte birini aşıyor; KMK m.31 oy sınırını kontrol edin');
  }

  return {
    totalUnits,
    presentUnits,
    proxyUnits: present.filter((a) => a.mode === 'proxy').length,
    unitsBps: toBps(BigInt(presentUnits), BigInt(totalUnits)),
    totalLandShare: L === null ? null : fraction(totalLand, L),
    presentLandShare: L === null ? null : fraction(presentLand, L),
    landShareBps: L === null ? null : toBps(presentLand, totalLand),
    unitsMajority,
    landShareMajority,
    secondMeeting,
    met: secondMeeting || (unitsMajority && landShareMajority),
    decisionThreshold: Math.floor(presentUnits / 2) + 1,
    warnings,
  };
}

/** Katilanlarin sayi cogunlugu: kabul oyu katilan bolum sayisinin yarisindan fazla. */
export const decide = (yes: number, presentUnits: number): 'accepted' | 'rejected' => (yes * 2 > presentUnits ? 'accepted' : 'rejected');
