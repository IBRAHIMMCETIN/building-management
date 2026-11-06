import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Unit } from '../src/modules/core/types.js';
import {
  type MembershipRepository,
  createMembershipRepository,
  membershipKeys,
} from '../src/modules/memberships/repository.js';
import {
  assertNoConflicts,
  createMembershipService,
  periodsOverlap,
} from '../src/modules/memberships/service.js';
import type { PortalRepository } from '../src/modules/portal/repository.js';
import { createPortalService } from '../src/modules/portal/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const APT = 'apt-1';
const OTHER_APT = 'apt-2';
const ts = NOW.toISOString();
const audit = { createdAt: ts, createdBy: 'seed', updatedAt: ts, updatedBy: 'seed', version: 1 };

function unit(id: string, apt = APT, status: Unit['status'] = 'active'): Unit {
  return {
    PK: `APT#${apt}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    status,
    ...audit,
    unitId: id,
    siteId: apt,
    blockId: 'b1',
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
  };
}

/** Kosullu yazim semantigini taklit eden bellek ici depo. */
function createFakeRepo() {
  const items = new Map<string, UnitMembership>();
  const key = (apt: string, user: string, unitId: string) => `${apt}|${user}|${unitId}`;
  const repo: MembershipRepository = {
    get: async (apt, user, unitId) => items.get(key(apt, user, unitId)),
    list: async (apt, filter = {}) =>
      [...items.values()].filter((m) => m.apartmentId === apt && (!filter.unitId || m.unitId === filter.unitId)),
    create: async (m) => {
      const k = key(m.apartmentId, m.userId, m.unitId);
      if (items.has(k)) throw new DataAccessError('conflict', 'var');
      items.set(k, m);
    },
    update: async (m, expectedVersion) => {
      const k = key(m.apartmentId, m.userId, m.unitId);
      if (items.get(k)?.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      items.set(k, m);
    },
  };
  return { repo, items };
}

function setup() {
  const fake = createFakeRepo();
  const units = [unit('u1'), unit('u2'), unit('pasif', APT, 'inactive'), unit('x1', OTHER_APT)];
  const core: Pick<CoreRepository, 'getUnit' | 'getBlock' | 'getSite'> = {
    getUnit: async (apt, id) => units.find((u) => u.siteId === apt && u.unitId === id),
    getBlock: async () => undefined,
    getSite: async () => undefined,
  };
  const membershipService = createMembershipService({ repository: fake.repo, core, now: () => NOW });

  // Portal ayni uyelik deposunu okur: yonetici atamasi -> sakin erisimi uctan uca.
  const portalRepo: PortalRepository = {
    listMemberships: (apt, userId) => fake.repo.list(apt).then((l) => l.filter((m) => m.userId === userId)),
    listLedgerEntries: async () => [],
    getTransactions: async () => [],
    listUnitPayments: async () => [],
    listPublishedAnnouncements: async () => [],
  };
  const portalService = createPortalService({ repository: portalRepo, core, now: () => NOW });

  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    membershipService,
    portalService,
  });

  const token = (sub: string, role: string, apartmentId: string = APT) =>
    `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');

  const call = async (method: string, path: string, body?: unknown, auth = manager) => {
    // Kok yol `/api/memberships` (sondaki `/` olmadan).
    const res = await app.request(`/api/memberships${path.replace(/^\/(?=\?|$)/, '')}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const portal = (auth: string) => app.request('/api/portal/my-unit', { headers: { authorization: auth } });

  return { ...fake, app, call, token, manager, portal, membershipService };
}

const tenant = { userId: 'tenant-1', unitId: 'u1', relation: 'tenant', startDate: '2026-02-01' };
const owner = { userId: 'owner-1', unitId: 'u1', relation: 'owner', startDate: '2020-01-01' };

// ---------------------------------------------------------------------------

describe('memberships - saf kurallar', () => {
  const m = (over: Partial<UnitMembership>): UnitMembership =>
    ({
      userId: 'a',
      unitId: 'u1',
      apartmentId: APT,
      relation: 'owner',
      residesInUnit: false,
      status: 'active',
      startDate: '2026-01-01',
      ...over,
    }) as UnitMembership;

  it('periodsOverlap: bitis gunu dahil, acik uclu donemler', () => {
    expect(periodsOverlap({ startDate: '2026-01-01', endDate: '2026-03-31' }, { startDate: '2026-03-31' })).toBe(true);
    expect(periodsOverlap({ startDate: '2026-01-01', endDate: '2026-03-30' }, { startDate: '2026-03-31' })).toBe(false);
    expect(periodsOverlap({ startDate: '2026-01-01' }, { startDate: '2030-01-01' })).toBe(true);
  });

  it('oturan malik ile kiraci cakisamaz, ayni hanedeki iki kiraci cakisabilir', () => {
    const t = m({ userId: 't', relation: 'tenant', residesInUnit: true });
    expect(() => assertNoConflicts(t, [m({ userId: 'o', residesInUnit: true })])).toThrow(/oturan malik/);
    expect(() => assertNoConflicts(t, [m({ userId: 'o', residesInUnit: false })])).not.toThrow();
    expect(() => assertNoConflicts(t, [m({ userId: 't2', relation: 'tenant', residesInUnit: true })])).not.toThrow();
    // Donemler ayriysa sorun yok (once malik oturdu, sonra kiraya verdi)
    expect(() =>
      assertNoConflicts(t, [m({ userId: 'o', residesInUnit: true, endDate: '2025-12-31' })]),
    ).not.toThrow();
    // Pasif kayitlar dikkate alinmaz
    expect(() => assertNoConflicts(t, [m({ userId: 'o', residesInUnit: true, status: 'inactive' })])).not.toThrow();
  });

  it("hisse paylari toplami 1'i asamaz", () => {
    const half = { numerator: 1, denominator: 2 };
    const c = m({ userId: 'c', ownershipShare: { numerator: 2, denominator: 3 } });
    expect(() => assertNoConflicts(c, [m({ userId: 'a', ownershipShare: half })])).toThrow(/hisse/);
    expect(() =>
      assertNoConflicts(m({ userId: 'c', ownershipShare: half }), [m({ userId: 'a', ownershipShare: half })]),
    ).not.toThrow();
  });
});

describe('memberships - yetki ve tenant izolasyonu', () => {
  it('token yoksa 401, sakin/denetci yazamaz (403), denetci okuyabilir', async () => {
    const { app, call, token } = setup();
    expect((await app.request('/api/memberships')).status).toBe(401);
    expect((await call('POST', '/', tenant, token('r', 'resident'))).status).toBe(403);
    expect((await call('POST', '/', tenant, token('o', 'observer'))).status).toBe(403);
    expect((await call('GET', '/', undefined, token('r', 'resident'))).status).toBe(403);
    expect((await call('GET', '/', undefined, token('o', 'observer'))).status).toBe(200);
  });

  it('apartmentId claim yoksa 403', async () => {
    const { call, token } = setup();
    expect((await call('GET', '/', undefined, token('mgr', 'apartment_manager', ''))).status).toBe(403);
  });

  it('baska apartmanin dairesine atama yapilamaz (404) ve kayitlar apartmanlar arasi gorunmez', async () => {
    const { call, token } = setup();
    expect((await call('POST', '/', { ...tenant, unitId: 'x1' })).status).toBe(404);
    expect((await call('POST', '/', tenant)).status).toBe(201);

    const other = token('mgr-2', 'apartment_manager', OTHER_APT);
    expect((await call('GET', '/', undefined, other)).body.items).toEqual([]);
    expect((await call('GET', '/tenant-1/u1', undefined, other)).status).toBe(404);
    expect((await call('PATCH', '/tenant-1/u1', { version: 1, endDate: '2026-12-31' }, other)).status).toBe(404);
  });
});

describe('memberships - CRUD', () => {
  it('kiraci atar; varsayilanlar ve tenant alanlari claimden gelir', async () => {
    const { call, items } = setup();
    const res = await call('POST', '/', { ...tenant, apartmentId: 'apt-2' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: 'tenant-1',
      unitId: 'u1',
      apartmentId: APT,
      relation: 'tenant',
      residesInUnit: true,
      status: 'active',
      version: 1,
      createdBy: 'mgr-1',
      isCurrent: true,
      visibleParties: ['occupant'],
    });
    expect(res.body).not.toHaveProperty('PK');
    expect([...items.values()][0]!.SK).toBe('MEMBER#tenant-1#u1');
  });

  it('malik varsayilan olarak dairede oturmaz; hisse payi kabul edilir', async () => {
    const { call } = setup();
    const res = await call('POST', '/', { ...owner, ownershipShare: { numerator: 1, denominator: 2 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ residesInUnit: false, visibleParties: ['owner'] });
  });

  it.each([
    ['gecersiz relation', { ...tenant, relation: 'unit_owner' }],
    ['tarih bicimi', { ...tenant, startDate: '01.02.2026' }],
    ['olmayan tarih', { ...tenant, startDate: '2026-02-30' }],
    ['bitis baslangictan once', { ...tenant, endDate: '2026-01-01' }],
    ['kiraci oturmuyor', { ...tenant, residesInUnit: false }],
    ['kiraciya hisse', { ...tenant, ownershipShare: { numerator: 1, denominator: 2 } }],
    ['hisse > 1', { ...owner, ownershipShare: { numerator: 3, denominator: 2 } }],
    ['userId # iceriyor', { ...tenant, userId: 'a#b' }],
  ])('dogrulama hatasi: %s -> 400', async (_label, body) => {
    const { call } = setup();
    expect((await call('POST', '/', body)).status).toBe(400);
  });

  it('pasif daireye atama yapilamaz (404)', async () => {
    const { call } = setup();
    expect((await call('POST', '/', { ...tenant, unitId: 'pasif' })).status).toBe(404);
  });

  it('ayni kullanici + daire ikinci kez atanamaz (409)', async () => {
    const { call } = setup();
    await call('POST', '/', tenant);
    const res = await call('POST', '/', tenant);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/zaten atanmis/);
  });

  it('oturan malik varken kiraci eklenemez; malik oturmuyorsa eklenir', async () => {
    const { call } = setup();
    await call('POST', '/', { ...owner, residesInUnit: true });
    expect((await call('POST', '/', tenant)).status).toBe(409);

    // Malik tasindi (artik oturmuyor) -> kiraci eklenebilir.
    expect((await call('PATCH', '/owner-1/u1', { version: 1, residesInUnit: false })).status).toBe(200);
    expect((await call('POST', '/', tenant)).status).toBe(201);
  });

  it('listeleme filtreleri: unitId, userId, status, current', async () => {
    const { call } = setup();
    await call('POST', '/', owner);
    await call('POST', '/', tenant);
    await call('POST', '/', { userId: 'old', unitId: 'u1', relation: 'tenant', startDate: '2024-01-01', endDate: '2025-12-31' });
    await call('POST', '/', { userId: 'owner-2', unitId: 'u2', relation: 'owner', startDate: '2021-01-01' });
    await call('DELETE', '/owner-2/u2');

    const ids = (r: { body: Record<string, any> }) => r.body.items.map((m: any) => m.userId);
    expect(ids(await call('GET', '/?unitId=u1'))).toEqual(['owner-1', 'tenant-1', 'old']);
    expect(ids(await call('GET', '/?unitId=u1&current=true'))).toEqual(['owner-1', 'tenant-1']);
    expect(ids(await call('GET', '/?userId=owner-1'))).toEqual(['owner-1']);
    expect(ids(await call('GET', '/?status=inactive'))).toEqual(['owner-2']);
    expect((await call('GET', '/?status=hepsi')).status).toBe(400);
  });
});

describe('memberships - giris/cikis guncelleme ve iptal', () => {
  it('cikis tarihi (tasinma) girilir, surum artar; null ile temizlenir', async () => {
    const { call } = setup();
    await call('POST', '/', tenant);
    const moved = await call('PATCH', '/tenant-1/u1', { version: 1, endDate: '2026-10-31' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ endDate: '2026-10-31', version: 2, isCurrent: false, updatedBy: 'mgr-1' });

    const reopened = await call('PATCH', '/tenant-1/u1', { version: 2, endDate: null });
    expect(reopened.body).toMatchObject({ version: 3, isCurrent: true });
    expect(reopened.body.endDate).toBeUndefined();
  });

  it('eski surumle guncelleme 409 (optimistic locking)', async () => {
    const { call } = setup();
    await call('POST', '/', tenant);
    await call('PATCH', '/tenant-1/u1', { version: 1, startDate: '2026-03-01' });
    expect((await call('PATCH', '/tenant-1/u1', { version: 1, endDate: '2026-12-31' })).status).toBe(409);
  });

  it('relation ve status PATCH ile degistirilemez; bitis < baslangic reddedilir', async () => {
    const { call } = setup();
    await call('POST', '/', tenant);
    expect((await call('PATCH', '/tenant-1/u1', { version: 1, relation: 'owner' })).status).toBe(400);
    expect((await call('PATCH', '/tenant-1/u1', { version: 1, status: 'inactive' })).status).toBe(400);
    expect((await call('PATCH', '/tenant-1/u1', { version: 1, endDate: '2026-01-15' })).status).toBe(400);
  });

  it('guncelleme de cakisma kurallarini uygular', async () => {
    const { call } = setup();
    await call('POST', '/', { ...owner, residesInUnit: true, endDate: '2026-01-31' });
    await call('POST', '/', tenant); // 2026-02-01'den itibaren -> cakisma yok
    // Malikin cikisini kiraci donemine uzatmak cakisma yaratir.
    expect((await call('PATCH', '/owner-1/u1', { version: 1, endDate: '2026-06-30' })).status).toBe(409);
  });

  it('DELETE kaydi silmez, iptal eder; tekrar DELETE idempotent', async () => {
    const { call, items } = setup();
    await call('POST', '/', tenant);
    const first = await call('DELETE', '/tenant-1/u1');
    expect(first.body).toMatchObject({ status: 'inactive', version: 2, isCurrent: false });
    const second = await call('DELETE', '/tenant-1/u1');
    expect(second.body.version).toBe(2);
    expect(items.size).toBe(1);
  });

  it('olmayan uyelik 404', async () => {
    const { call } = setup();
    expect((await call('GET', '/yok/u1')).status).toBe(404);
    expect((await call('DELETE', '/yok/u1')).status).toBe(404);
  });
});

describe('memberships -> portal (uctan uca)', () => {
  it('atanan kiraci portala girer; cikis tarihi gecince ve iptalde erisim kapanir', async () => {
    const { call, portal, token } = setup();
    const resident = token('tenant-1', 'resident');
    expect((await portal(resident)).status).toBe(403);

    await call('POST', '/', tenant);
    expect((await portal(resident)).status).toBe(200);

    await call('PATCH', '/tenant-1/u1', { version: 1, endDate: '2026-11-05' });
    expect((await portal(resident)).status).toBe(403);

    await call('PATCH', '/tenant-1/u1', { version: 2, endDate: null });
    expect((await portal(resident)).status).toBe(200);
    await call('DELETE', '/tenant-1/u1');
    expect((await portal(resident)).status).toBe(403);
  });

  it('ileri tarihli baslangic bugun erisim vermez', async () => {
    const { call, portal, token } = setup();
    await call('POST', '/', { ...tenant, startDate: '2026-12-01' });
    expect((await portal(token('tenant-1', 'resident'))).status).toBe(403);
  });
});

describe('memberships repository (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = createMembershipRepository();

  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const item = (): UnitMembership => ({
    ...membershipKeys.membership(APT, 'tenant-1', 'u1'),
    entityType: 'UNIT_MEMBERSHIP',
    ...audit,
    userId: 'tenant-1',
    apartmentId: APT,
    unitId: 'u1',
    relation: 'tenant',
    residesInUnit: true,
    status: 'active',
    startDate: '2026-01-01',
  });

  it('create kosullu yazar; mevcut kayitta conflict', async () => {
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    await expect(repo.create(item())).rejects.toMatchObject({ code: 'conflict' });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('update surum kosulu ile yazar', async () => {
    ddb.on(PutCommand).resolves({});
    await repo.update({ ...item(), version: 2 }, 1);
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toContain('#version = :expectedVersion');
    expect(input.ExpressionAttributeValues).toEqual({ ':expectedVersion': 1 });
  });

  it('anahtar tutarsizligi yazimdan once reddedilir', async () => {
    await expect(repo.create({ ...item(), SK: 'MEMBER#baska#u1' })).rejects.toThrow(/tutarsiz/);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('list tenant partitioninda MEMBER# on ekiyle ve unitId filtresiyle sorgular', async () => {
    ddb.on(QueryCommand).resolves({ Items: [item()] });
    expect(await repo.list(APT, { unitId: 'u1' })).toHaveLength(1);
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'APT#apt-1', ':skp': 'MEMBER#', ':unitId': 'u1' });
    expect(input.FilterExpression).toBe('#unitId = :unitId');
  });
});
