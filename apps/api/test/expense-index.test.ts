import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillExpenseIndex } from '../scripts/backfill-expense-index.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { createFinanceRepository, financeKeys } from '../src/modules/finance/repository.js';

/**
 * Gider tarih dizini: secici listeler (sayac donemi faturasi, talep masrafi baglama) tum
 * giderleri okumak yerine GSI1'den en yeni N kaydi sinirli sorguyla alir.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const quiet = { info: () => {} };

describe('gider tarih dizini', () => {
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-main';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('dizin anahtari tenant ve tarih sirali', () => {
    expect(financeKeys.expenseIndex('apt-1', '2026-11-30', 'e1')).toEqual({ GSI1PK: 'EXPDATE#apt-1', GSI1SK: '2026-11-30#e1' });
  });

  it('en yeni giderler: azalan tarih, limit kadar, sayfa sayfa; baska apartman kaydi elenir', async () => {
    const exp = (id: string, date: string, siteId = 'apt-1') => ({ PK: `APT#${siteId}`, SK: `EXP#${id}`, entityType: 'EXPENSE', expenseId: id, siteId, date });
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [exp('e3', '2026-11-30'), exp('x', '2026-11-29', 'apt-2')], LastEvaluatedKey: { GSI1PK: 'EXPDATE#apt-1', GSI1SK: '2026-11-29#x' } })
      .resolvesOnce({ Items: [exp('e2', '2026-11-20')] });
    const repo = createFinanceRepository();
    const items = await repo.listRecentExpenses?.('apt-1', { limit: 2, from: '2026-11-01' });
    expect(items?.map((e) => e.expenseId)).toEqual(['e3', 'e2']);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input).toMatchObject({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK >= :from',
      ExpressionAttributeValues: { ':pk': 'EXPDATE#apt-1', ':from': '2026-11-01' },
      ScanIndexForward: false,
      Limit: 2,
    });
    expect(calls[1]!.args[0].input).toMatchObject({ Limit: 1, ExclusiveStartKey: { GSI1PK: 'EXPDATE#apt-1', GSI1SK: '2026-11-29#x' } });
  });

  it('limit 1-500 arasina sikistirilir; limit dolunca yeni sayfa istenmez', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'APT#apt-1', SK: 'EXP#a', siteId: 'apt-1', expenseId: 'a', date: '2026-01-01' }], LastEvaluatedKey: { k: 1 } });
    const repo = createFinanceRepository();
    await repo.listRecentExpenses?.('apt-1', { limit: 1 });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await repo.listRecentExpenses?.('apt-1', { limit: 10_000 });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.Limit).toBe(500);
  });

  it('doldurma betigi: dizinsiz giderlere yalnizca GSI1 anahtarlarini ekler; tekrar calismasi guvenli', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-north-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }));
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ PK: 'APT#a', SK: 'EXP#e1', siteId: 'a', expenseId: 'e1', date: '2026-10-05' }], LastEvaluatedKey: { PK: 'x' } })
      .resolvesOnce({ Items: [{ PK: 'APT#a', SK: 'EXP#e2', siteId: 'a', expenseId: 'e2', date: '2026-10-06' }, { PK: 'APT#a', SK: 'EXP#e3', siteId: 'a', expenseId: 'e3' }] });
    ddb.on(UpdateCommand).resolvesOnce({}).rejectsOnce(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));

    const r = await backfillExpenseIndex({ client, tableName: 't', log: quiet });
    expect(r).toEqual({ found: 3, added: 1, alreadyIndexed: 1, skipped: 1 });
    expect(ddb.commandCalls(ScanCommand)[0]!.args[0].input).toMatchObject({ FilterExpression: 'entityType = :t AND attribute_not_exists(GSI1PK)' });
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { PK: 'APT#a', SK: 'EXP#e1' },
      UpdateExpression: 'SET GSI1PK = :pk, GSI1SK = :sk',
      ExpressionAttributeValues: { ':pk': 'EXPDATE#a', ':sk': '2026-10-05#e1' },
    });

    ddb.reset();
    ddb.on(ScanCommand).resolves({ Items: [{ PK: 'APT#a', SK: 'EXP#e9', siteId: 'a', expenseId: 'e9', date: '2026-10-07' }] });
    expect(await backfillExpenseIndex({ client, tableName: 't', log: quiet }, { dryRun: true })).toEqual({ found: 1, added: 0, alreadyIndexed: 0, skipped: 0 });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
