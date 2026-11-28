/**
 * Y1 - Dondurulmus oy listesi (oylama yayininda, genel kurulda katilim / sayim / hazirun ilk
 * istendiginde). Sonuc, yeter sayi ve hazirun cetveli YALNIZCA bu anlik goruntuden okunur; canli
 * mulkiyet sicili / uyelikler sonradan degisse de oylamanin paydasi ve oy hakki degismez.
 *
 * Anahtarlar: `POLLROLL#<pollId>#<kova>` / `ASMROLL#<assemblyId>#<kova>` (3 hane). Bolum, kimliginin
 * SHA-256 ozetiyle sabit bir kovaya duser: oy aninda tek GetItem ile bulunur. Kovalar sahibi
 * (oylama / toplanti) kaydiyla AYNI `TransactWriteItems` icinde, `attribute_not_exists` ile yazilir;
 * DynamoDB oge siniri (400 KB) ve islem siniri (100 oge, 4 MB) icin kova sayisi buyutulur.
 */
import { createHash } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import type { IsoDate, IsoDateTime, LandShare, TableKeys } from '../core/types.js';
import type { VotingRollItem } from '../ownership/register.js';
import { PollError } from './errors.js';

export type RollOwnerType = 'poll' | 'assembly' | 'consent';
export type RollVoter = { userId: string; relation: 'owner' | 'tenant' };

export type RollEntry = {
  unitId: string;
  blockId: string;
  number: string;
  landShare?: LandShare;
  owners: { userId: string; share?: { numerator: number; denominator: number } }[];
  /** Hisseli bolumde paydaslarin sectigi temsilci (oy listesindeki secim; yoksa bos). */
  representativeUserId?: string;
  /** Bolumun oyunu kullanabilecek kisiler (oylamada hedef kitleye gore; kurulda malikler). */
  voters: RollVoter[];
  /** Arsa payinin ortak paydadaki degeri (BigInt metni); arsa payi yoksa "0". */
  weight: string;
  warnings: string[];
};

/** Sahibi kaydinda (oylama / toplanti) tutulan ozet. */
export type RollMeta = {
  rollDate: IsoDate;
  frozenAt: IsoDateTime;
  units: number;
  buckets: number;
  /** Tum arsa paylarinin ortak paydasi (EKOK, BigInt metni); hic arsa payi yoksa null. */
  denominator: string | null;
  /** Arsa payi agirliklarinin toplami (BigInt metni). */
  totalWeight: string;
  /** Arsa payi girilmemis bolum sayisi: > 0 ise arsa payi olcutu hesaplanamaz. */
  missingLandShare: number;
};

export type RollChunk = TableKeys & {
  entityType: 'ROLL_SNAPSHOT';
  apartmentId: string;
  ownerType: RollOwnerType;
  ownerId: string;
  bucket: number;
  entries: RollEntry[];
};

const PREFIX: Record<RollOwnerType, string> = { poll: 'POLLROLL', assembly: 'ASMROLL', consent: 'ASMCONSROLL' };
const MAX_CHUNK_BYTES = 300_000;
const MAX_BUCKETS = 90;
const MAX_TOTAL_BYTES = 3_500_000;

export const rollKeys = {
  chunk: (apartmentId: string, ownerType: RollOwnerType, ownerId: string, bucket: number): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey(PREFIX[ownerType], ownerId, String(bucket).padStart(3, '0')),
  }),
  prefix: (ownerType: RollOwnerType, ownerId: string) => `${PREFIX[ownerType]}#${ownerId}#`,
};

export const bucketOf = (unitId: string, buckets: number): number => createHash('sha256').update(unitId).digest().readUInt32BE(0) % buckets;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export const validShare = (s: LandShare | undefined): s is LandShare =>
  !!s && Number.isSafeInteger(s.numerator) && Number.isSafeInteger(s.denominator) && s.numerator >= 0 && s.denominator > 0;

/** Tum arsa paylarinin ortak paydasi (EKOK, BigInt; tasma yok); hic arsa payi yoksa `null`. */
export function commonDenominator(shares: readonly (LandShare | undefined)[]): bigint | null {
  let l: bigint | null = null;
  for (const s of shares) {
    if (!validShare(s)) continue;
    const d = BigInt(s.denominator);
    l = l === null ? d : (l / gcd(l, d)) * d;
  }
  return l;
}

