import { BatchGetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { createFinanceRepository, financeKeys } from '../src/modules/finance/repository.js';

/**
 * Ariza & bakim v2 ekipman gecmisi: masraflarin ters kayit kontrolu (`REV_<islem>`) tek tek Get
 * yerine 100'erli BatchGet ile; islenemeyen anahtarlar yeniden denenir, baska apartman elenir.
 */
const ddb = mockClient(DynamoDBDocumentClient);

describe('toplu idempotency okumasi', () => {
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-main';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('100erli parcalar, yalnizca anahtar projeksiyonu; islenemeyenler yeniden denenir', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `REV_tx${i}`);
    const key = (id: string) => financeKeys.idempotency('apt-1', id);
    let calls = 0;
    ddb.on(BatchGetCommand).callsFake((input: { RequestItems: Record<string, { Keys: { PK: string; SK: string }[]; ProjectionExpression?: string }> }) => {
      calls++;
      const req = input.RequestItems['bm-main'];
      expect(req?.ProjectionExpression).toBe('#pk, #sk');
      expect(req?.Keys.length).toBeLessThanOrEqual(100);
      const keys = req?.Keys ?? [];
      const hit = keys.filter((k) => k.SK === key('REV_tx3').SK || k.SK === key('REV_tx120').SK);
      // tx120'nin parcasinda ilk tur islenemez, ikinci turda gelir.
      const deferred = keys.find((k) => k.SK === key('REV_tx120').SK);
      if (deferred && calls <= 2) return { Responses: { 'bm-main': hit.filter((k) => k !== deferred) }, UnprocessedKeys: { 'bm-main': { Keys: [deferred] } } };
      return { Responses: { 'bm-main': [...hit, { PK: 'APT#apt-2', SK: key('REV_tx5').SK }] } };
    });
    const found = await createFinanceRepository().existingIdempotencyIds?.('apt-1', ids);
    expect([...(found ?? [])].sort()).toEqual(['REV_tx120', 'REV_tx3']);
    expect(calls).toBe(3);
  });
});
