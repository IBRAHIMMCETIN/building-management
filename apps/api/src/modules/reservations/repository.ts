import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, QueryCommand, type QueryCommandOutput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, queryTenantAll, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import { AuditChainBusyError, type AuditDraft, WriteContentionError, sendWithAudit } from '../audit/log.js';
import {
  type Booking,
  type BookingIndex,
  type Facility,
  type ReservationIdempotency,
  type SlotLock,
  reservationKeys,
} from './types.js';

/**
 * Rezervasyon deposu. Alan / rezervasyon, dilim kilitleri, daire surum sayaci, indeksler,
 * idempotency, outbox ve denetim kaydi tek `TransactWriteItems` ile yazilir.
 *
 * Cakisma garantisi kosullu yazimdan gelir: her 30 dakikalik dilim icin tek `RSLOT#` ogesi
 * `attribute_not_exists(PK) OR state = released` kosuluyla tutulur; ayni dilimi isteyen ikinci
 * yazim (es zamanli olsa da) reddedilir. Hicbir oge silinmez (Lambda'larin DeleteItem yetkisi yok).
 */
/**
 * `facility`: alan bu arada degisti / pasife alindi (eski kurallarla rezervasyon yazilmaz).
 * `contention`: es zamanli yazimlar yuzunden tekrar denemeler tukendi (dilimler kontrol edilmeli).
 */
export class ReservationConflictError extends Error {
  constructor(
    readonly reason: 'duplicate' | 'version' | 'slot' | 'guard' | 'facility' | 'contention',
    message = 'Kayıt başka bir işlemle değişti; sayfayı yenileyin',
  ) {
    super(message);
    this.name = 'ReservationConflictError';
  }
}

export type ReservationWrite = {
  at: string;
  /** 0: yeni alan. */
  facility?: { item: Facility; expectedVersion: number };
  /** 0: yeni rezervasyon. */
  booking?: { item: Booking; expectedVersion: number };
  /** Ayni yazimda alanin okunan surumde ve aktif oldugu kontrol edilir (`ConditionCheck`). */
  facilityCheck?: { facilityId: string; version: number };
  /** Tutulacak dilimler (bos ya da serbest birakilmis olmali). */
  hold?: SlotLock[];
  /** Serbest birakilacak dilimler (`state: released`); yalnizca ayni rezervasyon tutuyorsa. */
  release?: SlotLock[];
  /** Daire surum sayaci: okunan deger (0 = hic yok). */
  guard?: { facilityId: string; unitId: string; expected: number };
  /** Indeksler yalnizca eklenir. */
  indexes?: BookingIndex[];
  idempotency?: ReservationIdempotency;
  outbox?: DomainEvent[];
  audit?: AuditDraft;
};

