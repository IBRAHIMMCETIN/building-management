import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import { type EventPublisher, createInMemoryEventPublisher } from '../src/events/publisher.js';
import {
  type AnnouncementRepository,
  announcementKeys,
  createAnnouncementRepository,
} from '../src/modules/announcements/repository.js';
import { createAnnouncementService } from '../src/modules/announcements/service.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Block, Unit } from '../src/modules/core/types.js';
import type { PortalRepository } from '../src/modules/portal/repository.js';
import { createPortalService } from '../src/modules/portal/service.js';
import type { Announcement, UnitMembership } from '../src/modules/portal/types.js';

const APT = 'apt-1';
const OTHER_APT = 'apt-2';
const T0 = new Date('2026-11-06T10:00:00.000Z');
const seedAudit = { createdAt: T0.toISOString(), createdBy: 'seed', updatedAt: T0.toISOString(), updatedBy: 'seed', version: 1 };

function block(id: string, status: Block['status'] = 'active'): Block {
  return { PK: `APT#${APT}`, SK: `BLOCK#${id}`, entityType: 'BLOCK', status, ...seedAudit, blockId: id, siteId: APT, name: id };
}

function createFakeRepo() {
  const items = new Map<string, Announcement>();
  const k = (apt: string, id: string) => `${apt}|${id}`;
  const repo: AnnouncementRepository = {
    get: async (apt, id) => items.get(k(apt, id)),
    list: async (apt) => [...items.values()].filter((a) => a.apartmentId === apt),
    create: async (a) => {
      if (items.has(k(a.apartmentId, a.announcementId))) throw new DataAccessError('conflict', 'var');
      items.set(k(a.apartmentId, a.announcementId), a);
    },
    update: async (a, expectedVersion) => {
      if (items.get(k(a.apartmentId, a.announcementId))?.version !== expectedVersion) {
        throw new DataAccessError('conflict', 'surum');
      }
      items.set(k(a.apartmentId, a.announcementId), a);
    },
  };
  return { repo, items };
}

function setup(options: { events?: EventPublisher } = {}) {
  let now = T0;
  const clock = { set: (iso: string) => void (now = new Date(iso)) };
  const fake = createFakeRepo();
  const events = options.events ?? createInMemoryEventPublisher();
  const blocks = [block('b1'), block('b2'), block('eski', 'inactive')];
  const units: Unit[] = [
    { PK: `APT#${APT}`, SK: 'UNIT#u1', entityType: 'UNIT', status: 'active', ...seedAudit, unitId: 'u1', siteId: APT, blockId: 'b1', number: '1', type: 'flat', grossAreaTenthsM2: 900, exemptions: [] },
  ];
  const core: Pick<CoreRepository, 'getBlock' | 'getUnit' | 'getSite'> = {
    getBlock: async (apt, id) => blocks.find((b) => b.siteId === apt && b.blockId === id),
    getUnit: async (apt, id) => units.find((u) => u.siteId === apt && u.unitId === id),
    getSite: async () => undefined,
  };
  let n = 0;
  const announcementService = createAnnouncementService({
    repository: fake.repo,
    core,
    now: () => now,
    newId: () => `ann${++n}`,
    events,
  });

  const membership: UnitMembership = {
    PK: `APT#${APT}`, SK: 'MEMBER#res-1#u1', entityType: 'UNIT_MEMBERSHIP', ...seedAudit,
    userId: 'res-1', apartmentId: APT, unitId: 'u1', relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01',
  };
  const portalRepo: PortalRepository = {
    listMemberships: async (apt, user) => (apt === APT && user === 'res-1' ? [membership] : []),
    listLedgerEntries: async () => [],
    getTransactions: async () => [],
    listUnitPayments: async () => [],
    listPublishedAnnouncements: (apt) => fake.repo.list(apt).then((l) => l.filter((a) => a.status === 'published')),
  };
  const portalService = createPortalService({ repository: portalRepo, core, now: () => now });

  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    announcementService,
    portalService,
  });

  const token = (sub: string, role: string, apartmentId = APT) =>
    `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');

  const call = async (method: string, path: string, body?: unknown, auth = manager) => {
    const res = await app.request(`/api/announcements${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const residentFeed = async () => {
    const res = await app.request('/api/portal/announcements', { headers: { authorization: token('res-1', 'resident') } });
    return ((await res.json()) as any).items.map((a: any) => a.announcementId);
  };

  return { ...fake, app, call, token, events, clock, residentFeed };
}

const draft = { title: 'Su kesintisi', body: 'Yarin 10:00-14:00 arasi su kesilecektir.' };

// ---------------------------------------------------------------------------

