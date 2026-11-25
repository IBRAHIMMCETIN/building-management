import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, getTenantItem, queryTenantAll, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import { FISCAL_PERIOD_PREFIX, type FinanceLock, type FiscalPeriod, periodKeys } from './periodLock.js';

/**
 * Finans 2.4-2 - Mali donem kayitlari (FINLOCK, FPERIOD#). Kilit ve donem kaydi birlikte,
 * surum kosullu ve denetim kaydiyla ayni TransactWriteItems'ta yazilir.
 */
export class FiscalConflictError extends Error {
  constructor(message = 'Dönem kilidi başka bir işlemle değişti; yeniden deneyin') {
    super(message);
    this.name = 'FiscalConflictError';
  }
}

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export type FiscalWrite = {
  lock: FinanceLock;
  /** 0: kilit kaydi henuz yok. */
  expectedLockVersion: number;
  period?: FiscalPeriod;
  /** 0: donem kaydi henuz yok. */
  expectedPeriodVersion?: number;
  audit?: AuditDraft;
};

export type FiscalRepository = {
  getLock(apartmentId: string): Promise<FinanceLock | undefined>;
  getPeriod(apartmentId: string, period: string): Promise<FiscalPeriod | undefined>;
  listPeriods(apartmentId: string): Promise<FiscalPeriod[]>;
  write(apartmentId: string, w: FiscalWrite): Promise<void>;
};

function versioned(item: { PK: string; SK: string; version: number }, expected: number): TransactItem {
  return {
    Put: {
      TableName: getDynamo().tableName,
      Item: item,
      ConditionExpression: expected === 0 ? 'attribute_not_exists(PK)' : 'attribute_exists(PK) AND #version = :expected',
      ...(expected === 0 ? {} : { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': expected } }),
    },
  };
}

export const fiscalRepository: FiscalRepository = {
  getLock: (apartmentId) => getTenantItem<FinanceLock>(periodKeys.lock(apartmentId)),
  getPeriod: (apartmentId, period) => getTenantItem<FiscalPeriod>(periodKeys.period(apartmentId, period)),
  async listPeriods(apartmentId) {
    const items = await queryTenantAll<FiscalPeriod>(apartmentId, FISCAL_PERIOD_PREFIX, { ConsistentRead: true });
    return items.filter((p) => p.apartmentId === apartmentId).sort((a, b) => a.period.localeCompare(b.period));
  },
  async write(apartmentId, w) {
    if (w.lock.apartmentId !== apartmentId || (w.period && w.period.apartmentId !== apartmentId)) throw new Error('Kiraci uyusmazligi');
    const items: TransactItem[] = [versioned(w.lock, w.expectedLockVersion)];
    if (w.period) items.push(versioned(w.period, w.expectedPeriodVersion ?? 0));
    const { client } = getDynamo();
    try {
      await sendWithAudit(client, items, w.audit);
    } catch (err) {
      if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
        throw new FiscalConflictError();
      }
      throw toDataAccessError(err);
    }
  },
};
