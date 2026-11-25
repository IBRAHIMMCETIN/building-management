import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { createPreTokenHandler, type PreTokenGenerationEvent } from '../src/auth/preTokenGeneration.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import {
  type ApartmentRoleRepository,
  apartmentRoleGsi1,
  apartmentRoleKeys,
  createApartmentRoleRepository,
} from '../src/modules/apartment-roles/repository.js';
import { createApartmentRoleService } from '../src/modules/apartment-roles/service.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { Site } from '../src/modules/core/types.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const APT = 'apt-1';
const OTHER_APT = 'apt-2';
const ts = NOW.toISOString();

const site = (id: string, tenantId: string) =>
  ({ PK: `APT#${id}`, SK: 'SITE', entityType: 'SITE', siteId: id, tenantId, name: id }) as unknown as Site;

function createFakeRepo() {
  const items = new Map<string, ApartmentRole>();
  const k = (apt: string, user: string, role: string) => `${apt}|${user}|${role}`;
  const repo: ApartmentRoleRepository = {
    get: async (apt, user, role) => items.get(k(apt, user, role)),
    list: async (apt) => [...items.values()].filter((r) => r.apartmentId === apt),
    create: async (r) => {
      if (items.has(k(r.apartmentId, r.userId, r.role))) throw new DataAccessError('conflict', 'var');
      items.set(k(r.apartmentId, r.userId, r.role), r);
    },
    update: async (r, v) => {
      if (items.get(k(r.apartmentId, r.userId, r.role))?.version !== v) throw new DataAccessError('conflict', 'surum');
      items.set(k(r.apartmentId, r.userId, r.role), r);
    },
  };
  return { repo, items };
}

function setup() {
  const fake = createFakeRepo();
  const sites = [site(APT, 'org-1'), site(OTHER_APT, 'org-2')];
  const apartmentRoleService = createApartmentRoleService({
    repository: fake.repo,
    core: { getSite: async (id) => sites.find((s) => s.siteId === id) },
    now: () => NOW,
  });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), apartmentRoleService });
  const token = (sub: string, role: string, apartmentId = APT) =>
    `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');
  const company = token('cmp-1', 'management_company');

  const call = async (method: string, path: string, body?: unknown, auth = manager) => {
    const res = await app.request(`/api/apartment-roles${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { ...fake, app, call, token, manager, company };
}

// ---------------------------------------------------------------------------

describe('apartment-roles - yetki', () => {
  it('401 / sakin ve personel erisemez / denetci okur ama yazamaz', async () => {
    const { app, call, token } = setup();
    expect((await app.request('/api/apartment-roles')).status).toBe(401);
    for (const role of ['resident', 'building_staff', 'security_guard']) {
      expect((await call('GET', '', undefined, token('x', role))).status, role).toBe(403);
    }
    expect((await call('GET', '', undefined, token('o', 'observer'))).status).toBe(200);
    expect((await call('POST', '', { userId: 'u', role: 'observer' }, token('o', 'observer'))).status).toBe(403);
  });

  it('apartmentId claim yoksa 403; baska apartmanin kayitlari gorunmez', async () => {
    const { call, token } = setup();
    expect((await call('GET', '', undefined, token('m', 'apartment_manager', ''))).status).toBe(403);
    await call('POST', '', { userId: 'kapici-1', role: 'building_staff' });
    const other = token('mgr-2', 'apartment_manager', OTHER_APT);
    expect((await call('GET', '', undefined, other)).body.items).toEqual([]);
    expect((await call('DELETE', '/kapici-1/building_staff', undefined, other)).status).toBe(404);
  });

  it('yonetici yonetim firmasi yetkisi veremez (yetki yukseltme yok); firma verebilir', async () => {
    const { call, company } = setup();
    const res = await call('POST', '', { userId: 'u2', role: 'management_company' });
    expect(res.status).toBe(403);
    expect((await call('POST', '', { userId: 'u2', role: 'management_company' }, company)).status).toBe(201);
    // Yonetici, firma kaydini degistiremez/kaldiramaz.
    expect((await call('DELETE', '/u2/management_company')).status).toBe(403);
    expect((await call('PATCH', '/u2/management_company', { version: 1, endDate: '2026-12-31' })).status).toBe(403);
  });

  it('kimse kendi yetki kaydini degistiremez (kilitlenme korumasi)', async () => {
    const { call, company } = setup();
    await call('POST', '', { userId: 'mgr-1', role: 'apartment_manager' }, company);
    expect((await call('DELETE', '/mgr-1/apartment_manager')).status).toBe(403);
    expect((await call('POST', '', { userId: 'mgr-1', role: 'observer' })).status).toBe(403);
  });

  it('platform_admin ve resident rolleri atanamaz (400)', async () => {
    const { call, company } = setup();
    expect((await call('POST', '', { userId: 'u', role: 'platform_admin' }, company)).status).toBe(400);
    expect((await call('POST', '', { userId: 'u', role: 'resident' }, company)).status).toBe(400);
  });
});