export type ReservationRepository = {
  getFacility(apartmentId: string, facilityId: string): Promise<Facility | undefined>;
  listFacilities(apartmentId: string): Promise<Facility[]>;
  getBooking(apartmentId: string, bookingId: string): Promise<Booking | undefined>;
  getBookings(apartmentId: string, bookingIds: readonly string[]): Promise<Booking[]>;
  /** Takvim indeksi: baslangici [from, to) araliginda olan rezervasyon kimlikleri. */
  listFacilityBookingIds(apartmentId: string, facilityId: string, from: string, to: string): Promise<string[]>;
  /** Daire indeksi: baslangici `from` (dahil) sonrasi olan rezervasyon kimlikleri. */
  listUnitBookingIds(apartmentId: string, unitId: string, from: string): Promise<string[]>;
  /** [from, to) araligindaki tutulan dilimler. */
  listHeldSlots(apartmentId: string, facilityId: string, from: string, to: string): Promise<SlotLock[]>;
  getGuard(apartmentId: string, facilityId: string, unitId: string): Promise<number>;
  getIdempotency(apartmentId: string, key: string): Promise<ReservationIdempotency | undefined>;
  /** Iade kuyrugundaki (ters kaydi yapilamamis) rezervasyon kimlikleri. */
  listFeeQueue(apartmentId: string): Promise<string[]>;
  write(apartmentId: string, w: ReservationWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** `SK BETWEEN` ile sinirli araligi sayfalayarak okur (yalnizca tenant partition). */
async function queryBetween<T>(apartmentId: string, fromSk: string, toSk: string): Promise<T[]> {
  const pk = tenantPk(apartmentId);
  const { client, tableName } = getDynamo();
  const out: T[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'];
  try {
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: { ':pk': pk, ':from': fromSk, ':to': toSk },
          ConsistentRead: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      out.push(...((res.Items ?? []) as T[]));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
  } catch (err) {
    throw toDataAccessError(err);
  }
  return out;
}

export function createReservationRepository(): ReservationRepository {
  return {
    getFacility: (apt, id) => getTenantItem<Facility>(reservationKeys.facility(apt, id)),
    async listFacilities(apt) {
      const items = await queryTenantAll<Facility>(apt, reservationKeys.facilityPrefix, { ConsistentRead: true });
      return items.filter((f) => f.entityType === 'RESERVATION_FACILITY' && f.apartmentId === apt);
    },
    getBooking: (apt, id) => getTenantItem<Booking>(reservationKeys.booking(apt, id)),
    async getBookings(apt, bookingIds) {
      const ids = [...new Set(bookingIds)];
      const { client, tableName } = getDynamo();
      const out: Booking[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Record<string, unknown>[] = ids.slice(i, i + 100).map((id) => reservationKeys.booking(apt, id));
        for (let attempt = 0; keys.length && attempt < 5; attempt++) {
          try {
            const res = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } } }));
            out.push(...((res.Responses?.[tableName] ?? []) as Booking[]));
            keys = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[];
          } catch (err) {
            throw toDataAccessError(err);
          }
        }
      }
      return out.filter((b) => b.apartmentId === apt && b.entityType === 'RESERVATION_BOOKING');
    },
    async listFacilityBookingIds(apt, facilityId, from, to) {
      const p = reservationKeys.facilityIndexPrefix(facilityId);
      const items = await queryBetween<BookingIndex>(apt, `${p}${from}`, `${p}${to}`);
      return items.filter((i) => i.start >= from && i.start < to).map((i) => i.bookingId);
    },
    async listUnitBookingIds(apt, unitId, from) {
      const p = reservationKeys.unitIndexPrefix(unitId);
      // `~` her ISO karakterinden buyuktur: on ekin sonuna kadar.
      const items = await queryBetween<BookingIndex>(apt, `${p}${from}`, `${p}~`);
      return items.map((i) => i.bookingId);
    },
    async listHeldSlots(apt, facilityId, from, to) {
      const p = reservationKeys.slotPrefix(facilityId);
      const items = await queryBetween<SlotLock>(apt, `${p}${from}`, `${p}${to}`);
      return items.filter((s) => s.state === 'held' && s.slotStart >= from && s.slotStart < to);
    },
    async getGuard(apt, facilityId, unitId) {
      const item = await getTenantItem<{ seq?: number }>(reservationKeys.guard(apt, facilityId, unitId));
      return item?.seq ?? 0;
    },
    getIdempotency: (apt, key) => getTenantItem<ReservationIdempotency>(reservationKeys.idempotency(apt, key)),
    async listFeeQueue(apt) {
      const items = await queryTenantAll<BookingIndex>(apt, reservationKeys.feeQueuePrefix, { ConsistentRead: true });
      return items.map((i) => i.bookingId);
    },
    async write(apt, w) {
      const pk = tenantPk(apt);
      for (const doc of [w.facility?.item, w.booking?.item, ...(w.hold ?? []), ...(w.release ?? []), ...(w.indexes ?? []), w.idempotency]) {
        if (doc && doc.PK !== pk) throw new Error('Kiraci uyusmazligi');
      }
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [];
      const kinds: ReservationConflictError['reason'][] = [];
      const add = (kind: ReservationConflictError['reason'], item: TransactItem) => {
        items.push(item);
        kinds.push(kind);
      };
      const versioned = (item: Record<string, unknown>, expected: number): TransactItem => ({
        Put: {
          TableName: tableName,
          Item: item,
          ...(expected === 0
            ? { ConditionExpression: 'attribute_not_exists(PK)' }
            : {
                ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expected': expected },
              }),
        },
      });
      if (w.idempotency) add('duplicate', { Put: { TableName: tableName, Item: w.idempotency, ConditionExpression: 'attribute_not_exists(PK)' } });
      if (w.facility) add('version', versioned(w.facility.item, w.facility.expectedVersion));
      if (w.booking) add('version', versioned(w.booking.item, w.booking.expectedVersion));
      if (w.facilityCheck) {
        add('facility', {
          ConditionCheck: {
            TableName: tableName,
            Key: reservationKeys.facility(apt, w.facilityCheck.facilityId),
            ConditionExpression: 'attribute_exists(PK) AND #version = :fv AND #status = :active',
            ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
            ExpressionAttributeValues: { ':fv': w.facilityCheck.version, ':active': 'active' },
          },
        });
      }
      for (const s of w.hold ?? []) {
        add('slot', {
          Put: {
            TableName: tableName,
            Item: { ...s, state: 'held' },
            ConditionExpression: 'attribute_not_exists(PK) OR #state = :released',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':released': 'released' },
          },
        });
      }
      for (const s of w.release ?? []) {
        add('version', {
          Put: {
            TableName: tableName,
            Item: { ...s, state: 'released' },
            ConditionExpression: '#state = :held AND #booking = :booking',
            ExpressionAttributeNames: { '#state': 'state', '#booking': 'bookingId' },
            ExpressionAttributeValues: { ':held': 'held', ':booking': s.bookingId },
          },
        });
      }
      if (w.guard) {
        const expected = w.guard.expected;
        add('guard', {
          Update: {
            TableName: tableName,
            Key: reservationKeys.guard(apt, w.guard.facilityId, w.guard.unitId),
            UpdateExpression: 'SET #seq = :next, #et = :et, #updatedAt = :now',
            ConditionExpression: expected === 0 ? 'attribute_not_exists(PK)' : '#seq = :expected',
            ExpressionAttributeNames: { '#seq': 'seq', '#et': 'entityType', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':next': expected + 1, ':et': 'RESERVATION_GUARD', ':now': w.at, ...(expected === 0 ? {} : { ':expected': expected }) },
          },
        });
      }
      for (const i of w.indexes ?? []) add('version', { Put: { TableName: tableName, Item: i } });
      for (const o of toOutboxItems(w.outbox ?? [], w.at, apt)) {
        add('version', { Put: { TableName: tableName, Item: o, ConditionExpression: 'attribute_not_exists(PK)' } });
      }
      try {
        await sendWithAudit(client, items, w.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          // Kosul hatasi once; yoksa es zamanli islem cakismasi (TransactionConflict) ayni ogeye eslenir:
          // ayni dilimi ayni anda yazan iki rezervasyondan kaybeden `slot` alir.
          const reasons = err.CancellationReasons ?? [];
          let failed = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
          if (failed < 0 || failed >= kinds.length) failed = reasons.findIndex((r) => r.Code === 'TransactionConflict');
          if (failed >= 0 && failed < kinds.length) throw new ReservationConflictError(kinds[failed] as ReservationConflictError['reason']);
        }
        // Tekrar denemeleri tukenmis cekisme: dilim tutuluyorsa servis dilim durumunu kontrol eder.
        if ((err instanceof WriteContentionError || err instanceof AuditChainBusyError) && w.hold?.length) throw new ReservationConflictError('contention');
        throw toDataAccessError(err);
      }
    },
  };
}

export const reservationRepository: ReservationRepository = createReservationRepository();
