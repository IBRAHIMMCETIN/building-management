import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import type { AuditDraft } from '../src/modules/audit/log.js';
import { createCoreService, defaultSiteSettings } from '../src/modules/core/service.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Site } from '../src/modules/core/types.js';
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  diffFeatures,
  normalizeFeatureSettings,
  resolveFeatures,
  simpleModeFeatures,
} from '../src/modules/features/catalog.js';
import { createSiteFeatureReader, featureAllowed, requireFeature, staticSiteFeatureReader } from '../src/modules/features/guard.js';
import type { FeatureRepository, FeatureRequest } from '../src/modules/features/repository.js';
import { createFeatureService } from '../src/modules/features/service.js';
import { ownershipRoutes } from '../src/modules/ownership/routes.js';
import { portalRoutes } from '../src/modules/portal/routes.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { authenticateWith, type Env } from '../src/http/helpers.js';

const NOW = new Date('2026-11-28T09:00:00.000Z');
const APT = 'apt-1';

function site(over: Partial<Site> = {}, features?: Site['settings']['features']): Site {
  return {
    PK: `APT#${APT}`,
    SK: 'SITE',
    entityType: 'SITE',
    siteId: APT,
    tenantId: 't',
    name: 'Gül Sitesi',
    type: 'site',
    address: { line1: 'x', district: 'Kayapınar', city: 'Diyarbakır' },
    fiscalYearStartMonth: 1,
    settings: { ...defaultSiteSettings(), ...(features ? { features } : {}) },
    status: 'active',
    createdAt: NOW.toISOString(),
    createdBy: 'seed',
    updatedAt: NOW.toISOString(),
    updatedBy: 'seed',
    version: 3,
    ...over,
  } as Site;
}

function fakeRepo(initial: Site[] = [site()]) {
  const sites = new Map(initial.map((s) => [s.siteId, s]));
  const requests = new Map<string, FeatureRequest>();
  const audits: AuditDraft[] = [];
  const key = (apt: string, f: string) => `${apt}|${f}`;
  const repo: FeatureRepository = {
    getSite: async (id) => sites.get(id),
    saveSiteFeatures: async (s, expected, audit) => {
      const cur = sites.get(s.siteId);
      if (!cur || cur.version !== expected) throw Object.assign(new Error('conflict'), { code: 'conflict' });
      sites.set(s.siteId, s);
      audits.push(audit);
    },
    getRequest: async (apt, f) => requests.get(key(apt, f)),
    putRequest: async (r, audit) => {
      requests.set(key(r.apartmentId, r.feature), r);
      audits.push(audit);
    },
    closeRequest: async (r, expected, audit) => {
      const cur = requests.get(key(r.apartmentId, r.feature));
      if (!cur || cur.version !== expected) throw new Error('conflict');
      requests.set(key(r.apartmentId, r.feature), r);
      audits.push(audit);
    },
    listPendingRequests: async () => [...requests.values()].filter((r) => r.status === 'pending' && r.GSI1PK),
    listSiteRequests: async (apt) => [...requests.values()].filter((r) => r.apartmentId === apt),
  };
  return { repo, sites, requests, audits };
}