describe('apartment-roles - CRUD', () => {
  it('yonetici personel atar; varsayilan baslangic bugun; tenant claimden', async () => {
    const { call, items } = setup();
    const res = await call('POST', '', {
      userId: 'kapici-1',
      role: 'building_staff',
      displayName: 'Ali - Kapici',
      apartmentId: OTHER_APT,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: 'kapici-1',
      role: 'building_staff',
      apartmentId: APT,
      startDate: '2026-11-06',
      status: 'active',
      isCurrent: true,
      displayName: 'Ali - Kapici',
      createdBy: 'mgr-1',
    });
    expect(res.body.organizationId).toBeUndefined();
    expect([...items.values()][0]!.SK).toBe('ROLE#kapici-1#building_staff');
  });

  it('management_company kaydi sitenin firmasini (organizationId) tasir', async () => {
    const { call, company } = setup();
    const res = await call('POST', '', { userId: 'cmp-2', role: 'management_company' }, company);
    expect(res.body.organizationId).toBe('org-1');
  });

  it('ayni kullanici + rol ikinci kez 409; ayni kullaniciya farkli rol verilebilir', async () => {
    const { call } = setup();
    expect((await call('POST', '', { userId: 'u1', role: 'observer' })).status).toBe(201);
    expect((await call('POST', '', { userId: 'u1', role: 'observer' })).status).toBe(409);
    expect((await call('POST', '', { userId: 'u1', role: 'security_guard' })).status).toBe(201);
  });

  it.each([
    ['gecersiz rol', { userId: 'u', role: 'auditor' }],
    ['gecersiz tarih', { userId: 'u', role: 'observer', startDate: '2026-13-01' }],
    ['bitis < baslangic', { userId: 'u', role: 'observer', startDate: '2026-11-01', endDate: '2026-10-01' }],
    ['userId #', { userId: 'a#b', role: 'observer' }],
  ])('400: %s', async (_l, body) => {
    const { call } = setup();
    expect((await call('POST', '', body)).status).toBe(400);
  });

  it('guncelleme: bitis tarihi, surum kontrolu, degistirilemez alanlar', async () => {
    const { call } = setup();
    await call('POST', '', { userId: 'u1', role: 'observer', startDate: '2026-01-01' });
    const ended = await call('PATCH', '/u1/observer', { version: 1, endDate: '2026-11-05' });
    expect(ended.body).toMatchObject({ endDate: '2026-11-05', isCurrent: false, version: 2 });
    expect((await call('PATCH', '/u1/observer', { version: 1, endDate: null })).status).toBe(409);
    expect((await call('PATCH', '/u1/observer', { version: 2, role: 'security_guard' })).status).toBe(400);
    expect((await call('PATCH', '/u1/observer', { version: 2, status: 'active' })).status).toBe(400);
    const reopened = await call('PATCH', '/u1/observer', { version: 2, endDate: null });
    expect(reopened.body).toMatchObject({ isCurrent: true, version: 3 });
  });

  it('DELETE pasife alir, idempotenttir; listeleme filtreleri', async () => {
    const { call, items } = setup();
    await call('POST', '', { userId: 'u1', role: 'observer' });
    await call('POST', '', { userId: 'u2', role: 'building_staff' });
    expect((await call('DELETE', '/u1/observer')).body).toMatchObject({ status: 'inactive', version: 2 });
    expect((await call('DELETE', '/u1/observer')).body.version).toBe(2);
    expect(items.size).toBe(2);

    const ids = async (q: string) => (await call('GET', q)).body.items.map((r: any) => `${r.userId}:${r.role}`);
    expect(await ids('')).toEqual(['u2:building_staff']);
    expect(await ids('?status=all')).toEqual(['u2:building_staff', 'u1:observer']);
    expect(await ids('?status=inactive&role=observer')).toEqual(['u1:observer']);
    expect((await call('GET', '?role=auditor')).status).toBe(400);
  });

  it('olmayan kayit 404, gecersiz rol yolu 400', async () => {
    const { call } = setup();
    expect((await call('GET', '/yok/observer')).status).toBe(404);
    expect((await call('GET', '/u1/superuser')).status).toBe(400);
  });
});

