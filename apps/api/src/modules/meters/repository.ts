/**
 * Finans 2.3 - Sayac modulu deposu. Okuma: tekil kayit ve SK on eki. Yazma: birden fazla kaydi
 * (olusturma `attribute_not_exists`, degistirme surum kosullu) + denetim kayitlarini TEK atomik
 * `TransactWriteItems` ile yazar. Ayni tablo, ayni partition: ek IAM izni gerekmez.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { getDynamo, getTenantItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudits } from '../audit/log.js';
import type { TableKeys } from '../core/types.js';
import { MeterError } from './errors.js';

export const meterKeys = {
  meter: (apartmentId: string, meterId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('METER', meterId) }),
  event: (apartmentId: string, meterId: string, at: string, eventId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    // Zaman damgasindaki ':' ve '.' SK'da sorun degil; '#' icermez.
    SK: skKey('METEREVT', meterId, at.replace(/[^0-9TZ]/g, ''), eventId),
  }),
  swap: (apartmentId: string, swapId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('METERSWAP', swapId) }),
  template: (apartmentId: string, templateId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('METERTPL', templateId) }),
  period: (apartmentId: string, periodId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('MPERIOD', periodId) }),
  reading: (apartmentId: string, periodId: string, meterId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('MREAD', periodId, meterId),
  }),
  idempotency: (apartmentId: string, key: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('METERIDEM', key) }),
  line: (apartmentId: string, periodId: string, unitId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('MDLINE', periodId, unitId) }),
  expenseLock: (apartmentId: string, expenseId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('EXPDIST', expenseId) }),
};

export const meterPrefixes = {
  meters: 'METER#',
  events: (meterId: string) => `METEREVT#${meterId}#`,
  swaps: 'METERSWAP#',
  templates: 'METERTPL#',
  periods: 'MPERIOD#',
  readings: (periodId: string) => `MREAD#${periodId}#`,
  lines: (periodId: string) => `MDLINE#${periodId}#`,
};

export type MeterDoc = { PK: string; SK: string; [key: string]: unknown };

export type MeterWrite =
  /** Kayit yoksa yazar (yoksa cakisma). */
  | { op: 'create'; item: MeterDoc }
  /** Kayit `expectedVersion` surumundeyse ustune yazar (yoksa cakisma). */
  | { op: 'replace'; item: MeterDoc; expectedVersion: number }
  /** Kosulsuz yazim (yalnizca onaydan once yeniden uretilebilen taslak kayitlar, ornegin MDLINE). */
  | { op: 'put'; item: MeterDoc };

export type MeterRepository = {
  get<T>(key: TableKeys): Promise<T | undefined>;
  /** `METER#` gibi on ek; `METEREVT#` kayitlari `METER#` on ekine takilmaz. */
  list<T>(apartmentId: string, skPrefix: string): Promise<T[]>;
  /** Tum yazimlar + denetim kayitlari tek atomik islem. Kosul saglanmazsa `MeterError('conflict')`. */
  write(writes: readonly MeterWrite[], audits: readonly AuditDraft[]): Promise<void>;
};

/** Atomik yazimin en fazla ogesi (denetim kayitlari icin pay birakilir). */
export const MAX_WRITE_ITEMS = 95;

export const CONFLICT_MESSAGE = 'Kayıt başka bir işlemle değişti; sayfayı yenileyip yeniden deneyin';

export function createMeterRepository(): MeterRepository {
  return {
    get: <T>(key: TableKeys) => getTenantItem<T>(key),
    list: <T>(apartmentId: string, skPrefix: string) => queryTenantAll<T>(apartmentId, skPrefix, { ConsistentRead: true }),
    async write(writes, audits) {
      if (writes.length === 0) return;
      if (writes.length > MAX_WRITE_ITEMS) throw new Error(`Atomik yazim en fazla ${MAX_WRITE_ITEMS} kayit`);
      const { client, tableName } = getDynamo();
      const items = writes.map((w) =>
        w.op === 'put'
          ? { Put: { TableName: tableName, Item: w.item } }
          : w.op === 'create'
          ? { Put: { TableName: tableName, Item: w.item, ConditionExpression: 'attribute_not_exists(PK)' } }
          : {
              Put: {
                TableName: tableName,
                Item: w.item,
                ConditionExpression: 'attribute_exists(PK) AND #version = :v',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':v': w.expectedVersion },
              },
            },
      );
      try {
        await sendWithAudits(client, items, audits);
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const codes = (err.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
          if (codes.some((c) => c === 'ConditionalCheckFailed' || c === 'TransactionConflict')) {
            throw new MeterError('conflict', CONFLICT_MESSAGE);
          }
        }
        throw toDataAccessError(err);
      }
    },
  };
}

export const meterRepository: MeterRepository = createMeterRepository();
