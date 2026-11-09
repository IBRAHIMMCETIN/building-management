import {
  ConditionalCheckFailedException,
  ProvisionedThroughputExceededException,
  RequestLimitExceeded,
  ResourceNotFoundException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DataAccessError,
  loadDynamoConfig,
  queryTenant,
  resetDynamoCache,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../src/config/dynamodb.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  resetDynamoCache();
  vi.stubEnv('DYNAMODB_TABLE_NAME', 'bm-test-table');
  vi.stubEnv('AWS_REGION', 'eu-central-1');
  vi.stubEnv('DYNAMODB_ENDPOINT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const meta = { $metadata: {} };

function lastQueryInput() {
  const calls = ddbMock.commandCalls(QueryCommand);
  expect(calls).toHaveLength(1);
  return calls[0]!.args[0].input;
}

describe('tenantPk / skKey', () => {
  it('APT#<apartmentId> formatinda PK uretir', () => {
    expect(tenantPk('apt-123')).toBe('APT#apt-123');
  });

  it('farkli apartmanlar farkli PK uretir', () => {
    expect(tenantPk('a')).not.toBe(tenantPk('b'));
  });

  it.each([[''], ['apt#1'], ['#']])('gecersiz apartmentId reddedilir: %j', (id) => {
    expect(() => tenantPk(id)).toThrow(/apartmentId/);
  });

  it('skKey parcalari # ile birlestirir', () => {
    expect(skKey('UNIT', 'u1')).toBe('UNIT#u1');
    expect(skKey('LEDGER', 'u1', '2026-11')).toBe('LEDGER#u1#2026-11');
    expect(skKey('SITE')).toBe('SITE');
  });

  it('skKey bos veya # iceren parcayi reddeder', () => {
    expect(() => skKey('UNIT', '')).toThrow();
    expect(() => skKey('UNIT', 'a#b')).toThrow();
  });
});

describe('loadDynamoConfig', () => {
  it('tablo adi yoksa hata verir', () => {
    expect(() => loadDynamoConfig({ AWS_REGION: 'eu-central-1' })).toThrow(/DYNAMODB_TABLE_NAME/);
  });

  it('region yoksa hata verir', () => {
    expect(() => loadDynamoConfig({ DYNAMODB_TABLE_NAME: 't' })).toThrow(/AWS_REGION/);
  });

  it('AWS_DEFAULT_REGION yedegini kullanir ve endpoint opsiyoneldir', () => {
    expect(loadDynamoConfig({ DYNAMODB_TABLE_NAME: 't', AWS_DEFAULT_REGION: 'eu-west-1' })).toEqual({
      tableName: 't',
      region: 'eu-west-1',
    });
    expect(
      loadDynamoConfig({
        DYNAMODB_TABLE_NAME: 't',
        AWS_REGION: 'eu-west-1',
        DYNAMODB_ENDPOINT: 'http://localhost:8000',
      }).endpoint,
    ).toBe('http://localhost:8000');
  });
});

describe('queryTenant - tenant izolasyonu', () => {
  it('her zaman ilgili apartmentId PK ile sorgular', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'APT#apt-1', SK: 'UNIT#u1' }] });

    const { items } = await queryTenant('apt-1');

    const input = lastQueryInput();
    expect(input.TableName).toBe('bm-test-table');
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#pk': 'PK' });
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'APT#apt-1' });
    expect(items).toEqual([{ PK: 'APT#apt-1', SK: 'UNIT#u1' }]);
  });

  it('skPrefix ile begins_with kosulu ekler, PK degismez', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await queryTenant('apt-2', { skPrefix: 'UNIT#' });

    const input = lastQueryInput();
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :skp)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'APT#apt-2', ':skp': 'UNIT#' });
  });

  it('filterValues ile :pk ezilemez (baska apartmana sizinti engellenir)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await queryTenant('apt-1', {
      filterNames: { '#pk': 'siteId', '#st': 'status' },
      filterValues: { ':pk': 'APT#baska-apartman', ':s': 'active' },
      FilterExpression: '#st = :s',
    });

    const input = lastQueryInput();
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'APT#apt-1', ':s': 'active' });
    expect(input.ExpressionAttributeNames).toMatchObject({ '#pk': 'PK', '#st': 'status' });
  });

  it('cagiran Query girdisi ile KeyConditionExpression/TableName ezemez', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await queryTenant('apt-1', {
      // Tipler engeller; calisma zamaninda zorlansa bile ezilmemeli.
      ...({
        TableName: 'baska-tablo',
        KeyConditionExpression: 'PK = :x',
      } as object),
    });

    const input = lastQueryInput();
    expect(input.TableName).toBe('bm-test-table');
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
  });

  it('gecersiz apartmentId ile DynamoDB cagrisi yapilmaz', async () => {
    await expect(queryTenant('apt#1')).rejects.toThrow(/apartmentId/);
    await expect(queryTenant('')).rejects.toThrow(/apartmentId/);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('sayfalama anahtarini dondurur ve Items yoksa bos liste verir', async () => {
    ddbMock.on(QueryCommand).resolvesOnce({ LastEvaluatedKey: { PK: 'APT#apt-1', SK: 'UNIT#u9' } });

    const result = await queryTenant('apt-1', { Limit: 1 });

    expect(result.items).toEqual([]);
    expect(result.lastKey).toEqual({ PK: 'APT#apt-1', SK: 'UNIT#u9' });
    expect(lastQueryInput().Limit).toBe(1);
  });
});

