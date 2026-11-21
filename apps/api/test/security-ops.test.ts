import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import type { MfaPolicy } from '../src/auth/mfa.js';
import type { Site } from '../src/modules/core/types.js';
import { type AuditEntry, GENESIS_HASH, buildEntry } from '../src/modules/audit/log.js';
import { type AuditReader, type Checkpoint, assessIntegrity, verifyAuditScope } from '../src/modules/audit/repository.js';
import { createMockMfaProvider } from '../src/modules/mfa/provider.js';
import { createMfaService } from '../src/modules/mfa/service.js';
import { createSupportService, type SupportSession } from '../src/modules/support/service.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const ENFORCE: MfaPolicy = { mode: 'enforce', graceDays: 7 };
const H = 3_600_000;
const iso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function chain(n: number, scope: 'apt' | 'platform' = 'apt'): AuditEntry[] {
  const out: AuditEntry[] = [];
  let tail = { seq: 0, hash: GENESIS_HASH };
  for (let i = 0; i < n; i++) {
    const e = buildEntry(
      { ...(scope === 'apt' ? { apartmentId: 'apt-1' } : {}), action: `t.a${i}`, target: { type: 't', id: String(i) } },
      tail,
      new Date(NOW.getTime() - (n - i) * H),
    );
    out.push(e);
    tail = { seq: e.seq, hash: e.hash };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zincir butunlugu gostergesi
// ---------------------------------------------------------------------------

describe('zincir butunlugu durumu', () => {
  const cp = (seq: number, agoMs: number): Checkpoint => ({ seq, hash: 'h', verifiedAt: iso(agoMs) });

  it('bos, dogrulandi, bekliyor ve bayat', () => {
    expect(assessIntegrity({}, NOW)).toMatchObject({ status: 'empty', latestSeq: 0, verifiedSeq: 0, staleAfterHours: 26 });
    expect(assessIntegrity({ latest: { seq: 5, at: iso(H) }, checkpoint: cp(5, 2 * H) }, NOW)).toMatchObject({ status: 'verified', latestSeq: 5, verifiedSeq: 5 });
    expect(assessIntegrity({ latest: { seq: 7, at: iso(H) }, checkpoint: cp(5, 2 * H) }, NOW).status).toBe('pending');
    expect(assessIntegrity({ latest: { seq: 5, at: iso(H) }, checkpoint: cp(5, 30 * H) }, NOW).status).toBe('stale');
  });

  it('kontrol noktasi yoksa: yeni zincir bekliyor, 26 saatten eski zincir bayat', () => {
    expect(assessIntegrity({ latest: { seq: 2, at: iso(H) }, first: { at: iso(3 * H) } }, NOW).status).toBe('pending');
    expect(assessIntegrity({ latest: { seq: 2, at: iso(H) }, first: { at: iso(40 * H) } }, NOW).status).toBe('stale');
  });

  it('gece dogrulamasi yeni kayit olmasa da verifiedAt tazeler; bulguda tazelemez', async () => {
    const c = chain(2);
    const stored = new Map<string, Checkpoint>([['APT#apt-1', { seq: 2, hash: c[1]!.hash, verifiedAt: iso(48 * H) }]]);
    const checkpoints = { get: async (s: string) => stored.get(s), put: async (s: string, v: Checkpoint) => void stored.set(s, v) };
    const reader = { listAfter: async () => [], get: async (_s: string, seq: number) => c.find((e) => e.seq === seq) };
    await verifyAuditScope('APT#apt-1', { reader, checkpoints, now: () => NOW });
    expect(stored.get('APT#apt-1')).toEqual({ seq: 2, hash: c[1]!.hash, verifiedAt: NOW.toISOString() });

    stored.set('APT#apt-1', { seq: 2, hash: 'kurcalanmis', verifiedAt: iso(48 * H) });
    await verifyAuditScope('APT#apt-1', { reader, checkpoints, now: () => NOW });
    expect(stored.get('APT#apt-1')!.verifiedAt).toBe(iso(48 * H));
  });
});

// ---------------------------------------------------------------------------
// API: platform zinciri, butunluk, MFA kullanici uclari, metrikler
// ---------------------------------------------------------------------------

type Tok = { sub: string; role?: string; apartmentId?: string; [k: string]: unknown };
const bearer = (t: Tok) => `Bearer ${encodeMockToken(t)}`;
const MANAGER: Tok = { sub: 'mgr-1', role: 'apartment_manager', apartmentId: 'apt-1', mfa_enabled: 'true' };
const ADMIN: Tok = { sub: 'admin-1', role: 'platform_admin', mfa_enabled: 'true' };
const inApt = (apartmentId: string, role?: string) =>
  role
    ? { entityType: 'APARTMENT_ROLE', apartmentId, role, status: 'active' }
    : { entityType: 'UNIT_MEMBERSHIP', apartmentId, status: 'active' };

function world() {
  const apt = chain(3);
  const platform = chain(2, 'platform');
  const listed: string[] = [];
  const reader: AuditReader = {
    list: async (scope, q) => {
      listed.push(scope);
      const items = (scope === 'PLATFORM' ? platform : apt).slice().reverse();
      return { items: items.slice(0, q.limit) };
    },
    listAfter: async (scope, after, limit = 1000) => (scope === 'PLATFORM' ? platform : apt).filter((e) => e.seq > after).slice(0, limit),
    get: async () => undefined,
  };
  const checkpoints = { get: vi.fn(async (scope: string) => (scope === 'APT#apt-1' ? { seq: 3, hash: apt[2]!.hash, verifiedAt: iso(H) } : undefined)) };
  const metrics = { emit: vi.fn() };
  const provider = createMockMfaProvider({ users: { 'sakin@ornek.com': 'r-1', 'admin2@ornek.com': 'admin-2' }, platformAdmins: ['admin-2', 'padmin'] });
  provider.enabledUsers.add('r-1');
  const grants: Record<string, object[]> = {
    'r-1': [inApt('apt-1')],
    multi: [inApt('apt-1'), inApt('apt-2', 'observer')],
    padmin: [inApt('apt-1')],
    'x-apt': [inApt('apt-2')],
  };
  const mfaService = createMfaService({
    provider,
    policy: ENFORCE,
    loadGrantItems: async (id) => grants[id] ?? [],
    audit: async () => undefined,
    metrics,
    now: () => NOW,
  });
  const sessions = new Map<string, SupportSession>();
  const supportService = createSupportService({
    repository: {
      get: async (a, id) => [...sessions.values()].find((s) => s.apartmentId === a && s.sessionId === id),
      list: async () => [],
      create: async (s) => void sessions.set(s.sessionId, s),
      update: async (s) => void sessions.set(s.sessionId, s),
    },
    core: { getSite: async (id) => ({ siteId: id }) as Site },
    now: () => NOW,
    newId: () => 'sessionabcdef12',
    recordRequest: async () => undefined,
  });
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    identify: createMockIdentityResolver(),
    mfaPolicy: ENFORCE,
    mfaService,
    supportService,
    auditReader: reader,
    auditCheckpoints: checkpoints,
    metrics,
  });
  const call = async (method: string, path: string, tok: Tok, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: bearer(tok), 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  return { call, listed, metrics, provider, checkpoints };
}

describe('GET /api/audit?scope=platform ve /integrity', () => {
  it('platform_admin platform zincirini dogrudan okur; apartman zincirini dogrudan okuyamaz', async () => {
    const w = world();
    const res = await w.call('GET', '/api/audit?scope=platform', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: AuditEntry) => e.seq)).toEqual([2, 1]);
    expect(w.listed).toEqual(['PLATFORM']);
    expect((await w.call('GET', '/api/audit', ADMIN)).status).toBe(403);
    expect((await w.call('GET', '/api/audit?scope=platform', MANAGER)).status).toBe(403);
    expect((await w.call('GET', '/api/audit?scope=her', MANAGER)).status).toBe(400);
  });

  it('destek oturumu (denetci) yalnizca o apartmanin zincirini gorur, platform zincirini goremez', async () => {
    const w = world();
    const { body: s } = await w.call('POST', '/api/support/sessions', ADMIN, { apartmentId: 'apt-1', reason: 'Destek talebi #77: makbuz sorunu inceleniyor' });
    const h = { 'x-support-session': s.header };
    expect((await w.call('GET', '/api/audit', ADMIN, undefined, h)).status).toBe(200);
    expect(w.listed.at(-1)).toBe('APT#apt-1');
    expect((await w.call('GET', '/api/audit?scope=platform', ADMIN, undefined, h)).status).toBe(403);
  });

  it('butunluk: apartman kapsami kontrol noktasindan, platform kapsami ayri', async () => {
    const w = world();
    const apt = await w.call('GET', '/api/audit/integrity', MANAGER);
    expect(apt).toMatchObject({ status: 200, body: { status: 'verified', latestSeq: 3, verifiedSeq: 3 } });
    expect(w.checkpoints.get).toHaveBeenCalledWith('APT#apt-1');
    const platform = await w.call('GET', '/api/audit/integrity?scope=platform', ADMIN);
    // Kontrol noktasi yok ve ilk kayit 2 saat once: gece dogrulanacak.
    expect(platform.body).toMatchObject({ status: 'pending', latestSeq: 2, verifiedSeq: 0 });
    expect((await w.call('GET', '/api/audit/integrity', { sub: 'r', role: 'resident', apartmentId: 'apt-1' })).status).toBe(403);
  });
});

