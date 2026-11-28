import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import {
  DEMO_REQUEST_INDEX_PK,
  type DemoRequestItem,
  type DemoRequestRepository,
  createDemoRequestRepository,
  decodeCursor,
  encodeCursor,
} from '../src/modules/demo-requests/repository.js';
import { platformDemoRequestRoutes } from '../src/modules/demo-requests/routes.js';
import { createDemoRequestService } from '../src/modules/demo-requests/service.js';
import { DEMO_THROTTLE, clientBucket, throttleKeys } from '../src/modules/demo-requests/throttle.js';

const NOW = new Date('2026-11-28T09:10:00.000Z');

/** Bellek ici depo: gercek depoyla ayni kosullar (yeni kayit, `count < limit`). */
function fakeRepo() {
  const items = new Map<string, DemoRequestItem>();
  const counters = new Map<string, { count: number; ttl: number }>();
  const repo: DemoRequestRepository = {
    async put(item) {
      if (items.has(item.PK)) throw new Error('conflict');
      items.set(item.PK, item);
    },
    async list({ limit, cursor }) {
      const all = [...items.values()].sort((a, b) => b.GSI1SK.localeCompare(a.GSI1SK));
      const start = cursor ? all.findIndex((i) => i.GSI1SK === decodeCursor(cursor).GSI1SK) + 1 : 0;
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      const more = start + limit < all.length && last;
      const nextCursor = more ? encodeCursor({ PK: last.PK, SK: last.SK, GSI1PK: last.GSI1PK, GSI1SK: last.GSI1SK }) : undefined;
      return { items: page, ...(nextCursor ? { nextCursor } : {}) };
    },
    async hit(pk, sk, opts) {
      const key = `${pk}|${sk}`;
      const cur = counters.get(key) ?? { count: 0, ttl: opts.ttl };
      if (cur.count >= opts.limit) return { ok: false, count: opts.limit };
      cur.count += 1;
      counters.set(key, cur);
      return { ok: true, count: cur.count };
    },
  };
  return { repo, items, counters };
}

function world(opts: { now?: () => Date } = {}) {
  const store = fakeRepo();
  let n = 0;
  const metrics: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const service = createDemoRequestService({
    repository: store.repo,
    now: opts.now ?? (() => NOW),
    newId: () => `req-${++n}`,
    metrics: { emit: (m, p) => metrics.push({ ...m, ...p }) },
    log: { log: (line: string) => logs.push(line) },
  });
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    identify: createMockIdentityResolver(),
    mfaPolicy: { mode: 'off', graceDays: 7 },
    demoRequestService: service,
  });
  return { app, service, metrics, logs, ...store };
}

const VALID = {
  fullName: 'Ayşe Yılmaz',
  email: 'Ayse@Ornek.com ',
  phone: '0532 123 45 67',
  organization: 'Gül Sitesi',
  unitRange: '201-500',
  message: 'Dört bloklu sitemiz için demo istiyoruz.\nUygun saat: hafta içi.',
  kvkkConsent: true,
  kvkkVersion: '2026-11-28-taslak-1',
};

