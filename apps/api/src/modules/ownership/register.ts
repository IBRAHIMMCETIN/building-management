/**
 * Finans 2.1 - Mulkiyet sicili yorumlayicisi ve devir hesaplari. SAF fonksiyonlar, I/O yok.
 */
import type { IsoDate, LandShare, Unit } from '../core/types.js';
import { ValidationError } from '../core/validation.js';
import { coversDay } from '../finance/occupancy.js';
import type { UnitMembership } from '../portal/types.js';
import {
  MAX_OWNERS,
  type OwnerShare,
  type Share,
  addShares,
  assertCompleteTable,
  compareShares,
  formatShare,
  isComplete,
  isZeroShare,
  reduceShare,
  sortOwners,
  subtractShare,
  sumShares,
  toBps,
} from './shares.js';
import type { OwnershipHead, OwnershipRecord, ShareMove, TransferKind } from './types.js';

/** Takvim gunu ekle/cikar (UTC tabanli; saat dilimi kaymasi yok). */
export function addDays(day: IsoDate, n: number): IsoDate {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** (validFrom, seq) siralamasi. */
export const recordOrder = (a: OwnershipRecord, b: OwnershipRecord) => a.validFrom.localeCompare(b.validFrom) || a.seq - b.seq;

/** `day` gunu gecerli sicil kaydi (yoksa undefined). */
export function effectiveRecord(records: readonly OwnershipRecord[], unitId: string, day: IsoDate): OwnershipRecord | undefined {
  let best: OwnershipRecord | undefined;
  for (const r of records) {
    if (r.unitId !== unitId || r.validFrom > day) continue;
    if (!best || recordOrder(r, best) > 0) best = r;
  }
  return best;
}

/** En son sicil kaydi (gecerlilik tarihinden bagimsiz). */
export function latestRecord(records: readonly OwnershipRecord[], unitId: string): OwnershipRecord | undefined {
  let best: OwnershipRecord | undefined;
  for (const r of records) if (r.unitId === unitId && (!best || recordOrder(r, best) > 0)) best = r;
  return best;
}

type MemberLike = Pick<UnitMembership, 'userId' | 'unitId' | 'relation' | 'residesInUnit' | 'startDate' | 'endDate' | 'status' | 'endedByClosureId' | 'ownershipShare'>;

/** `day` gunu dairede kayitli malik uyelikleri. */
export function ownersOn(memberships: readonly MemberLike[], unitId: string, day: IsoDate): MemberLike[] {
  return memberships.filter((m) => m.unitId === unitId && m.relation === 'owner' && coversDay(m, day));
}

export type DerivedTable =
  | { status: 'complete'; owners: OwnerShare[]; validFrom: IsoDate }
  | { status: 'no_owner' }
  | { status: 'incomplete'; owners: { userId: string; share?: Share }[]; total?: Share; reason: string };

/**
 * Sicil yokken uyeliklerden pay tablosu turetir (ilk sicil gecisi / eksik hisse tespiti):
 *  - tek malik, paysiz -> 1/1
 *  - tum maliklerin payi var ve toplam tam 1 -> o paylar
 *  - aksi halde eksik (paysiz paydas veya toplam 1 degil)
 * `validFrom`: tablodaki maliklerin en gec baslangic gunu (tablo o gunden beri bu haliyle gecerli).
 */
export function deriveFromMemberships(memberships: readonly MemberLike[], unitId: string, day: IsoDate): DerivedTable {
  const owners = ownersOn(memberships, unitId, day);
  if (owners.length === 0) return { status: 'no_owner' };
  const validFrom = owners.map((m) => m.startDate).sort().at(-1) as IsoDate;
  if (owners.length === 1 && !owners[0]?.ownershipShare) {
    return { status: 'complete', owners: [{ userId: (owners[0] as MemberLike).userId, share: { numerator: 1, denominator: 1 } }], validFrom };
  }
  const listed = owners.map((m) => ({ userId: m.userId, ...(m.ownershipShare ? { share: reduceShare(m.ownershipShare) } : {}) }));
  if (listed.some((o) => !o.share)) {
    return { status: 'incomplete', owners: listed, reason: 'Paylı mülkiyette her malikin payı girilmeli' };
  }
  const shares = listed.map((o) => o.share as Share);
  if (owners.length > MAX_OWNERS) {
    return { status: 'incomplete', owners: listed, total: sumShares(shares), reason: `En fazla ${MAX_OWNERS} paydaş desteklenir` };
  }
  if (!isComplete(shares)) {
    const total = sumShares(shares);
    return { status: 'incomplete', owners: listed, total, reason: `Payların toplamı 1 değil (${formatShare(total)})` };
  }
  return { status: 'complete', owners: sortOwners(listed.map((o) => ({ userId: o.userId, share: o.share as Share }))), validFrom };
}

/** Sicil tablosu ile uyelikler ayni maliklerden mi olusuyor? (`register_mismatch` tespiti) */
export function membershipMismatch(table: readonly OwnerShare[], memberships: readonly MemberLike[], unitId: string, day: IsoDate) {
  const members = new Set(ownersOn(memberships, unitId, day).map((m) => m.userId));
  const listed = new Set(table.map((o) => o.userId));
  return {
    missingMembership: [...listed].filter((u) => !members.has(u)).sort(),
    notInRegister: [...members].filter((u) => !listed.has(u)).sort(),
  };
}

/**
 * Devri uygular: her hareket devredenden devralana pay tasir. Dogrulama:
 *  - devreden mevcut paydas, devralan ondan farkli, pay > 0 ve devredenin kalan payini asmaz
 *  - tur kurallari: `sale_full` tum mevcut paydaslar tum paylarini devreder ve devralanlar yeni
 *    kisilerdir; `inheritance` tek bir paydasin (murisin) payinin tamami mirascilara gecer
 *  - sonuc tablosu tam 1 ve en fazla MAX_OWNERS paydas (hareketler payi korudugu icin toplam 1 kalir)
 */
export function applyMoves(before: readonly OwnerShare[], moves: readonly ShareMove[], kind: TransferKind): OwnerShare[] {
  if (moves.length === 0) throw new ValidationError('En az bir pay hareketi gerekli', 'moves');
  const table = new Map<string, Share>(before.map((o) => [o.userId, o.share]));
  const original = new Set(before.map((o) => o.userId));
  for (const [i, m] of moves.entries()) {
    const field = `moves[${i}]`;
    if (m.fromUserId === m.toUserId) throw new ValidationError('Devreden ile devralan ayni kisi olamaz', field);
    if (!original.has(m.fromUserId)) throw new ValidationError(`Devreden (${m.fromUserId}) devir tarihinde malik degil`, field);
    const current = table.get(m.fromUserId);
    if (!current || isZeroShare(current)) throw new ValidationError(`Devredenin (${m.fromUserId}) devredecek payi kalmadi`, field);
    if (compareShares(m.share, current) > 0) {
      throw new ValidationError(`Devredilen pay (${formatShare(m.share)}) devredenin payini (${formatShare(current)}) asiyor`, field);
    }
    table.set(m.fromUserId, subtractShare(current, m.share));
    const to = table.get(m.toUserId);
    table.set(m.toUserId, to && !isZeroShare(to) ? addShares(to, m.share) : reduceShare(m.share));
  }
  const after = sortOwners([...table.entries()].filter(([, s]) => !isZeroShare(s)).map(([userId, share]) => ({ userId, share })));

  if (kind === 'sale_full') {
    if (after.some((o) => original.has(o.userId))) {
      throw new ValidationError('Tam satista mevcut maliklerin tum paylari devredilmeli ve devralanlar yeni kisiler olmali', 'moves');
    }
  }
  if (kind === 'inheritance') {
    const givers = [...new Set(moves.map((m) => m.fromUserId))];
    if (givers.length !== 1) throw new ValidationError('Miras devrinde tek bir murisin payi devredilir', 'moves');
    if (after.some((o) => o.userId === givers[0])) {
      throw new ValidationError('Miras devrinde murisin payinin tamami mirascilara gecmeli', 'moves');
    }
  }
  assertCompleteTable(after, 'moves');
  return after;
}

/** Devirde paydaslarin durumu: cikan (payi kalmayan), giren (yeni), payi degisen. */
export function diffTables(before: readonly OwnerShare[], after: readonly OwnerShare[]) {
  const b = new Map(before.map((o) => [o.userId, o.share]));
  const a = new Map(after.map((o) => [o.userId, o.share]));
  return {
    exiting: before.filter((o) => !a.has(o.userId)).map((o) => o.userId).sort(),
    entering: after.filter((o) => !b.has(o.userId)).map((o) => o.userId).sort(),
    changed: after.filter((o) => b.has(o.userId) && compareShares(o.share, b.get(o.userId) as Share) !== 0).map((o) => o.userId).sort(),
  };
}

/** Gosterim: tablo + bps (toplam 10.000). */
export function tableView(owners: readonly OwnerShare[]) {
  const bps = toBps(owners.map((o) => o.share));
  return owners.map((o, i) => ({ userId: o.userId, share: o.share, bps: bps[i] ?? 0 }));
}

// ---------------------------------------------------------------------------
// Oy agirligi hazirligi (kat malikleri kurulu)
// ---------------------------------------------------------------------------

export type VotingRollItem = {
  unitId: string;
  blockId: string;
  number: string;
  /** Sayica cogunluk: her bagimsiz bolum bir oy. */
  vote: 1;
  /** Arsa payi cogunlugu icin (tapudaki pay). */
  landShare?: LandShare;
  source: 'register' | 'memberships' | 'none';
  owners: { userId: string; share?: Share; bps?: number }[];
  /** Oyu kullanacak kisi: tek malikte malik, paylida secilmis temsilci. Secilmemisse yok (varsayim yapilmaz). */
  representativeUserId?: string;
  warnings: string[];
};

/**
 * `day` gunu icin oy listesi. Temsilci secilmemis paylı bolumde varsayim yapilmaz; `"temsilci yok"`
 * uyarisi verilir.
 */
export function buildVotingRoll(input: {
  units: readonly Unit[];
  heads: readonly OwnershipHead[];
  records: readonly OwnershipRecord[];
  memberships: readonly MemberLike[];
  day: IsoDate;
}): { asOf: IsoDate; unitCount: number; items: VotingRollItem[]; warningCount: number } {
  const items: VotingRollItem[] = [];
  const headOf = new Map(input.heads.map((h) => [h.unitId, h]));
  for (const unit of [...input.units].filter((u) => u.status === 'active').sort((a, b) => a.unitId.localeCompare(b.unitId))) {
    const warnings: string[] = [];
    const rec = effectiveRecord(input.records, unit.unitId, input.day);
    let owners: VotingRollItem['owners'] = [];
    let source: VotingRollItem['source'] = 'none';
    if (rec) {
      source = 'register';
      owners = tableView(rec.owners);
    } else {
      const derived = deriveFromMemberships(input.memberships, unit.unitId, input.day);
      if (derived.status === 'complete') {
        source = 'memberships';
        owners = tableView(derived.owners);
      } else if (derived.status === 'incomplete') {
        source = 'memberships';
        owners = derived.owners.map((o) => ({ userId: o.userId, ...(o.share ? { share: o.share } : {}) }));
        warnings.push(`Hisse bilgisi eksik: ${derived.reason}`);
      } else {
        warnings.push('Malik kaydı yok');
      }
    }
    let representativeUserId: string | undefined;
    if (owners.length === 1) {
      representativeUserId = owners[0]?.userId;
    } else if (owners.length > 1) {
      const chosen = headOf.get(unit.unitId)?.representativeUserId;
      if (chosen && owners.some((o) => o.userId === chosen)) representativeUserId = chosen;
      else warnings.push('temsilci yok');
    }
    items.push({
      unitId: unit.unitId,
      blockId: unit.blockId,
      number: unit.number,
      vote: 1,
      ...(unit.landShare ? { landShare: unit.landShare } : {}),
      source,
      owners,
      ...(representativeUserId ? { representativeUserId } : {}),
      warnings,
    });
  }
  return { asOf: input.day, unitCount: items.length, items, warningCount: items.filter((i) => i.warnings.length > 0).length };
}