describe('MFA kullanici uclari', () => {
  it('yonetici kendi apartmanindaki kullanicinin durumunu ve sifirlanabilirligini gorur', async () => {
    const w = world();
    expect((await w.call('GET', '/api/mfa/users/r-1', MANAGER)).body).toMatchObject({
      userId: 'r-1',
      email: 'sakin@ornek.com',
      mfaEnabled: true,
      accountEnabled: true,
      canReset: true,
    });
    expect((await w.call('GET', '/api/mfa/users/multi', MANAGER)).body).toMatchObject({ canReset: false, blockedReason: expect.stringContaining('başka apartmanda') });
    expect((await w.call('GET', '/api/mfa/users/padmin', MANAGER)).body).toMatchObject({ canReset: false, blockedReason: expect.stringContaining('Platform') });
    expect((await w.call('GET', '/api/mfa/users/mgr-1', MANAGER)).body).toMatchObject({ canReset: false });
    expect((await w.call('GET', '/api/mfa/users/x-apt', MANAGER)).status).toBe(404);
    expect((await w.call('GET', '/api/mfa/users/r-1', { ...MANAGER, role: 'observer' })).status).toBe(403);
  });

  it('platform aramasi: e-postayla, platform yoneticisi isareti; yalnizca platform_admin', async () => {
    const w = world();
    expect((await w.call('GET', '/api/mfa/users?email=ADMIN2@ornek.com', ADMIN)).body).toMatchObject({
      userId: 'admin-2',
      isPlatformAdmin: true,
      mfaEnabled: false,
      canReset: true,
    });
    expect((await w.call('GET', '/api/mfa/users?email=yok@ornek.com', ADMIN)).status).toBe(404);
    expect((await w.call('GET', '/api/mfa/users?email=bozuk', ADMIN)).status).toBe(400);
    expect((await w.call('GET', '/api/mfa/users?email=sakin@ornek.com', MANAGER)).status).toBe(403);
  });

  it('metrikler: hatali kod MfaVerifyFailed, sifirlama MfaReset, MFA\'siz yetkili istek MfaRequiredDenied', async () => {
    const w = world();
    await w.call('POST', '/api/me/mfa/totp/setup', { sub: 'r-9', role: 'resident', apartmentId: 'apt-1' });
    await w.call('POST', '/api/me/mfa/totp/verify', { sub: 'r-9', role: 'resident', apartmentId: 'apt-1' }, { code: '000000' });
    expect(w.metrics.emit).toHaveBeenCalledWith({ MfaVerifyFailed: 1 }, { msg: 'mfa_verify_failed' });

    expect((await w.call('POST', '/api/mfa/users/r-1/reset', MANAGER, { reason: 'Telefon kayboldu, talep #9' })).status).toBe(200);
    expect(w.metrics.emit).toHaveBeenCalledWith({ MfaReset: 1 }, { msg: 'mfa_reset', scope: 'apartment' });

    expect((await w.call('GET', '/api/audit', { ...MANAGER, mfa_enabled: 'false' })).status).toBe(403);
    expect(w.metrics.emit).toHaveBeenCalledWith({ MfaRequiredDenied: 1 }, { msg: 'mfa_required_denied', role: 'apartment_manager' });
  });
});