describe('announcements - yetki', () => {
  it('401 / 403 / denetci salt okunur', async () => {
    const { app, call, token } = setup();
    expect((await app.request('/api/announcements')).status).toBe(401);
    expect((await call('POST', '', draft, token('r', 'resident'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('r', 'resident'))).status).toBe(403);
    expect((await call('POST', '', draft, token('o', 'observer'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('o', 'observer'))).status).toBe(200);
    expect((await call('POST', '', draft, token('m', 'management_company'))).status).toBe(201);
  });

  it('apartmentId claim yoksa 403; baska apartmanin duyurusu gorunmez/onaylanamaz', async () => {
    const { call, token } = setup();
    expect((await call('GET', '', undefined, token('m', 'apartment_manager', ''))).status).toBe(403);
    await call('POST', '', draft);
    const other = token('mgr-2', 'apartment_manager', OTHER_APT);
    expect((await call('GET', '', undefined, other)).body.items).toEqual([]);
    expect((await call('GET', '/ann1', undefined, other)).status).toBe(404);
    expect((await call('POST', '/ann1/approve', { version: 1 }, other)).status).toBe(404);
  });
});

describe('announcements - olusturma ve dogrulama', () => {
  it('taslak olusturur; publishAt varsayilan simdi, apartman claimden', async () => {
    const { call, items } = setup();
    const res = await call('POST', '', { ...draft, apartmentId: OTHER_APT, status: 'published' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      announcementId: 'ann1',
      apartmentId: APT,
      status: 'draft',
      publishAt: T0.toISOString(),
      createdBy: 'mgr-1',
      version: 1,
    });
    expect(res.body).not.toHaveProperty('PK');
    expect(res.body.approvedAt).toBeUndefined();
    expect(items.get(`${APT}|ann1`)!.SK).toBe('ANN#ann1');
  });

  it('saat dilimli tarih UTC ye normalize edilir; blockIds tekillestirilir', async () => {
    const { call } = setup();
    const res = await call('POST', '', {
      ...draft,
      publishAt: '2026-11-10T09:00:00+03:00',
      expiresAt: '2026-11-11T09:00:00+03:00',
      blockIds: ['b2', 'b1', 'b2'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      publishAt: '2026-11-10T06:00:00.000Z',
      expiresAt: '2026-11-11T06:00:00.000Z',
      blockIds: ['b1', 'b2'],
    });
  });

  it.each([
    ['baslik yok', { body: 'x' }],
    ['govde yok', { title: 'x' }],
    ['baslik cok uzun', { ...draft, title: 'x'.repeat(151) }],
    ['saat dilimsiz tarih', { ...draft, publishAt: '2026-11-10T09:00:00' }],
    ['gecersiz tarih', { ...draft, publishAt: 'yarin' }],
    ['bitis yayindan once', { ...draft, publishAt: '2026-11-10T09:00:00Z', expiresAt: '2026-11-09T09:00:00Z' }],
    ['blockIds dizi degil', { ...draft, blockIds: 'b1' }],
  ])('400: %s', async (_l, body) => {
    const { call } = setup();
    expect((await call('POST', '', body)).status).toBe(400);
  });

  it('olmayan veya pasif blok 404', async () => {
    const { call } = setup();
    expect((await call('POST', '', { ...draft, blockIds: ['b9'] })).status).toBe(404);
    expect((await call('POST', '', { ...draft, blockIds: ['eski'] })).status).toBe(404);
  });
});

describe('announcements - yasam dongusu', () => {
  it('taslak duzenlenir; onaylaninca yayinda olur ve olay yayinlanir', async () => {
    const events = createInMemoryEventPublisher();
    const { call, clock } = setup({ events });
    await call('POST', '', draft);

    const edited = await call('PATCH', '/ann1', { version: 1, title: 'Planli su kesintisi', blockIds: ['b1'] });
    expect(edited.body).toMatchObject({ title: 'Planli su kesintisi', blockIds: ['b1'], version: 2 });

    clock.set('2026-11-06T11:00:00.000Z');
    const approved = await call('POST', '/ann1/approve', { version: 2 });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'published',
      approvedBy: 'mgr-1',
      approvedAt: '2026-11-06T11:00:00.000Z',
      // Gecmisteki publishAt onay anina cekilir.
      publishAt: '2026-11-06T11:00:00.000Z',
      version: 3,
    });

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      eventId: 'ANNOUNCEMENT_PUBLISHED:ann1',
      type: 'ANNOUNCEMENT_PUBLISHED',
      apartmentId: APT,
      actorId: 'mgr-1',
      payload: { announcementId: 'ann1', title: 'Planli su kesintisi', blockIds: ['b1'] },
    });
    expect(JSON.stringify(events.published[0])).not.toContain('10:00-14:00'); // govde tasinmaz
  });

  it('ileri tarihli duyuru ileri tarihte kalir', async () => {
    const { call } = setup();
    await call('POST', '', { ...draft, publishAt: '2026-12-01T09:00:00+03:00' });
    const res = await call('POST', '/ann1/approve', { version: 1 });
    expect(res.body.publishAt).toBe('2026-12-01T06:00:00.000Z');
  });

  it('yayinlanmis duyuru duzenlenemez ve tekrar onaylanamaz (409)', async () => {
    const { call } = setup();
    await call('POST', '', draft);
    await call('POST', '/ann1/approve', { version: 1 });
    expect((await call('PATCH', '/ann1', { version: 2, title: 'x' })).status).toBe(409);
    expect((await call('POST', '/ann1/approve', { version: 2 })).status).toBe(409);
  });

  it('suresi dolmus taslak onaylanamaz (400)', async () => {
    const { call, clock } = setup();
    await call('POST', '', { ...draft, publishAt: '2026-11-06T10:00:00Z', expiresAt: '2026-11-06T12:00:00Z' });
    clock.set('2026-11-06T13:00:00.000Z');
    expect((await call('POST', '/ann1/approve', { version: 1 })).status).toBe(400);
  });

  it('eski surumle onay/duzenleme 409; version zorunlu (400)', async () => {
    const { call } = setup();
    await call('POST', '', draft);
    await call('PATCH', '/ann1', { version: 1, body: 'yeni metin' });
    expect((await call('POST', '/ann1/approve', { version: 1 })).status).toBe(409);
    expect((await call('PATCH', '/ann1', { version: 1, title: 'x' })).status).toBe(409);
    expect((await call('POST', '/ann1/approve', {})).status).toBe(400);
  });

  it('arsivleme: kayit silinmez, tekrar arsivleme idempotent', async () => {
    const { call, items } = setup();
    await call('POST', '', draft);
    await call('POST', '/ann1/approve', { version: 1 });
    const archived = await call('POST', '/ann1/archive', { version: 2 });
    expect(archived.body).toMatchObject({ status: 'archived', version: 3 });
    expect(archived.body.archivedAt).toBeDefined();
    expect((await call('POST', '/ann1/archive', { version: 3 })).body.version).toBe(3);
    expect(items.size).toBe(1);
  });

  it('olay yayini basarisiz olsa da onay kaydedilir', async () => {
    const failing: EventPublisher = { publish: vi.fn(async () => { throw new Error('sns down'); }) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { call, items } = setup({ events: failing });
    await call('POST', '', draft);
    expect((await call('POST', '/ann1/approve', { version: 1 })).status).toBe(200);
    expect(items.get(`${APT}|ann1`)!.status).toBe('published');
    spy.mockRestore();
  });

  it('listeleme: durum filtresi, en yeni once', async () => {
    const { call, clock } = setup();
    await call('POST', '', draft);
    clock.set('2026-11-06T12:00:00.000Z');
    await call('POST', '', { ...draft, title: 'Ikinci' });
    await call('POST', '/ann1/approve', { version: 1 });

    const ids = async (q: string) => (await call('GET', q)).body.items.map((a: any) => a.announcementId);
    expect(await ids('')).toEqual(['ann2', 'ann1']);
    expect(await ids('?status=draft')).toEqual(['ann2']);
    expect(await ids('?status=published')).toEqual(['ann1']);
    expect((await call('GET', '?status=silinmis')).status).toBe(400);
  });
});

