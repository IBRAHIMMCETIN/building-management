import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { FIX_ACTOR, fixReceivableNames, fixedReceivableName } from '../scripts/fix-receivable-names.js';
import { coOwnerReceivableName, receivableName } from '../src/modules/finance/service.js';

const ddb = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-north-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }));
const quiet = { info: () => {}, warn: () => {} };
const U1 = '17e1ba48-0c1d-4c3a-9a51-2f8d3b0e7a11';
const U2 = '2b9f5c10-77aa-4e0f-8d6c-0a1b2c3d4e5f';
const NOW = new Date('2026-11-25T09:00:00.000Z');

describe('alacak hesabi adi (Faz 1)', () => {
  it('yeni hesap adlari daire numarasi tasir', () => {
    expect(receivableName('5', 'owner')).toBe('Daire 5 - Kat Maliki');
    expect(receivableName('5', 'occupant')).toBe('Daire 5 - Kiracı/Sakin');
    expect(coOwnerReceivableName('A-12')).toBe('Daire A-12 - Kat Maliki (paydaş)');
  });

  it('eski bicimi taniyip donusturur; diger adlara dokunmaz', () => {
    expect(fixedReceivableName(`Daire ${U1} - Kat Maliki`, '5')).toBe('Daire 5 - Kat Maliki');
    expect(fixedReceivableName(`Daire ${U1} - Kiraci/Sakin`, '5')).toBe('Daire 5 - Kiracı/Sakin');
    expect(fixedReceivableName(`Daire ${U1} - Kat Maliki (paydaş)`, '5')).toBe('Daire 5 - Kat Maliki (paydaş)');
    expect(fixedReceivableName('Daire 5 - Kat Maliki', '5')).toBeUndefined();
    expect(fixedReceivableName('Daire 5 - Ayrılan sakin (31.10.2026)', '5')).toBeUndefined();
  });
});

describe('fix-receivable-names betigi', () => {
  beforeEach(() => ddb.reset());

  const page1 = [
    { PK: 'APT#a', SK: `ACCT#recv-${U1}-owner`, siteId: 'a', accountId: `recv-${U1}-owner`, unitId: U1, name: `Daire ${U1} - Kat Maliki` },
    { PK: 'APT#a', SK: 'ACCT#recv-x', siteId: 'a', accountId: 'recv-x', unitId: U1, name: 'Daire 5 - Kat Maliki' },
  ];
  const page2 = [
    { PK: 'APT#a', SK: `ACCT#recv-${U1}-occupant`, siteId: 'a', accountId: `recv-${U1}-occupant`, unitId: U1, name: `Daire ${U1} - Kiraci/Sakin` },
    { PK: 'APT#a', SK: `ACCT#recv-${U2}-owner`, siteId: 'a', accountId: `recv-${U2}-owner`, unitId: U2, name: `Daire ${U2} - Kat Maliki` },
  ];

  it('sayfalayarak tarar, yalnizca eski adlari kosullu olarak gunceller; daire yoksa atlar', async () => {
    ddb.on(ScanCommand).resolvesOnce({ Items: page1, LastEvaluatedKey: { PK: 'k' } }).resolvesOnce({ Items: page2 });
    ddb.on(GetCommand, { Key: { PK: 'APT#a', SK: `UNIT#${U1}` } }).resolves({ Item: { number: '5' } });
    ddb.on(GetCommand, { Key: { PK: 'APT#a', SK: `UNIT#${U2}` } }).resolves({});
    ddb.on(UpdateCommand).resolves({});

    const r = await fixReceivableNames({ client, tableName: 't', now: () => NOW, log: quiet });

    expect(r).toEqual({ scanned: 3, fixed: 2, skippedNoUnit: 1, alreadyFixed: 0 });
    // Ayni daire icin tek okuma (onbellek).
    expect(ddb.commandCalls(GetCommand)).toHaveLength(2);
    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      Key: { PK: 'APT#a', SK: `ACCT#recv-${U1}-owner` },
      ConditionExpression: 'attribute_exists(PK) AND #name = :old',
      ExpressionAttributeValues: { ':next': 'Daire 5 - Kat Maliki', ':old': `Daire ${U1} - Kat Maliki`, ':by': FIX_ACTOR, ':one': 1 },
    });
    expect(updates[1]?.ExpressionAttributeValues?.[':next']).toBe('Daire 5 - Kiracı/Sakin');
    expect(ddb.commandCalls(ScanCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'k' });
  });

  it('dry-run yazmaz; arada degismis kayit (kosul hatasi) sayilir ve atlanir', async () => {
    ddb.on(ScanCommand).resolves({ Items: page2.slice(0, 1) });
    ddb.on(GetCommand).resolves({ Item: { number: '5' } });
    const dry = await fixReceivableNames({ client, tableName: 't', log: quiet }, { dryRun: true });
    expect(dry.fixed).toBe(1);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);

    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const r = await fixReceivableNames({ client, tableName: 't', log: quiet });
    expect(r).toEqual({ scanned: 1, fixed: 0, skippedNoUnit: 0, alreadyFixed: 1 });
  });
});