describe('apartment-roles -> pre token (uctan uca)', () => {
  it('atanan yonetici rolu token claimine yansir; kaldirilinca yansimaz', async () => {
    const { call, items, company } = setup();
    await call('POST', '', { userId: 'mgr-9', role: 'apartment_manager' }, company);

    // GSI1 sorgusunun dondurecegi kayitlar (gercek depo GSI1PK = USER#mgr-9 yazar).
    const handler = createPreTokenHandler({
      loadGrantItems: async (userId) => [...items.values()].filter((r) => r.userId === userId),
      now: () => NOW,
      log: { info: () => {} },
    });
    const event = (): PreTokenGenerationEvent => ({
      version: '1',
      triggerSource: 'TokenGeneration_Authentication',
      userName: 'mgr-9',
      request: { userAttributes: { sub: 'mgr-9' } },
      response: {},
    });

    const granted = await handler(event());
    expect(granted.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      role: 'apartment_manager',
      apartmentId: APT,
    });

    // Son yonetici korumasi (Faz 1): kaldirmadan once ikinci yonetici atanir.
    await call('POST', '', { userId: 'mgr-8', role: 'apartment_manager' }, company);
    expect((await call('DELETE', '/mgr-9/apartment_manager', undefined, company)).status).toBe(200);
    const revoked = await handler(event());
    expect(revoked.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({});
  });
});

describe('apartment-roles repository (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const record: ApartmentRole = {
    ...apartmentRoleKeys.role(APT, 'u1', 'observer'),
    entityType: 'APARTMENT_ROLE',
    createdAt: ts,
    createdBy: 's',
    updatedAt: ts,
    updatedBy: 's',
    version: 1,
    userId: 'u1',
    apartmentId: APT,
    role: 'observer',
    status: 'active',
    startDate: '2026-01-01',
  };

  it('GSI1 alanlarini yazar, okumada ayiklar; anahtar tutarsizligini reddeder', async () => {
    expect(apartmentRoleGsi1(record)).toEqual({ GSI1PK: 'USER#u1', GSI1SK: 'APT#apt-1#ROLE#observer' });
    ddb.on(PutCommand).resolves({});
    const repo = createApartmentRoleRepository();
    await repo.create(record);
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item).toMatchObject({ GSI1PK: 'USER#u1', GSI1SK: 'APT#apt-1#ROLE#observer', SK: 'ROLE#u1#observer' });
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');

    ddb.on(QueryCommand).resolves({ Items: [{ ...record, ...apartmentRoleGsi1(record) }] });
    const [listed] = await repo.list(APT);
    expect(listed).not.toHaveProperty('GSI1PK');
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toMatchObject({ ':skp': 'ROLE#' });

    await expect(repo.create({ ...record, role: 'security_guard' })).rejects.toThrow(/tutarsiz/);
  });
});