/** Lambda'daki gibi API Gateway istek baglami (sourceIp) ile istek. */
function post(app: ReturnType<typeof createApp>, body: unknown, opts: { ip?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const env = opts.ip === undefined ? undefined : { event: { requestContext: { http: { sourceIp: opts.ip, userAgent: 'Vitest/1.0' } } } };
  return app.request(
    '/api/public/demo-requests',
    { method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: opts.raw ?? JSON.stringify(body) },
    env,
  );
}

const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${encodeMockToken(claims)}` });
const platform = { sub: 'p1', role: 'platform_admin' };

describe('POST /api/public/demo-requests: dogrulama', () => {
  it('gecerli talep 201 { received: true } doner; kayit kimligi veya baska veri donmez', async () => {
    const w = world();
    const res = await post(w.app, VALID, { ip: '203.0.113.45' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(w.items.size).toBe(1);
  });

  it('kaydi DEMOREQ# olarak, 2 yil TTL ve platform dizini (GSI1) anahtarlariyla yazar; e-posta kucuk harf', async () => {
    const w = world();
    await post(w.app, VALID, { ip: '203.0.113.45' });
    const item = [...w.items.values()][0]!;
    expect(item).toMatchObject({
      PK: 'DEMOREQ#req-1',
      SK: 'DEMOREQ',
      entityType: 'DEMO_REQUEST',
      email: 'ayse@ornek.com',
      phone: '0532 123 45 67',
      unitRange: '201-500',
      kvkkConsent: true,
      kvkkVersion: '2026-11-28-taslak-1',
      status: 'new',
      createdAt: NOW.toISOString(),
      GSI1PK: DEMO_REQUEST_INDEX_PK,
      GSI1SK: `${NOW.toISOString()}#req-1`,
      ipMasked: '203.0.113.0/24',
      userAgent: 'Vitest/1.0',
    });
    expect(item.ttl).toBe(Math.floor(NOW.getTime() / 1000) + 730 * 86400);
  });

  it('ham IP hicbir kayda ve loga yazilmaz; logda kisisel veri yok', async () => {
    const w = world();
    await post(w.app, VALID, { ip: '203.0.113.45' });
    const everything = JSON.stringify([...w.items.values(), ...w.counters.keys(), w.logs, w.metrics]);
    expect(everything).not.toContain('203.0.113.45');
    const logged = JSON.stringify([w.logs, w.metrics]);
    for (const pii of ['Ayşe', 'ayse@ornek.com', '0532', 'Gül Sitesi', 'Dört bloklu']) expect(logged).not.toContain(pii);
    expect(w.metrics).toContainEqual(expect.objectContaining({ DemoRequestReceived: 1, msg: 'demo_request_received' }));
  });

  it.each([
    ['ad soyad eksik', { fullName: undefined }, 'fullName'],
    ['ad soyad cok kisa', { fullName: 'A' }, 'fullName'],
    ['gecersiz e-posta', { email: 'ayse@' }, 'email'],
    ['gecersiz telefon', { phone: '12ab' }, 'phone'],
    ['cok az rakamli telefon', { phone: '123 45' }, 'phone'],
    ['site adi eksik', { organization: ' ' }, 'organization'],
    ['bilinmeyen aralik', { unitRange: '1000' }, 'unitRange'],
    ['KVKK onayi yok', { kvkkConsent: false }, 'kvkkConsent'],
    ['KVKK surumu yok', { kvkkVersion: undefined }, 'kvkkVersion'],
    ['KVKK surumu gecersiz', { kvkkVersion: '../x' }, 'kvkkVersion'],
    ['ad soyadda kontrol karakteri', { fullName: 'Ayşe\u0000Yılmaz' }, 'fullName'],
    ['ad soyadda satir sonu', { fullName: 'Ayşe\nYılmaz' }, 'fullName'],
    ['cok uzun mesaj', { message: 'x'.repeat(2001) }, 'message'],
    ['sayi olarak ad', { fullName: 42 }, 'fullName'],
  ])('%s -> 400 validation_error, alan adiyla', async (_label, patch, field) => {
    const w = world();
    const res = await post(w.app, { ...VALID, ...patch }, { ip: '203.0.113.45' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string; fields: Record<string, string> };
    expect(body.error).toBe('validation_error');
    expect(body.fields).toHaveProperty(field);
    expect(w.items.size).toBe(0);
  });

  it('bilinmeyen alan (kati sema) -> 400; gecersiz JSON -> 400; dizi govde -> 400', async () => {
    const w = world();
    const extra = await post(w.app, { ...VALID, apartmentId: 'apt-1' }, { ip: '203.0.113.45' });
    expect(extra.status).toBe(400);
    expect(((await extra.json()) as { fields: Record<string, string> }).fields).toHaveProperty('apartmentId');
    expect((await post(w.app, undefined, { ip: '203.0.113.45', raw: '{"fullName":' })).status).toBe(400);
    expect((await post(w.app, [VALID], { ip: '203.0.113.45' })).status).toBe(400);
    expect(w.items.size).toBe(0);
  });

  it('isteğe bagli alanlar olmadan gecerli; dogrulama hatasi sayaci tuketmez', async () => {
    const w = world();
    for (let i = 0; i < 8; i++) await post(w.app, { ...VALID, email: 'x' }, { ip: '203.0.113.45' });
    const { phone: _p, message: _m, ...minimal } = VALID;
    const res = await post(w.app, minimal, { ip: '203.0.113.45' });
    expect(res.status).toBe(201);
    expect([...w.items.values()][0]).not.toHaveProperty('phone');
  });

  it('16 KB ustu govde ayristirilmadan 413', async () => {
    const w = world();
    const res = await post(w.app, undefined, { ip: '203.0.113.45', raw: JSON.stringify({ ...VALID, message: 'x'.repeat(20_000) }) });
    expect(res.status).toBe(413);
    expect(w.items.size).toBe(0);
  });
});