const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${encodeMockToken(claims)}`, 'content-type': 'application/json' });
const manager = { sub: 'm1', role: 'apartment_manager', apartmentId: APT };
const resident = { sub: 'r1', role: 'resident', apartmentId: APT };
const platform = { sub: 'p1', role: 'platform_admin' };

// ---------------------------------------------------------------------------

describe('ozellik katalogu', () => {
  it('web katalogu API ile ayni anahtarlari ayni sirada tasir', () => {
    const web = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'lib', 'features', 'catalog.ts'), 'utf8');
    const block = web.slice(web.indexOf('export const FEATURE_KEYS = ['), web.indexOf('] as const;'));
    expect([...block.matchAll(/'([a-zA-Z]+\.[a-zA-Z]+)'/g)].map((m) => m[1])).toEqual([...FEATURE_KEYS]);
  });

  it('anahtarlar tekil ve her birinin tanimi var', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
    for (const k of FEATURE_KEYS) expect(FEATURE_CATALOG[k].key).toBe(k);
  });

  it('kayit yoksa legacy: Adim 1 oncesi davranis (mevcut ozellikler acik, kancalar kapali)', () => {
    const r = resolveFeatures(undefined);
    expect(r['resident.restructure']).toBe(true);
    expect(r['resident.advanceOffset']).toBe(true);
    expect(r['resident.notificationPrefs']).toBe(true);
    expect(r['resident.mfa']).toBe(true);
    expect(r['admin.sharedOwnership']).toBe(true);
    expect(r['admin.debtRestructure']).toBe(true);
    expect(r['payments.online']).toBe(true);
    expect(r['resident.expenseChart']).toBe(false);
    expect(r['channels.whatsapp']).toBe(false);
    expect(r['auth.phoneOtp']).toBe(false);
  });

  it('sade mod: tum gizlemeler ve kancalar kapali (modul anahtarlari mevcut davranisla acik); override profili ezer', () => {
    const MODULE_KEYS = ['admin.assemblies', 'admin.tenders'];
    const simple = Object.entries(resolveFeatures(simpleModeFeatures()));
    expect(simple.filter(([k]) => !MODULE_KEYS.includes(k)).every(([, v]) => v === false)).toBe(true);
    expect(simple.filter(([k]) => MODULE_KEYS.includes(k)).every(([, v]) => v === true)).toBe(true);
    const r = resolveFeatures({ profile: 'simple', overrides: { 'admin.debtRestructure': true } });
    expect(r['admin.debtRestructure']).toBe(true);
    expect(r['resident.restructure']).toBe(false);
    expect(resolveFeatures({ profile: 'legacy', overrides: { 'resident.mfa': false } })['resident.mfa']).toBe(false);
  });

  it('bozuk kayit normalize edilir; fark listesi uretilir', () => {
    const n = normalizeFeatureSettings({ profile: 'bogus' as never, overrides: { 'x.y': true, 'resident.mfa': 'evet' as never, 'admin.debtRestructure': false } as never });
    expect(n).toEqual({ profile: 'legacy', overrides: { 'admin.debtRestructure': false } });
    expect(diffFeatures(resolveFeatures(undefined), resolveFeatures(simpleModeFeatures())).map((d) => d.key)).toContain('admin.sharedOwnership');
  });
});

describe('site olusturma ve ayar guncelleme', () => {
  function core() {
    const sites = new Map<string, Site>();
    const repo = {
      createSite: async (s: Site) => void sites.set(s.siteId, s),
      getSite: async (id: string) => sites.get(id),
      updateSite: async (s: Site) => void sites.set(s.siteId, s),
    } as unknown as CoreRepository;
    return { sites, service: createCoreService({ repository: repo, now: () => NOW, newId: () => 'new-1' }) };
  }
  const input = { name: 'Yeni Site', type: 'site', address: { line1: 'a', district: 'b', city: 'c' } };

  it('yeni site sade modla baslar', async () => {
    const { service } = core();
    const s = await service.createSite('p1', 't1', input);
    expect(s.settings.features).toEqual({ profile: 'simple', overrides: {} });
  });

  it('yonetici site PATCH ile ozellik anahtarini degistiremez; mevcut kayit korunur', async () => {
    const { service } = core();
    const s = await service.createSite('p1', 't1', input);
    const u = await service.updateSite('m1', s.siteId, { version: 1, settings: { dueDayOfMonth: 7, features: { profile: 'legacy', overrides: {} } } });
    expect(u.settings.dueDayOfMonth).toBe(7);
    expect(u.settings.features).toEqual({ profile: 'simple', overrides: {} });
  });
});

describe('guard', () => {
  it('okuyucu onbellege alir, invalidate ile tazeler; okuma hatasi yutulmaz', async () => {
    let t = 0;
    let current = site({}, { profile: 'simple', overrides: {} });
    const getSite = vi.fn(async () => current);
    const reader = createSiteFeatureReader({ getSite, ttlMs: 1000, now: () => t });
    expect((await reader.resolve(APT))['admin.debtRestructure']).toBe(false);
    current = site({}, { profile: 'legacy', overrides: {} });
    expect((await reader.resolve(APT))['admin.debtRestructure']).toBe(false);
    reader.invalidate(APT);
    expect((await reader.resolve(APT))['admin.debtRestructure']).toBe(true);
    t = 5000;
    await reader.resolve(APT);
    expect(getSite).toHaveBeenCalledTimes(3);

    const failing = createSiteFeatureReader({ getSite: async () => Promise.reject(new Error('ddb')) });
    await expect(failing.resolve(APT)).rejects.toThrow('ddb');
  });

  it('platform_admin muaf, destek oturumu muaf degil; okuyucu yoksa kontrol yok', async () => {
    const off = staticSiteFeatureReader({ 'admin.sharedOwnership': false });
    expect(await featureAllowed(off, { userId: 'p', role: 'platform_admin' }, 'admin.sharedOwnership')).toBe(true);
    expect(await featureAllowed(off, { userId: 'p', role: 'observer', apartmentId: APT, supportSessionId: 's1' }, 'admin.sharedOwnership')).toBe(false);
    expect(await featureAllowed(off, { userId: 'm', role: 'apartment_manager', apartmentId: APT }, 'admin.sharedOwnership')).toBe(false);
    expect(await featureAllowed(undefined, { userId: 'm', role: 'apartment_manager', apartmentId: APT }, 'admin.sharedOwnership')).toBe(true);
  });

  it('kapali ozellik 403 feature_disabled doner', async () => {
    const app = new Hono<Env>();
    app.use('*', authenticateWith(createMockAuthenticator()));
    app.get('/x', requireFeature(staticSiteFeatureReader({ 'resident.mfa': false }), 'resident.mfa'), (c) => c.json({ ok: true }));
    const res = await app.request('/x', { headers: bearer(resident) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'feature_disabled', feature: 'resident.mfa' });
  });
});

describe('ozellik servisi', () => {
  it('platform guncellemesi: gerekce ve surum zorunlu, denetim kaydi ve onbellek temizligi', async () => {
    const w = fakeRepo();
    const invalidate = vi.fn();
    const svc = createFeatureService({ repository: w.repo, reader: { invalidate }, now: () => NOW });

    await expect(svc.update('p1', APT, { version: 3, features: { 'admin.debtRestructure': false } })).rejects.toMatchObject({ field: 'reason' });
    await expect(svc.update('p1', APT, { version: 3, reason: 'Pilot sade mod', features: { 'yok.anahtar': false } })).rejects.toMatchObject({ field: 'features' });
    await expect(svc.update('p1', APT, { version: 2, reason: 'Pilot sade mod', features: { 'admin.debtRestructure': false } })).rejects.toMatchObject({ code: 'conflict' });

    const v = await svc.update('p1', APT, { version: 3, reason: 'Pilot sade mod', profile: 'simple', features: { 'payments.online': true } });
    expect(v).toMatchObject({ profile: 'simple', inherited: false, version: 4, overrides: { 'payments.online': true } });
    expect(v.features['admin.debtRestructure']).toBe(false);
    expect(v.features['payments.online']).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(APT);
    expect(w.audits[0]).toMatchObject({ apartmentId: APT, action: 'site.features.update', reason: 'Pilot sade mod', actorId: 'p1' });
    expect((w.audits[0]?.details as { changed: unknown[] }).changed.length).toBeGreaterThan(0);

    // null override'i kaldirir
    const back = await svc.update('p1', APT, { version: 4, reason: 'Geri al', features: { 'payments.online': null } });
    expect(back.features['payments.online']).toBe(false);
    expect(back.overrides).toEqual({});
  });

  it('acilmasini istiyorum: denetimli, tekil; acilinca talep kapanir', async () => {
    const w = fakeRepo([site({}, simpleModeFeatures())]);
    const svc = createFeatureService({ repository: w.repo, now: () => NOW });

    const first = await svc.requestEnable('m1', APT, { feature: 'admin.debtRestructure', note: 'İcra öncesi taksit lazım' });
    expect(first.created).toBe(true);
    expect(first.request).toMatchObject({ status: 'pending', feature: 'admin.debtRestructure', count: 1 });
    expect(w.audits.at(-1)).toMatchObject({ action: 'site.features.enable_request', apartmentId: APT });

    const again = await svc.requestEnable('m1', APT, { feature: 'admin.debtRestructure' });
    expect(again.created).toBe(false);
    expect(w.audits).toHaveLength(1);

    expect(await svc.listPendingRequests()).toEqual([expect.objectContaining({ feature: 'admin.debtRestructure', siteName: 'Gül Sitesi' })]);
    expect(await svc.siteRequests(APT)).toHaveLength(1);

    await svc.update('p1', APT, { version: 3, reason: 'Talep onaylandı', features: { 'admin.debtRestructure': true } });
    expect(w.requests.get(`${APT}|admin.debtRestructure`)).toMatchObject({ status: 'enabled', closedBy: 'p1' });
    expect(w.requests.get(`${APT}|admin.debtRestructure`)?.GSI1PK).toBeUndefined();
    expect(await svc.listPendingRequests()).toEqual([]);

    await expect(svc.requestEnable('m1', APT, { feature: 'admin.debtRestructure' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(svc.requestEnable('m1', APT, { feature: 'bogus' })).rejects.toMatchObject({ field: 'feature' });
  });

  it('talep reddedilebilir (gerekceli)', async () => {
    const w = fakeRepo([site({}, simpleModeFeatures())]);
    const svc = createFeatureService({ repository: w.repo, now: () => NOW });
    await svc.requestEnable('m1', APT, { feature: 'resident.mfa' });
    await expect(svc.dismissRequest('p1', APT, 'resident.mfa', {})).rejects.toMatchObject({ field: 'reason' });
    const closed = await svc.dismissRequest('p1', APT, 'resident.mfa', { reason: 'Pilotta gerek yok' });
    expect(closed.status).toBe('dismissed');
    await expect(svc.dismissRequest('p1', APT, 'resident.mfa', { reason: 'Tekrar kapat' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('HTTP uclari ve modul korumalari', () => {
  function app(features = staticSiteFeatureReader(resolveFeatures(simpleModeFeatures()))) {
    const w = fakeRepo([site({}, simpleModeFeatures())]);
    const prefs = { get: vi.fn(async () => ({ email: { enabled: true } })), update: vi.fn(async () => ({ email: { enabled: false } })) };
    const a = createApp({
      version: 'test',
      authenticate: createMockAuthenticator(),
      identify: createMockIdentityResolver(),
      mfaPolicy: { mode: 'off', graceDays: 7 },
      siteFeatures: features,
      featureService: createFeatureService({ repository: w.repo, reader: features, now: () => NOW }),
      notificationPreferences: prefs as never,
    });
    const call = async (method: string, path: string, claims: Record<string, unknown>, body?: unknown) => {
      const res = await a.request(path, { method, headers: bearer(claims), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : {} };
    };
    return { call, w, prefs };
  }

  it('GET /api/site-features: tum apartman rolleri etkin durumu okur', async () => {
    const { call } = app();
    const r = await call('GET', '/api/site-features', resident);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ apartmentId: APT, profile: 'simple', features: { 'resident.mfa': false } });
    expect(r.json.catalog).toHaveLength(FEATURE_KEYS.length);
  });

  it('yonetici talep gonderir; sakin gonderemez; platform listeler ve gunceller', async () => {
    const { call } = app();
    expect((await call('POST', '/api/site-features/requests', resident, { feature: 'resident.mfa' })).status).toBe(403);
    const created = await call('POST', '/api/site-features/requests', manager, { feature: 'admin.debtRestructure' });
    expect(created.status).toBe(201);
    expect((await call('POST', '/api/site-features/requests', manager, { feature: 'admin.debtRestructure' })).status).toBe(200);

    expect((await call('GET', '/api/admin/site-features/requests', manager)).status).toBe(403);
    const pending = await call('GET', '/api/admin/site-features/requests', platform);
    expect(pending.json.items).toHaveLength(1);

    const view = await call('GET', `/api/admin/site-features/${APT}`, platform);
    expect(view.json.version).toBe(3);
    const patched = await call('PATCH', `/api/admin/site-features/${APT}`, platform, { version: 3, reason: 'Talep onaylandı', features: { 'admin.debtRestructure': true } });
    expect(patched.status).toBe(200);
    expect(patched.json.features['admin.debtRestructure']).toBe(true);
    expect((await call('PATCH', `/api/admin/site-features/${APT}`, manager, { version: 4, reason: 'deneme', features: {} })).status).toBe(403);
  });

  it('kapali ozellik uclari 403 feature_disabled; yonetim rollerinin MFA / tercih uclari etkilenmez', async () => {
    const { call, prefs } = app();
    for (const [method, path, who] of [
      ['GET', '/api/portal/my-plans', resident],
      ['GET', '/api/portal/offset-options', resident],
      ['POST', '/api/portal/offset-requests', resident],
      ['GET', '/api/finance/plans', manager],
      ['POST', '/api/finance/plans/p1/accelerate', manager],
      ['PUT', '/api/ownership/units/u1/billing', manager],
      ['POST', '/api/ownership/units/u1/transfers/preview', manager],
      ['POST', '/api/ownership/transfers/t1/reverse', manager],
      ['GET', '/api/portal/payments/quote', resident],
      ['GET', '/api/me/notification-preferences', resident],
      ['POST', '/api/me/mfa/totp/setup', resident],
    ] as const) {
      const r = await call(method, path, who, method === 'GET' ? undefined : {});
      expect({ path, status: r.status, error: r.json.error }).toEqual({ path, status: 403, error: 'feature_disabled' });
    }
    const mgr = await call('GET', '/api/me/notification-preferences', manager);
    expect(mgr.status).toBe(200);
    expect(prefs.get).toHaveBeenCalledTimes(1);
  });

  it('acik ozellikte rota normal calisir (legacy okuyucu)', async () => {
    const { call, prefs } = app(staticSiteFeatureReader());
    expect((await call('GET', '/api/me/notification-preferences', resident)).status).toBe(200);
    expect(prefs.get).toHaveBeenCalled();
  });

  it('modul rotalari: sicil okuma ve sakin taksit plani acikken servise ulasir', async () => {
    const off = staticSiteFeatureReader({ 'admin.sharedOwnership': false });
    const own = ownershipRoutes({
      authenticate: createMockAuthenticator(),
      service: { issues: async () => ({ items: [] }), listTransfers: async () => [] } as never,
      features: off,
    });
    expect((await own.request('/issues', { headers: bearer(manager) })).status).toBe(200);
    expect((await own.request('/units/u1/transfers', { headers: bearer(manager) })).status).toBe(403);

    const portal = portalRoutes({
      authenticate: createMockAuthenticator(),
      service: {} as never,
      plans: { portalPlans: async () => ({ items: [] }) } as never,
      features: staticSiteFeatureReader({ 'resident.restructure': true }),
    });
    expect((await portal.request('/my-plans', { headers: bearer(resident) })).status).toBe(200);
  });
});

describe('zamanlanmis isler', () => {
  it('admin.debtRestructure kapali sitede installment_plans is uretmez', async () => {
    const sites = [site({ siteId: 'apt-1' }, simpleModeFeatures()), site({ siteId: 'apt-2', PK: 'APT#apt-2' })];
    const checkDefaults = vi.fn(async () => ({ checked: 0, defaulted: 0 }));
    const infos: string[] = [];
    const worker = createSchedulerWorker({
      core: { listSiteIds: async () => sites.map((s) => s.siteId), getSite: async (id: string) => sites.find((s) => s.siteId === id) },
      finance: {} as never,
      plans: { checkDefaults } as never,
      events: { publish: async () => {} } as never,
      now: () => NOW,
      log: { info: (m: string) => infos.push(m), error: () => {} },
      payments: null as never,
      payouts: null as never,
      invoices: null as never,
    });
    const out = await worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'installment_plans', scheduledTime: NOW.toISOString() }) }] });
    expect(out).toEqual({ batchItemFailures: [] });
    expect(checkDefaults).toHaveBeenCalledTimes(1);
    expect(checkDefaults).toHaveBeenCalledWith('apt-2', expect.any(String));
    expect(infos.join('\n')).toContain('feature_disabled');
  });
});