/** Arsa payinin ortak paydadaki degeri (yoksa 0). */
export const scaledWeight = (s: LandShare | undefined, denominator: bigint | null): bigint =>
  validShare(s) && denominator !== null ? BigInt(s.numerator) * (denominator / BigInt(s.denominator)) : 0n;

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** Canli oy listesinden dondurulmus goruntu (saf). */
export function buildSnapshot(input: {
  apartmentId: string;
  ownerType: RollOwnerType;
  ownerId: string;
  rollDate: IsoDate;
  frozenAt: IsoDateTime;
  roll: readonly VotingRollItem[];
  voters: (item: VotingRollItem) => RollVoter[];
}): { meta: RollMeta; chunks: RollChunk[]; entries: RollEntry[] } {
  const L = commonDenominator(input.roll.map((r) => r.landShare));
  const entries: RollEntry[] = input.roll.map((r) => ({
    unitId: r.unitId,
    blockId: r.blockId,
    number: r.number,
    ...(r.landShare ? { landShare: r.landShare } : {}),
    owners: r.owners.map((o) => ({ userId: o.userId, ...(o.share ? { share: o.share } : {}) })),
    ...(r.representativeUserId ? { representativeUserId: r.representativeUserId } : {}),
    voters: input.voters(r),
    weight: scaledWeight(r.landShare, L).toString(),
    warnings: r.warnings,
  }));
  if (bytes(entries) > MAX_TOTAL_BYTES) throw new PollError('unprocessable', 'Oy listesi tek seferde dondurulamayacak kadar büyük');
  let buckets = Math.max(1, Math.ceil(bytes(entries) / (MAX_CHUNK_BYTES / 2)));
  for (;;) {
    const groups: RollEntry[][] = Array.from({ length: buckets }, () => []);
    for (const e of entries) groups[bucketOf(e.unitId, buckets)]?.push(e);
    if (groups.every((g) => bytes(g) <= MAX_CHUNK_BYTES)) {
      const meta: RollMeta = {
        rollDate: input.rollDate,
        frozenAt: input.frozenAt,
        units: entries.length,
        buckets,
        denominator: L === null ? null : L.toString(),
        totalWeight: entries.reduce((s, e) => s + BigInt(e.weight), 0n).toString(),
        missingLandShare: entries.filter((e) => !validShare(e.landShare)).length,
      };
      const chunks = groups.map((g, bucket) => ({
        ...rollKeys.chunk(input.apartmentId, input.ownerType, input.ownerId, bucket),
        entityType: 'ROLL_SNAPSHOT' as const,
        apartmentId: input.apartmentId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        bucket,
        entries: g,
      }));
      return { meta, chunks, entries };
    }
    if (buckets >= MAX_BUCKETS) throw new PollError('unprocessable', 'Oy listesi tek seferde dondurulamayacak kadar büyük');
    buckets = Math.min(MAX_BUCKETS, buckets * 2);
  }
}

export type RollSnapshotStore = {
  /** Bolumun dondurulmus satiri (tek kova okunur). */
  entry(apartmentId: string, ownerType: RollOwnerType, ownerId: string, meta: RollMeta, unitId: string): Promise<RollEntry | undefined>;
  /** Tum satirlar (bolum kimligine gore sirali). */
  entries(apartmentId: string, ownerType: RollOwnerType, ownerId: string): Promise<RollEntry[]>;
};

export const rollSnapshotStore: RollSnapshotStore = {
  async entry(apartmentId, ownerType, ownerId, meta, unitId) {
    const chunk = await getTenantItem<RollChunk>(rollKeys.chunk(apartmentId, ownerType, ownerId, bucketOf(unitId, meta.buckets)));
    return chunk?.apartmentId === apartmentId ? chunk.entries.find((e) => e.unitId === unitId) : undefined;
  },
  async entries(apartmentId, ownerType, ownerId) {
    const chunks = await queryTenantAll<RollChunk>(apartmentId, rollKeys.prefix(ownerType, ownerId), { ConsistentRead: true });
    return chunks
      .filter((c) => c.entityType === 'ROLL_SNAPSHOT' && c.apartmentId === apartmentId && c.ownerId === ownerId)
      .flatMap((c) => c.entries)
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
  },
};

/** Testler icin bellek ici depo: `put` sahibi kaydin atomik yazimindaki kovalari alir. */
export function createMemoryRollStore() {
  const chunks = new Map<string, RollChunk>();
  const store: RollSnapshotStore & { put(items: readonly RollChunk[]): void } = {
    put: (items) => {
      for (const c of items) {
        if (chunks.has(`${c.PK}|${c.SK}`)) throw new Error('Oy listesi zaten dondurulmus');
        chunks.set(`${c.PK}|${c.SK}`, structuredClone(c));
      }
    },
    entry: async (apartmentId, ownerType, ownerId, meta, unitId) =>
      structuredClone(chunks.get(Object.values(rollKeys.chunk(apartmentId, ownerType, ownerId, bucketOf(unitId, meta.buckets))).join('|'))?.entries.find((e) => e.unitId === unitId)),
    entries: async (apartmentId, ownerType, ownerId) =>
      [...chunks.values()]
        .filter((c) => c.apartmentId === apartmentId && c.ownerType === ownerType && c.ownerId === ownerId)
        .flatMap((c) => structuredClone(c.entries))
        .sort((a, b) => a.unitId.localeCompare(b.unitId)),
  };
  return store;
}