describe('bal kupu', () => {
  it('dolu bal kupu ayni 201 yanitini verir ama kayit yazmaz ve sayaca dokunmaz', async () => {
    const w = world();
    const res = await post(w.app, { ...VALID, website: 'http://spam.example' }, { ip: '203.0.113.45' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: true });
    expect(w.items.size).toBe(0);
    expect(w.counters.size).toBe(0);
    expect(w.metrics).toContainEqual(expect.objectContaining({ DemoRequestRejected: 1, reason: 'honeypot' }));
  });

  it('bos bal kupu normal talep sayilir', async () => {
    const w = world();
    expect((await post(w.app, { ...VALID, website: '' }, { ip: '203.0.113.45' })).status).toBe(201);
    expect(w.items.size).toBe(1);
  });
});

describe('IP basina deneme siniri', () => {
  it('saatte 5 talep; 6. talep 429 + Retry-After (baslik ve govde), kayit yazilmaz', async () => {
    const w = world();
    for (let i = 0; i < DEMO_THROTTLE.ip.limit; i++) expect((await post(w.app, VALID, { ip: '198.51.100.7' })).status).toBe(201);
    const res = await post(w.app, VALID, { ip: '198.51.100.7' });
    expect(res.status).toBe(429);
    // 09:10 -> pencere 10:00'da biter: 50 dk.
    expect(res.headers.get('retry-after')).toBe(String(50 * 60));
    const body = (await res.json()) as { error: string; retryAfterSeconds: number; message: string };
    expect(body).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 3000 });
    expect(body.message).toContain('50 dakika');
    expect(w.items.size).toBe(DEMO_THROTTLE.ip.limit);
  });

  it('baska IP etkilenmez; yeni pencerede sinir sifirlanir', async () => {
    let now = NOW;
    const w = world({ now: () => now });
    for (let i = 0; i < 5; i++) await post(w.app, VALID, { ip: '198.51.100.7' });
    expect((await post(w.app, VALID, { ip: '198.51.100.7' })).status).toBe(429);
    expect((await post(w.app, VALID, { ip: '198.51.100.8' })).status).toBe(201);
    now = new Date('2026-11-28T10:00:01.000Z');
    expect((await post(w.app, VALID, { ip: '198.51.100.7' })).status).toBe(201);
  });

  it('IPv6: ayni /64 tek istemci sayilir', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) expect((await post(w.app, VALID, { ip: `2001:db8:1:2::${i + 1}` })).status).toBe(201);
    expect((await post(w.app, VALID, { ip: '2001:db8:1:2:ffff::9' })).status).toBe(429);
    expect((await post(w.app, VALID, { ip: '2001:db8:1:3::1' })).status).toBe(201);
    expect(clientBucket('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe('2001:db8:1:2::/64');
    expect(clientBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientBucket('yalan')).toBe('unknown');
  });

  it("Lambda'da istemcinin X-Forwarded-For basligi yok sayilir: sinir API Gateway sourceIp'sine uygulanir", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) {
      const res = await post(w.app, VALID, { ip: '198.51.100.7', headers: { 'x-forwarded-for': `10.0.0.${i}` } });
      expect(res.status).toBe(201);
    }
    expect((await post(w.app, VALID, { ip: '198.51.100.7', headers: { 'x-forwarded-for': '10.9.9.9' } })).status).toBe(429);
  });

  it('sayac anahtari IP ozetidir (ham IP yok), pencere basina ayri kayit', () => {
    const k = throttleKeys.ip(clientBucket('198.51.100.7'));
    expect(k).toMatch(/^DEMOTHR#ip#[0-9a-f]{32}$/);
    expect(k).not.toContain('198.51');
    expect(throttleKeys.window(1764320400)).toBe('W#1764320400');
  });

  it('platform geneli gunluk sinir dolunca farkli IP de 429 alir', async () => {
    const store = fakeRepo();
    const limited = createDemoRequestService({ repository: store.repo, now: () => NOW });
    // Genel sayaci dolu baslat.
    const dayStart = Math.floor(NOW.getTime() / 1000 / 86400) * 86400;
    for (let i = 0; i < DEMO_THROTTLE.global.limit; i++) await store.repo.hit(throttleKeys.global(), throttleKeys.window(dayStart), { limit: DEMO_THROTTLE.global.limit, ttl: 1 });
    await expect(limited.create(VALID, { sourceIp: '192.0.2.1' })).rejects.toMatchObject({ httpStatus: 429, scope: 'global' });
    expect(store.items.size).toBe(0);
  });
});

