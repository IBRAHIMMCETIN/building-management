import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PreTokenGenerationEvent,
  createPreTokenHandler,
  queryGrantItems,
  selectContext,
  toGrants,
} from '../src/auth/preTokenGeneration.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { createMembershipRepository, membershipGsi1, membershipKeys } from '../src/modules/memberships/repository.js';
import type { UnitMembership } from '../src/modules/portal/types.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const quiet = { info: () => {} };

function event(attrs: Record<string, string>, groups: string[] = []): PreTokenGenerationEvent {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_Authentication',
    userName: 'u',
    request: { userAttributes: { sub: 'user-1', ...attrs }, groupConfiguration: { groupsToOverride: groups } },
    response: { claimsAndScopeOverrideDetails: null },
  };
}

const unitGrant = (apartmentId: string, over: object = {}) => ({
  entityType: 'UNIT_MEMBERSHIP',
  apartmentId,
  status: 'active',
  startDate: '2026-01-01',
  ...over,
});
const roleGrant = (apartmentId: string, role: string, over: object = {}) => ({
  entityType: 'APARTMENT_ROLE',
  apartmentId,
  role,
  status: 'active',
  ...over,
});

function run(items: object[], attrs: Record<string, string> = {}, groups: string[] = []) {
  const handler = createPreTokenHandler({ loadGrantItems: async () => items, now: () => NOW, log: quiet });
  return handler(event(attrs, groups));
}

const accessClaims = (e: PreTokenGenerationEvent) =>
  e.response.claimsAndScopeOverrideDetails?.accessTokenGeneration;

// ---------------------------------------------------------------------------

describe('pre token generation - yetki cozumleme', () => {
  it('toGrants: yalnizca aktif ve bugun gecerli kayitlar; platform_admin ve bilinmeyen roller yok sayilir', () => {
    const grants = toGrants(
      [
        unitGrant('a1'),
        unitGrant('a2', { endDate: '2026-10-31' }),
        unitGrant('a3', { startDate: '2026-12-01' }),
        unitGrant('a4', { status: 'inactive' }),
        roleGrant('a1', 'apartment_manager', { organizationId: 'org-1' }),
        roleGrant('a1', 'platform_admin'),
        roleGrant('a1', 'superuser'),
        { entityType: 'UNIT_MEMBERSHIP', status: 'active' },
      ],
      '2026-11-06',
    );
    expect(grants).toEqual([
      { apartmentId: 'a1', role: 'resident' },
      { apartmentId: 'a1', role: 'apartment_manager', organizationId: 'org-1' },
    ]);
  });

  it('selectContext: tek apartman otomatik; birden fazlada tercih gerekir; tercih yetkiye dayanmalidir', () => {
    const one = [{ apartmentId: 'a1', role: 'resident' as const }];
    expect(selectContext(one, {})).toEqual(one[0]);
    expect(selectContext(one, { apartmentId: 'baska' })).toEqual(one[0]);

    const two = [...one, { apartmentId: 'a2', role: 'observer' as const }];
    expect(selectContext(two, {})).toBeUndefined();
    expect(selectContext(two, { apartmentId: 'a2' })?.role).toBe('observer');
    expect(selectContext(two, { apartmentId: 'a3' })).toBeUndefined();
  });

  it('selectContext: ayni apartmanda tercih edilen rol, yoksa en yetkili rol', () => {
    const grants = [
      { apartmentId: 'a1', role: 'resident' as const },
      { apartmentId: 'a1', role: 'apartment_manager' as const },
    ];
    expect(selectContext(grants, {})?.role).toBe('apartment_manager');
    expect(selectContext(grants, { role: 'resident' })?.role).toBe('resident');
    expect(selectContext(grants, { role: 'observer' })?.role).toBe('apartment_manager');
  });
});