describe('DataAccessError esleme', () => {
  const cases: Array<[string, () => unknown, DataAccessError['code'], number]> = [
    [
      'ConditionalCheckFailedException',
      () => new ConditionalCheckFailedException({ message: 'x', ...meta }),
      'conflict',
      409,
    ],
    [
      'ResourceNotFoundException',
      () => new ResourceNotFoundException({ message: 'x', ...meta }),
      'not_found',
      404,
    ],
    [
      'TransactionCanceledException',
      () =>
        new TransactionCanceledException({
          message: 'x',
          ...meta,
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      'transaction_failed',
      409,
    ],
    [
      'ProvisionedThroughputExceededException',
      () => new ProvisionedThroughputExceededException({ message: 'x', ...meta }),
      'throttled',
      503,
    ],
    [
      'RequestLimitExceeded',
      () => new RequestLimitExceeded({ message: 'x', ...meta }),
      'throttled',
      503,
    ],
    ['bilinmeyen hata', () => new Error('boom'), 'internal', 500],
    ['Error olmayan deger', () => 'string-hata', 'internal', 500],
  ];

  it.each(cases)('%s -> DataAccessError', (_name, make, code, status) => {
    const original = make();
    const mapped = toDataAccessError(original);

    expect(mapped).toBeInstanceOf(DataAccessError);
    expect(mapped.code).toBe(code);
    expect(mapped.httpStatus).toBe(status);
    expect(mapped.cause).toBe(original);
  });

  it('TransactionCanceled iptal nedenlerini mesaja yazar', () => {
    const err = new TransactionCanceledException({
      message: 'x',
      ...meta,
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    expect(toDataAccessError(err).message).toContain('ConditionalCheckFailed,None');
  });

  it('DataAccessError ikinci kez sarmalanmaz', () => {
    const existing = new DataAccessError('not_found', 'yok');
    expect(toDataAccessError(existing)).toBe(existing);
  });

  it('queryTenant SDK hatasini DataAccessError olarak firlatir', async () => {
    ddbMock.on(QueryCommand).rejects(new ProvisionedThroughputExceededException({ message: 'x', ...meta }));

    const err = await queryTenant('apt-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DataAccessError);
    expect(err).toMatchObject({ code: 'throttled', httpStatus: 503 });
  });

  it('queryTenant kaynak bulunamadi hatasini 404 yapar', async () => {
    ddbMock.on(QueryCommand).rejects(new ResourceNotFoundException({ message: 'x', ...meta }));

    await expect(queryTenant('apt-1')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });
});