describe('GET /api/platform/demo-requests (platform yoneticisi)', () => {
  async function seeded() {
    let t = NOW.getTime();
    const w = world({ now: () => new Date((t += 60_000)) });
    for (let i = 0; i < 3; i++) await post(w.app, { ...VALID, organization: `Site ${i + 1}` }, { ip: `192.0.2.${i + 1}` });
    return w;
  }

  it('en yeni once listeler; ic anahtarlar, User-Agent ve TTL donmez', async () => {
    const w = await seeded();
    const res = await w.app.request('/api/platform/demo-requests', { headers: bearer(platform) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.map((i) => i.organization)).toEqual(['Site 3', 'Site 2', 'Site 1']);
    for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'ttl', 'userAgent', 'kvkkConsent']) expect(body.items[0]).not.toHaveProperty(key);
    expect(body.items[0]).toMatchObject({ requestId: 'req-3', email: 'ayse@ornek.com', ipMasked: '192.0.2.0/24', status: 'new' });
  });

  it('limit + cursor ile sayfalar; gecersiz limit / cursor 400', async () => {
    const w = await seeded();
    const first = (await (await w.app.request('/api/platform/demo-requests?limit=2', { headers: bearer(platform) })).json()) as {
      items: Array<{ requestId: string }>;
      nextCursor?: string;
    };
    expect(first.items.map((i) => i.requestId)).toEqual(['req-3', 'req-2']);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await w.app.request(`/api/platform/demo-requests?limit=2&cursor=${first.nextCursor}`, { headers: bearer(platform) })
    ).json()) as { items: Array<{ requestId: string }>; nextCursor?: string };
    expect(second.items.map((i) => i.requestId)).toEqual(['req-1']);
    expect(second.nextCursor).toBeUndefined();
    expect((await w.app.request('/api/platform/demo-requests?limit=500', { headers: bearer(platform) })).status).toBe(400);
    const foreign = encodeCursor({ PK: 'APT#apt-1', SK: 'SITE', GSI1PK: 'USER#u1', GSI1SK: 'APT#apt-1' })!;
    expect((await w.app.request(`/api/platform/demo-requests?cursor=${foreign}`, { headers: bearer(platform) })).status).toBe(400);
    expect((await w.app.request('/api/platform/demo-requests?cursor=bozuk', { headers: bearer(platform) })).status).toBe(400);
  });

  it('kimliksiz 401; apartman rolleri (yonetici, yonetim firmasi, sakin, denetci) 403', async () => {
    const w = await seeded();
    expect((await w.app.request('/api/platform/demo-requests')).status).toBe(401);
    for (const role of ['apartment_manager', 'management_company', 'resident', 'observer', 'security_guard']) {
      const res = await w.app.request('/api/platform/demo-requests', { headers: bearer({ sub: 'u1', role, apartmentId: 'apt-1' }) });
      expect(res.status, role).toBe(403);
    }
  });

  it('destek oturumundaki platform yoneticisi listeyi goremez', async () => {
    const w = await seeded();
    const claims = { userId: 'p1', role: 'platform_admin', supportSessionId: 's1', apartmentId: 'apt-1' } as unknown as AuthClaims;
    const routes = platformDemoRequestRoutes({ authenticate: async () => claims, service: w.service });
    expect((await routes.request('/')).status).toBe(403);
  });
});