describe('pre token generation - handler', () => {
  it('tek apartmanli sakin icin access ve id token a claim ekler', async () => {
    const out = await run([unitGrant('apt-1')]);
    const expected = { claimsToAddOrOverride: { role: 'resident', apartmentId: 'apt-1' }, claimsToSuppress: ['organizationId'] };
    expect(accessClaims(out)).toEqual(expected);
    expect(out.response.claimsAndScopeOverrideDetails?.idTokenGeneration).toEqual(expected);
  });

  it('custom:active_apartment ile secilen apartman ve rol; organizationId tasinir', async () => {
    const out = await run(
      [unitGrant('apt-1'), roleGrant('apt-2', 'apartment_manager', { organizationId: 'org-9' })],
      { 'custom:active_apartment': 'apt-2' },
    );
    expect(accessClaims(out)?.claimsToAddOrOverride).toEqual({
      role: 'apartment_manager',
      apartmentId: 'apt-2',
      organizationId: 'org-9',
    });
  });

  it('yetkisi olmayan apartman secimi claim uretmez; istemci claimleri bastirilir', async () => {
    const out = await run([unitGrant('apt-1'), unitGrant('apt-2')], { 'custom:active_apartment': 'apt-x' });
    expect(accessClaims(out)).toEqual({
      claimsToAddOrOverride: {},
      claimsToSuppress: ['role', 'apartmentId', 'organizationId'],
    });
  });

  it('V1_0 (Lite) olayinda claimler claimsOverrideDetails ile yalnizca ID tokena eklenir', async () => {
    const handler = createPreTokenHandler({ loadGrantItems: async () => [unitGrant('apt-1')], now: () => NOW, log: quiet });
    const out = await handler({ ...event({}), version: '1' });
    expect(out.response.claimsOverrideDetails).toEqual({
      claimsToAddOrOverride: { role: 'resident', apartmentId: 'apt-1' },
      claimsToSuppress: ['organizationId'],
    });
    expect(out.response.claimsAndScopeOverrideDetails).toBeUndefined();
  });

  it('rol yalnizca APARTMENT_ROLE kayitlarindan gelir; resident rolu bu yolla verilemez', () => {
    const grants = toGrants(
      [
        { entityType: 'NOTIFICATION', apartmentId: 'a1', role: 'apartment_manager', status: 'active' },
        roleGrant('a1', 'resident'),
        roleGrant('a1', 'security_guard'),
      ],
      '2026-11-06',
    );
    expect(grants).toEqual([{ apartmentId: 'a1', role: 'security_guard', organizationId: undefined }]);
  });

  it('platform_admin yalnizca Cognito groupundan gelir, DynamoDB okunmaz', async () => {
    const loadGrantItems = vi.fn(async () => []);
    const handler = createPreTokenHandler({ loadGrantItems, now: () => NOW, log: quiet });
    const out = await handler(event({}, ['platform_admin']));
    expect(accessClaims(out)?.claimsToAddOrOverride).toEqual({ role: 'platform_admin' });
    expect(loadGrantItems).not.toHaveBeenCalled();
  });

  it('DynamoDB hatasinda giris basarisiz olur (fail closed)', async () => {
    const handler = createPreTokenHandler({
      loadGrantItems: async () => {
        throw new Error('ddb down');
      },
      log: quiet,
    });
    await expect(handler(event({}))).rejects.toThrow('ddb down');
  });

  it('queryGrantItems GSI1 i USER#<sub> ile sayfalayarak sorgular', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [unitGrant('a1')], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [unitGrant('a2')] });
    const items = await queryGrantItems('user-1', 'GSI1', { client: { send } as never, tableName: 'tbl' });
    expect(items).toHaveLength(2);
    const first = send.mock.calls[0]![0] as QueryCommand;
    expect(first.input).toMatchObject({
      TableName: 'tbl',
      IndexName: 'GSI1',
      ExpressionAttributeValues: { ':pk': 'USER#user-1' },
    });
    expect((send.mock.calls[1]![0] as QueryCommand).input.ExclusiveStartKey).toEqual({ k: 1 });
  });
});

describe('uyelik kayitlari GSI1 alanlarini yazar', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const m: UnitMembership = {
    ...membershipKeys.membership('apt-1', 'user-1', 'u1'),
    entityType: 'UNIT_MEMBERSHIP',
    createdAt: NOW.toISOString(),
    createdBy: 's',
    updatedAt: NOW.toISOString(),
    updatedBy: 's',
    version: 1,
    userId: 'user-1',
    apartmentId: 'apt-1',
    unitId: 'u1',
    relation: 'tenant',
    residesInUnit: true,
    status: 'active',
    startDate: '2026-01-01',
  };

  it('create/update GSI1PK=USER#, GSI1SK=APT#..#UNIT#.. ekler; okumada ayiklanir', async () => {
    expect(membershipGsi1(m)).toEqual({ GSI1PK: 'USER#user-1', GSI1SK: 'APT#apt-1#UNIT#u1' });
    ddb.on(PutCommand).resolves({});
    const repo = createMembershipRepository();
    await repo.create(m);
    await repo.update({ ...m, version: 2 }, 1);
    for (const call of ddb.commandCalls(PutCommand)) {
      expect(call.args[0].input.Item).toMatchObject({ GSI1PK: 'USER#user-1', GSI1SK: 'APT#apt-1#UNIT#u1' });
    }

    ddb.on(QueryCommand).resolves({ Items: [{ ...m, ...membershipGsi1(m) }] });
    const [listed] = await repo.list('apt-1');
    expect(listed).not.toHaveProperty('GSI1PK');
    expect(listed).toMatchObject({ userId: 'user-1' });
  });
});

describe('lambda giris noktasi', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it('API Gateway v2 olayini Hono ya aktarir; authorizer claimleri kullanilir', async () => {
    Object.assign(process.env, {
      AUTH_MODE: 'apigw',
      EVENTS_MODE: 'none',
      NODE_ENV: 'production',
      APP_VERSION: 'v-test',
    });
    const { handler } = await import('../src/lambda.js');
    const ev = (path: string, claims?: Record<string, string>) =>
      ({
        version: '2.0',
        routeKey: '$default',
        rawPath: path,
        rawQueryString: '',
        headers: { host: 'api.example.com' },
        isBase64Encoded: false,
        requestContext: {
          http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '1.1.1.1', userAgent: 't' },
          domainName: 'api.example.com',
          requestId: 'r',
          stage: '$default',
          ...(claims ? { authorizer: { jwt: { claims, scopes: null } } } : {}),
        },
      }) as never;

    const health = (await handler(ev('/api/health'), {} as never)) as { statusCode: number; body: string };
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).version).toBe('v-test');

    const noAuth = (await handler(ev('/api/portal/my-unit'), {} as never)) as { statusCode: number };
    expect(noAuth.statusCode).toBe(401);

    const wrongRole = (await handler(
      ev('/api/portal/my-unit', { sub: 'u', role: 'observer', apartmentId: 'a' }),
      {} as never,
    )) as { statusCode: number };
    expect(wrongRole.statusCode).toBe(403);
  });

  it('production da EVENTS_MODE yoksa soguk baslangicta hata verir', async () => {
    Object.assign(process.env, { AUTH_MODE: 'apigw', NODE_ENV: 'production' });
    delete process.env.EVENTS_MODE;
    await expect(import('../src/lambda.js')).rejects.toThrow(/EVENTS_MODE/);
  });
});