describe('announcements -> portal (uctan uca)', () => {
  it('sakin yalnizca onaylanmis, yayin zamani gelmis, kendi blogunu kapsayan duyurulari gorur', async () => {
    const { call, residentFeed, clock } = setup();
    await call('POST', '', draft); // ann1: genel, taslak kalacak
    await call('POST', '', { ...draft, blockIds: ['b1'] }); // ann2: b1
    await call('POST', '', { ...draft, blockIds: ['b2'] }); // ann3: b2
    await call('POST', '', { ...draft, publishAt: '2026-11-20T09:00:00Z' }); // ann4: ileri tarihli
    for (const id of ['ann2', 'ann3', 'ann4']) await call('POST', `/${id}/approve`, { version: 1 });

    expect(await residentFeed()).toEqual(['ann2']);

    await call('POST', '/ann2/archive', { version: 2 });
    expect(await residentFeed()).toEqual([]);

    clock.set('2026-11-21T00:00:00.000Z');
    expect(await residentFeed()).toEqual(['ann4']);
  });
});

describe('announcements repository (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = createAnnouncementRepository();

  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const item = (): Announcement => ({
    ...announcementKeys.announcement(APT, 'ann1'),
    entityType: 'ANNOUNCEMENT',
    ...seedAudit,
    announcementId: 'ann1',
    apartmentId: APT,
    title: 't',
    body: 'b',
    status: 'draft',
    publishAt: T0.toISOString(),
  });

  it('create/update kosullu yazar', async () => {
    ddb.on(PutCommand).resolves({});
    await repo.create(item());
    await repo.update({ ...item(), version: 2 }, 1);
    const [create, update] = ddb.commandCalls(PutCommand).map((c) => c.args[0].input);
    expect(create!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(update!.ExpressionAttributeValues).toEqual({ ':expectedVersion': 1 });
  });

  it('anahtar tutarsizligi reddedilir; list ANN# on ekiyle sorgular', async () => {
    await expect(repo.create({ ...item(), PK: 'APT#apt-2' })).rejects.toThrow(/tutarsiz/);
    ddb.on(QueryCommand).resolves({ Items: [item()] });
    expect(await repo.list(APT)).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'APT#apt-1',
      ':skp': 'ANN#',
    });
  });
});