describe('herkese acik rota hicbir sey okumaz', () => {
  it('GET / ayrinti / diger yontemler 404; yonetici token\'i ile de okunamaz', async () => {
    const w = world();
    await post(w.app, VALID, { ip: '203.0.113.45' });
    for (const [method, path] of [
      ['GET', '/api/public/demo-requests'],
      ['GET', '/api/public/demo-requests/req-1'],
      ['PUT', '/api/public/demo-requests'],
      ['DELETE', '/api/public/demo-requests/req-1'],
      ['GET', '/api/public/anything'],
    ] as const) {
      const res = await w.app.request(path, { method, headers: bearer(platform) });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('ayse');
    }
  });

  it('herkese acik POST korumali uclarin kimligini atlatmaz: korumali uc yine 401', async () => {
    const w = world();
    expect((await w.app.request('/api/sites')).status).toBe(401);
    expect((await w.app.request('/api/admin/apartments')).status).toBe(401);
  });
});

describe('demo talep deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('kayit yalnizca yoksa yazilir; liste GSI1 uzerinden en yeni once ve sayfali', async () => {
    const repo = createDemoRequestRepository();
    ddb.on(PutCommand).resolves({});
    await repo.put({ PK: 'DEMOREQ#r1', SK: 'DEMOREQ' } as DemoRequestItem);
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');

    const last = { PK: 'DEMOREQ#r1', SK: 'DEMOREQ', GSI1PK: 'DEMO_REQUEST', GSI1SK: '2026-11-28T09:00:00.000Z#r1' };
    ddb.on(QueryCommand).resolves({ Items: [{ entityType: 'DEMO_REQUEST', requestId: 'r1' }, { entityType: 'OTHER' }], LastEvaluatedKey: last });
    const page = await repo.list({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(decodeCursor(page.nextCursor!)).toEqual(last);
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'DEMO_REQUEST' }, ScanIndexForward: false, Limit: 10 });
  });

  it('sayac: kosullu ADD + TTL; sinir doluysa ok: false', async () => {
    const repo = createDemoRequestRepository();
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 2 } });
    expect(await repo.hit('DEMOTHR#all', 'W#100', { limit: 200, ttl: 4600 })).toEqual({ ok: true, count: 2 });
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { PK: 'DEMOTHR#all', SK: 'W#100' },
      UpdateExpression: 'ADD #count :one SET #et = :et, #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeValues: { ':one': 1, ':limit': 200, ':ttl': 4600, ':et': 'DEMO_THROTTLE' },
    });
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'kosul', $metadata: {} }));
    expect(await repo.hit('DEMOTHR#all', 'W#100', { limit: 200, ttl: 4600 })).toEqual({ ok: false, count: 200 });
  });
});
