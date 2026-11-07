import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuthFromEnv, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import { identityFromRecord } from '../src/auth/claims.js';
import { buildContexts, createMeService } from '../src/modules/me/service.js';

const NOW = new Date('2026-11-07T09:00:00.000Z');
const TODAY = '2026-11-07';

const items = [
  { entityType: 'APARTMENT_ROLE', apartmentId: 'apt-b', role: 'apartment_manager', status: 'active', organizationId: 'org-1' },
  { entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-b', unitId: 'u5', relation: 'owner', status: 'active', startDate: '2025-01-01' },
  { entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-a', unitId: 'u1', relation: 'tenant', status: 'active' },
  { entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-a', unitId: 'u2', relation: 'owner', status: 'active' },
  // Gecersizler: bitmis uyelik, pasif rol, platform_admin rol kaydi
  { entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-c', unitId: 'u9', relation: 'tenant', status: 'active', endDate: '2026-01-01' },
  { entityType: 'APARTMENT_ROLE', apartmentId: 'apt-c', role: 'observer', status: 'inactive' },
  { entityType: 'APARTMENT_ROLE', apartmentId: 'apt-c', role: 'platform_admin', status: 'active' },
];

const names = {
  sites: new Map([
    ['apt-a', 'Akasya Sitesi'],
    ['apt-b', 'Çınar Apartmanı'],
  ]),
  units: new Map([
    ['apt-a|u1', '1'],
    ['apt-b|u5', '5'],
  ]),
};

describe('buildContexts', () => {
  it('yalnizca gecerli yetkileri, site adlariyla ve daire bilgisiyle listeler', () => {
    const contexts = buildContexts(items, TODAY, names);
    expect(contexts).toEqual([
      {
        apartmentId: 'apt-a',
        apartmentName: 'Akasya Sitesi',
        role: 'resident',
        units: [
          { unitId: 'u1', unitNumber: '1', relation: 'tenant' },
          { unitId: 'u2', unitNumber: undefined, relation: 'owner' },
        ],
      },
      { apartmentId: 'apt-b', apartmentName: 'Çınar Apartmanı', role: 'apartment_manager', organizationId: 'org-1' },
      {
        apartmentId: 'apt-b',
        apartmentName: 'Çınar Apartmanı',
        role: 'resident',
        units: [{ unitId: 'u5', unitNumber: '5', relation: 'owner' }],
      },
    ]);
  });

  it('henuz baslamamis uyelik listelenmez', () => {
    const future = [{ entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-a', unitId: 'u1', relation: 'tenant', status: 'active', startDate: '2027-01-01' }];
    expect(buildContexts(future, TODAY, names)).toEqual([]);
  });
});

describe('identityFromRecord', () => {
  it('rol claim\'i olmadan da kimlik uretir', () => {
    expect(identityFromRecord({ sub: 'u1', email: 'a@b.c' })).toEqual({ userId: 'u1', email: 'a@b.c', groups: [], claims: null });
  });

  it("API Gateway'in metin bicimli group claim'ini cozer", () => {
    expect(identityFromRecord({ sub: 'u1', 'cognito:groups': '[platform_admin other]' })?.groups).toEqual([
      'platform_admin',
      'other',
    ]);
    expect(identityFromRecord({ sub: 'u1', 'cognito:groups': ['platform_admin'] })?.groups).toEqual(['platform_admin']);
  });

  it('sub yoksa null', () => {
    expect(identityFromRecord({ role: 'resident' })).toBeNull();
  });
});

describe('GET /api/me/contexts', () => {
  const meService = createMeService({
    loadGrantItems: async () => items,
    loadNames: async () => names,
    now: () => NOW,
  });
  const app = createApp({ version: 'test', identify: createMockIdentityResolver(), meService });
  const call = (claims?: Record<string, unknown>) =>
    app.request('/api/me/contexts', {
      headers: claims ? { authorization: `Bearer ${encodeMockToken(claims)}` } : {},
    });

  it('token yoksa 401', async () => {
    expect((await call()).status).toBe(401);
  });

  it('rolsuz token ile (baglam secilmemis) baglamlari dondurur', async () => {
    const res = await call({ sub: 'user-1', email: 'u@x.com' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { active: unknown; isPlatformAdmin: boolean; contexts: unknown[] };
    expect(body.active).toBeNull();
    expect(body.isPlatformAdmin).toBe(false);
    expect(body.contexts).toHaveLength(3);
  });

  it('aktif baglami token claim\'lerinden bildirir', async () => {
    const res = await call({ sub: 'user-1', role: 'resident', apartmentId: 'apt-a' });
    expect(await res.json()).toMatchObject({ active: { role: 'resident', apartmentId: 'apt-a' } });
  });

  it('rolsuz token diger modullerde hala 401 alir', async () => {
    const full = createApp({ version: 'test', identify: createMockIdentityResolver() });
    const res = await full.request('/api/sites', {
      headers: { authorization: `Bearer ${encodeMockToken({ sub: 'user-1' })}` },
    });
    expect(res.status).toBe(401);
  });

  it('identify verilmezse 401 (guvenli varsayilan)', async () => {
    const bare = createApp({ version: 'test', meService });
    expect((await bare.request('/api/me/contexts')).status).toBe(401);
  });
});

describe('createAuthFromEnv', () => {
  it('her modda kimlik cozumleyici de dondurur', () => {
    const silent = { warn: () => {} };
    expect(typeof createAuthFromEnv({ AUTH_MODE: 'mock' }, silent).identify).toBe('function');
    expect(typeof createAuthFromEnv({}, silent).identify).toBe('function');
  });
});
