import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUserGlobalSignOutCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  CodeMismatchException,
  SetUserMFAPreferenceCommand,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import { claimsFromRecord } from '../src/auth/claims.js';
import { type MfaPolicy, evaluateMfa, graceUntilFrom, loadMfaPolicy } from '../src/auth/mfa.js';
import {
  type PreTokenGenerationEvent,
  cognitoMfaEnabled,
  createPreTokenHandler,
  startGraceInDynamo,
} from '../src/auth/preTokenGeneration.js';
import type { AuditDraft } from '../src/modules/audit/log.js';
import { createCognitoMfaProvider, createMockMfaProvider } from '../src/modules/mfa/provider.js';
import { createMfaService } from '../src/modules/mfa/service.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const WARN: MfaPolicy = { mode: 'warn', graceDays: 7 };
const ENFORCE: MfaPolicy = { mode: 'enforce', graceDays: 7 };
const OFF: MfaPolicy = { mode: 'off', graceDays: 7 };
const quiet = { info: () => {} };

// ---------------------------------------------------------------------------
// Politika
// ---------------------------------------------------------------------------

describe('MFA politikasi', () => {
  it('kapsam: platform_admin, management_company, apartment_manager, observer; digerleri istege bagli', () => {
    for (const role of ['platform_admin', 'management_company', 'apartment_manager', 'observer']) {
      expect(evaluateMfa({ role, mfaEnabled: false }, ENFORCE, NOW).status).toBe('required');
    }
    for (const role of ['resident', 'building_staff', 'security_guard', undefined]) {
      expect(evaluateMfa({ role, mfaEnabled: false }, ENFORCE, NOW).status).toBe('not_required');
    }
  });

  it('off -> zorunlu degil; etkinse her modda enabled', () => {
    expect(evaluateMfa({ role: 'apartment_manager', mfaEnabled: false }, OFF, NOW).status).toBe('not_required');
    expect(evaluateMfa({ role: 'apartment_manager', mfaEnabled: true }, ENFORCE, NOW).status).toBe('enabled');
    expect(evaluateMfa({ role: 'resident', mfaEnabled: true }, OFF, NOW).status).toBe('enabled');
  });

  it('warn: sure icinde grace, sure dolunca veya token zorunlu diyorsa required', () => {
    const future = '2099-11-25T00:00:00.000Z';
    const past = '2026-11-20T00:00:00.000Z';
    expect(evaluateMfa({ role: 'observer', mfaEnabled: false, graceUntil: future }, WARN, NOW)).toEqual({ status: 'grace', graceUntil: future });
    expect(evaluateMfa({ role: 'observer', mfaEnabled: false, graceUntil: past }, WARN, NOW)).toEqual({ status: 'required', graceUntil: past });
    expect(evaluateMfa({ role: 'observer', mfaEnabled: false, mfaRequired: true }, WARN, NOW).status).toBe('required');
    expect(evaluateMfa({ role: 'observer', mfaEnabled: false }, WARN, NOW).status).toBe('grace');
    expect(graceUntilFrom('2026-11-21T10:00:00.000Z', 7)).toBe('2026-11-28T10:00:00.000Z');
  });

  it('ortamdan okunur; varsayilan off/7; gecersiz deger baslangicta hata', () => {
    expect(loadMfaPolicy({})).toEqual({ mode: 'off', graceDays: 7 });
    expect(loadMfaPolicy({ MFA_ENFORCEMENT_MODE: 'warn', MFA_GRACE_PERIOD_DAYS: '14' })).toEqual({ mode: 'warn', graceDays: 14 });
    expect(() => loadMfaPolicy({ MFA_ENFORCEMENT_MODE: 'enforced' })).toThrow(/MFA_ENFORCEMENT_MODE/);
    expect(() => loadMfaPolicy({ MFA_GRACE_PERIOD_DAYS: '-1' })).toThrow(/MFA_GRACE_PERIOD_DAYS/);
    expect(() => loadMfaPolicy({ MFA_GRACE_PERIOD_DAYS: '2.5' })).toThrow(/MFA_GRACE_PERIOD_DAYS/);
  });

  it('claim\'ler metin ("true") veya boolean olarak okunur', () => {
    expect(claimsFromRecord({ sub: 'u', role: 'observer', mfa_enabled: 'true', mfa_required: 'false', mfa_grace_until: 'x' })).toMatchObject({
      mfaEnabled: true,
      mfaGraceUntil: 'x',
    });
    expect(claimsFromRecord({ sub: 'u', role: 'observer', mfa_required: true })).toMatchObject({ mfaRequired: true });
    expect(claimsFromRecord({ sub: 'u', role: 'observer' })).not.toHaveProperty('mfaEnabled');
  });
});

// ---------------------------------------------------------------------------
// Pre Token Generation
// ---------------------------------------------------------------------------

const managerGrant = { entityType: 'APARTMENT_ROLE', apartmentId: 'apt-1', role: 'apartment_manager', status: 'active' };
const residentGrant = { entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-1', status: 'active' };

function preTokenEvent(groups: string[] = []): PreTokenGenerationEvent {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_RefreshTokens',
    userName: 'user-1',
    userPoolId: 'eu-central-1_pool',
    request: { userAttributes: { sub: 'user-1' }, groupConfiguration: { groupsToOverride: groups } },
    response: { claimsAndScopeOverrideDetails: null },
  };
}

function preToken(opts: { policy: MfaPolicy; items?: object[]; enabled?: boolean; graceStart?: string; groups?: string[] }) {
  const loadMfaEnabled = vi.fn(async () => opts.enabled ?? false);
  const startGrace = vi.fn(async () => opts.graceStart ?? NOW.toISOString());
  const handler = createPreTokenHandler({
    loadGrantItems: async () => opts.items ?? [managerGrant],
    mfaPolicy: opts.policy,
    loadMfaEnabled,
    startGrace,
    now: () => NOW,
    log: quiet,
  });
  return {
    loadMfaEnabled,
    startGrace,
    run: async () => {
      const out = await handler(preTokenEvent(opts.groups));
      const access = out.response.claimsAndScopeOverrideDetails?.accessTokenGeneration;
      expect(out.response.claimsAndScopeOverrideDetails?.idTokenGeneration).toEqual(access);
      return access!;
    },
  };
}

describe('Pre Token: MFA claim\'leri', () => {
  it('warn: TOTP yoksa kullanici bazli sure baslar, bitis claim\'e yazilir; rol korunur', async () => {
    const p = preToken({ policy: WARN });
    const claims = await p.run();
    expect(p.loadMfaEnabled).toHaveBeenCalledWith('eu-central-1_pool', 'user-1');
    expect(p.startGrace).toHaveBeenCalledWith('user-1', NOW);
    expect(claims.claimsToAddOrOverride).toEqual({
      role: 'apartment_manager',
      apartmentId: 'apt-1',
      mfa_enabled: 'false',
      mfa_grace_until: '2026-11-28T10:00:00.000Z',
    });
    expect(claims.claimsToSuppress).toEqual(['organizationId', 'mfa_required']);
  });

  it('warn: sure dolmussa mfa_required', async () => {
    const claims = await preToken({ policy: WARN, graceStart: '2026-11-01T00:00:00.000Z' }).run();
    expect(claims.claimsToAddOrOverride).toMatchObject({ mfa_enabled: 'false', mfa_required: 'true' });
    expect(claims.claimsToAddOrOverride).not.toHaveProperty('mfa_grace_until');
  });

  it('enforce: TOTP yoksa hemen mfa_required (sure kaydi acilmaz)', async () => {
    const p = preToken({ policy: ENFORCE });
    expect((await p.run()).claimsToAddOrOverride).toMatchObject({ mfa_enabled: 'false', mfa_required: 'true' });
    expect(p.startGrace).not.toHaveBeenCalled();
  });

  it('TOTP etkinse yalnizca mfa_enabled=true', async () => {
    const p = preToken({ policy: ENFORCE, enabled: true });
    const claims = await p.run();
    expect(claims.claimsToAddOrOverride).toMatchObject({ mfa_enabled: 'true' });
    expect(claims.claimsToSuppress).toEqual(['organizationId', 'mfa_required', 'mfa_grace_until']);
  });

  it('platform_admin group\'u da kapsamda', async () => {
    const claims = await preToken({ policy: ENFORCE, items: [], groups: ['platform_admin'] }).run();
    expect(claims.claimsToAddOrOverride).toEqual({ role: 'platform_admin', mfa_enabled: 'false', mfa_required: 'true' });
  });

  it('kapsam disi rol ve off modu Cognito\'ya sorulmaz', async () => {
    const resident = preToken({ policy: ENFORCE, items: [residentGrant] });
    expect((await resident.run()).claimsToAddOrOverride).toEqual({ role: 'resident', apartmentId: 'apt-1' });
    expect(resident.loadMfaEnabled).not.toHaveBeenCalled();
    const off = preToken({ policy: OFF });
    expect((await off.run()).claimsToAddOrOverride).toEqual({ role: 'apartment_manager', apartmentId: 'apt-1' });
    expect(off.loadMfaEnabled).not.toHaveBeenCalled();
  });

  it('MFA durumu okunamazsa giris basarisiz (kapali-hata)', async () => {
    const handler = createPreTokenHandler({
      loadGrantItems: async () => [managerGrant],
      mfaPolicy: ENFORCE,
      loadMfaEnabled: async () => {
        throw new Error('throttled');
      },
      startGrace: async () => NOW.toISOString(),
      now: () => NOW,
      log: quiet,
    });
    await expect(handler(preTokenEvent())).rejects.toThrow('throttled');
  });

  it('AdminGetUser: SOFTWARE_TOKEN_MFA listedeyse etkin', async () => {
    const cognito = mockClient(CognitoIdentityProviderClient);
    cognito.on(AdminGetUserCommand).resolvesOnce({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }).resolvesOnce({});
    const client = new CognitoIdentityProviderClient({});
    expect(await cognitoMfaEnabled('pool', 'user-1', client)).toBe(true);
    expect(await cognitoMfaEnabled('pool', 'user-1', client)).toBe(false);
    expect(cognito.commandCalls(AdminGetUserCommand)[0]!.args[0].input).toEqual({ UserPoolId: 'pool', Username: 'user-1' });
  });

  it('gecis baslangici: varsa okunur, yoksa kosullu yazilir, yarista kazanan okunur', async () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    const dynamo = { client: DynamoDBDocumentClient.from(new (await import('@aws-sdk/client-dynamodb')).DynamoDBClient({})), tableName: 'bm' };

    ddb.on(GetCommand).resolvesOnce({ Item: { startedAt: '2026-11-01T00:00:00.000Z' } });
    expect(await startGraceInDynamo('user-1', NOW, dynamo)).toBe('2026-11-01T00:00:00.000Z');
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);

    ddb.reset();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    expect(await startGraceInDynamo('user-1', NOW, dynamo)).toBe(NOW.toISOString());
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      Item: { PK: 'USER#user-1', SK: 'MFAGRACE', entityType: 'MFA_GRACE', startedAt: NOW.toISOString() },
      ConditionExpression: 'attribute_not_exists(PK)',
    });

    ddb.reset();
    ddb.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { startedAt: '2026-11-21T09:59:00.000Z' } });
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    expect(await startGraceInDynamo('user-1', NOW, dynamo)).toBe('2026-11-21T09:59:00.000Z');
    ddb.restore();
  });
});

// ---------------------------------------------------------------------------
// API: merkezi ara katman + kurulum + sifirlama
// ---------------------------------------------------------------------------

type Tok = { sub: string; role?: string; apartmentId?: string; email?: string; [k: string]: unknown };
const bearer = (claims: Tok) => `Bearer ${encodeMockToken(claims)}`;
const MANAGER: Tok = { sub: 'mgr-1', role: 'apartment_manager', apartmentId: 'apt-1', email: 'mgr@ornek.com' };
const ADMIN: Tok = { sub: 'admin-1', role: 'platform_admin', mfa_enabled: 'true' };

function world(policy: MfaPolicy, opts: { grants?: Record<string, object[]>; platformAdmins?: string[]; failAudit?: boolean } = {}) {
  const provider = createMockMfaProvider({ platformAdmins: opts.platformAdmins });
  const audits: AuditDraft[] = [];
  const order: string[] = [];
  const realReset = provider.adminReset;
  provider.adminReset = async (id) => {
    order.push('reset');
    return realReset(id);
  };
  const realEnable = provider.enable;
  provider.enable = async (t) => {
    order.push('enable');
    return realEnable(t);
  };
  const mfaService = createMfaService({
    provider,
    policy,
    loadGrantItems: async (userId) => opts.grants?.[userId] ?? [],
    audit: async (d) => {
      if (opts.failAudit) throw new Error('audit down');
      order.push(`audit:${d.action}`);
      audits.push(d);
    },
    now: () => NOW,
  });
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    identify: createMockIdentityResolver(),
    mfaPolicy: policy,
    mfaService,
    auditReader: { list: async () => ({ items: [] }), listAfter: async () => [], get: async () => undefined },
  });
  const call = async (method: string, path: string, tok: Tok, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: bearer(tok), 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  return { app, call, provider, audits, order };
}

describe('merkezi MFA ara katmani', () => {
  it('enforce: kapsamdaki rol TOTP\'siz 403 MFA_REQUIRED; MFA\'li ve kapsam disi rol gecer', async () => {
    const w = world(ENFORCE);
    const blocked = await w.call('GET', '/api/audit', MANAGER);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('MFA_REQUIRED');
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect((await w.call('GET', '/api/audit', { ...MANAGER, mfa_enabled: 'true' })).status).toBe(200);
    expect((await w.call('GET', '/api/audit', { ...MANAGER, role: 'observer', mfa_enabled: 'true' })).status).toBe(200);
    // Kapsam disi: resident MFA'siz devam eder (bu uc ona kapali oldugu icin 403 forbidden, MFA degil).
    const resident = await w.call('GET', '/api/audit', { sub: 'r1', role: 'resident', apartmentId: 'apt-1' });
    expect(resident.body.error).toBe('forbidden');
  });

  it('warn: sure icinde uyari basligi, sure dolunca veya token zorunlu derse 403', async () => {
    const w = world(WARN);
    const ok = await w.call('GET', '/api/audit', { ...MANAGER, mfa_grace_until: '2099-11-25T00:00:00.000Z' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-mfa-warning')).toBe('grace; until=2099-11-25T00:00:00.000Z');
    const expired = await w.call('GET', '/api/audit', { ...MANAGER, mfa_grace_until: '2026-11-20T00:00:00.000Z' });
    expect(expired).toMatchObject({ status: 403, body: { error: 'MFA_REQUIRED', graceUntil: '2026-11-20T00:00:00.000Z' } });
    expect((await w.call('GET', '/api/audit', { ...MANAGER, mfa_required: 'true' })).status).toBe(403);
  });

  it('off: zorunluluk yok, uyari yok', async () => {
    const res = await world(OFF).call('GET', '/api/audit', MANAGER);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mfa-warning')).toBeNull();
  });

  it('MFA zorunluyken /api/me (baglam, MFA kurulumu) acik kalir', async () => {
    const w = world(ENFORCE);
    const status = await w.call('GET', '/api/me/mfa', MANAGER);
    expect(status).toMatchObject({ status: 200, body: { mode: 'enforce', roleRequiresMfa: true, enabled: false, status: 'required' } });
    expect((await w.call('POST', '/api/me/mfa/totp/setup', MANAGER)).status).toBe(200);
  });

  it('platform_admin MFA\'siz destek oturumu acamaz (karar kendi token\'iyla)', async () => {
    const w = world(ENFORCE);
    const res = await w.call('POST', '/api/support/sessions', { sub: 'admin-1', role: 'platform_admin' }, { apartmentId: 'apt-1', reason: 'x'.repeat(30) });
    expect(res.body.error).toBe('MFA_REQUIRED');
  });
});

describe('TOTP kurulumu (/api/me/mfa)', () => {
  it('kurulum: anahtar + otpauth URI; dogrulama; denetim kaydi etkinlestirmeden once', async () => {
    const w = world(WARN);
    const setup = await w.call('POST', '/api/me/mfa/totp/setup', MANAGER);
    expect(setup.status).toBe(200);
    expect(setup.headers.get('cache-control')).toBe('no-store');
    expect(setup.body.secretCode).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.otpauthUri).toBe(
      `otpauth://totp/${encodeURIComponent('YÖNESİST:mgr@ornek.com')}?secret=${setup.body.secretCode}&issuer=${encodeURIComponent('YÖNESİST')}&algorithm=SHA1&digits=6&period=30`,
    );

    expect((await w.call('POST', '/api/me/mfa/totp/verify', MANAGER, { code: '12345' })).status).toBe(400);
    expect((await w.call('POST', '/api/me/mfa/totp/verify', MANAGER, { code: '654321' })).body.error).toBe('invalid_code');
    const ok = await w.call('POST', '/api/me/mfa/totp/verify', MANAGER, { code: '123456', deviceName: 'Telefonum' });
    expect(ok).toMatchObject({ status: 200, body: { enabled: true } });
    expect(w.order).toEqual(['audit:mfa.totp.enable', 'enable']);
    expect(w.audits[0]).toMatchObject({ target: { type: 'user', id: 'mgr-1' }, actorId: 'mgr-1', details: { deviceName: 'Telefonum' } });
    expect(w.audits[0]).not.toHaveProperty('apartmentId');
    expect((await w.call('GET', '/api/me/mfa', MANAGER)).body).toMatchObject({ enabled: true, status: 'enabled' });
  });

  it('kurulum baslatilmadan dogrulama 409', async () => {
    const res = await world(WARN).call('POST', '/api/me/mfa/totp/verify', MANAGER, { code: '123456' });
    expect(res).toMatchObject({ status: 409, body: { error: 'setup_not_started' } });
  });

  it('access token baska kullaniciya aitse 401; baslik verilirse o kullanilir', async () => {
    const w = world(WARN);
    const other = await w.call('POST', '/api/me/mfa/totp/setup', MANAGER, undefined, {
      'x-cognito-access-token': encodeMockToken({ sub: 'baska' }),
    });
    expect(other).toMatchObject({ status: 401, body: { error: 'access_token_invalid' } });
    const own = await w.call('POST', '/api/me/mfa/totp/setup', MANAGER, undefined, {
      'x-cognito-access-token': encodeMockToken({ sub: 'mgr-1' }),
    });
    expect(own.status).toBe(200);
  });

  it('denetim yazilamazsa MFA etkinlesmez', async () => {
    const w = world(WARN, { failAudit: true });
    await w.call('POST', '/api/me/mfa/totp/setup', MANAGER);
    const res = await w.call('POST', '/api/me/mfa/totp/verify', MANAGER, { code: '123456' });
    expect(res.status).toBe(500);
    expect(w.provider.enabledUsers.has('mgr-1')).toBe(false);
  });
});

describe('MFA sifirlama (/api/mfa/users/:userId/reset)', () => {
  const REASON = 'Telefon kayboldu, talep #42';
  const mgr = { ...MANAGER, mfa_enabled: 'true' };
  const inApt = (role?: string) =>
    role
      ? [{ entityType: 'APARTMENT_ROLE', apartmentId: 'apt-1', role, status: 'active' }]
      : [{ entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-1', status: 'active' }];

  it('yonetici kendi apartmanindaki kullaniciyi sifirlar: once denetim (apartman zinciri), sonra Cognito', async () => {
    const w = world(ENFORCE, { grants: { 'obs-1': inApt('observer') } });
    w.provider.enabledUsers.add('obs-1');
    const res = await w.call('POST', '/api/mfa/users/obs-1/reset', mgr, { reason: REASON });
    expect(res).toMatchObject({ status: 200, body: { userId: 'obs-1', reset: true, signedOut: true } });
    expect(w.order).toEqual(['audit:mfa.reset', 'reset']);
    expect(w.audits[0]).toEqual({ apartmentId: 'apt-1', action: 'mfa.reset', target: { type: 'user', id: 'obs-1' }, reason: REASON, details: { globalSignOut: true } });
    expect(w.provider.enabledUsers.has('obs-1')).toBe(false);
  });

  it('platform_admin herkesi sifirlar; kayit PLATFORM zincirine', async () => {
    const w = world(ENFORCE);
    const res = await w.call('POST', '/api/mfa/users/mgr-9/reset', ADMIN, { reason: REASON });
    expect(res.status).toBe(200);
    expect(w.audits[0]).not.toHaveProperty('apartmentId');
  });

  it('kurallar: baska apartman 404, baska apartmanda yonetici 403, platform_admin 403, kendisi 403, kisa gerekce 400', async () => {
    const w = world(ENFORCE, {
      grants: {
        'x-apt': [{ entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-2', status: 'active' }],
        'multi': [...inApt(), { entityType: 'APARTMENT_ROLE', apartmentId: 'apt-2', role: 'apartment_manager', status: 'active' }],
        'padmin': inApt(),
        'gecmis': [{ entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-1', status: 'active', endDate: '2026-01-01' }],
      },
      platformAdmins: ['padmin'],
    });
    expect((await w.call('POST', '/api/mfa/users/x-apt/reset', mgr, { reason: REASON })).status).toBe(404);
    expect((await w.call('POST', '/api/mfa/users/gecmis/reset', mgr, { reason: REASON })).status).toBe(404);
    expect((await w.call('POST', '/api/mfa/users/multi/reset', mgr, { reason: REASON })).status).toBe(403);
    expect((await w.call('POST', '/api/mfa/users/padmin/reset', mgr, { reason: REASON })).status).toBe(403);
    expect((await w.call('POST', '/api/mfa/users/mgr-1/reset', mgr, { reason: REASON })).status).toBe(403);
    expect((await w.call('POST', '/api/mfa/users/padmin/reset', mgr, { reason: 'kisa' })).status).toBe(400);
    expect(w.provider.resets).toEqual([]);
    expect(w.audits).toEqual([]);
  });

  it('sakin, denetci ve destek oturumu sifirlayamaz; cagiranin kendisi de MFA\'ya tabidir', async () => {
    const w = world(ENFORCE, { grants: { 'r-1': inApt() } });
    expect((await w.call('POST', '/api/mfa/users/r-1/reset', { sub: 'r-2', role: 'resident', apartmentId: 'apt-1' }, { reason: REASON })).status).toBe(403);
    expect((await w.call('POST', '/api/mfa/users/r-1/reset', { ...mgr, role: 'observer' }, { reason: REASON })).status).toBe(403);
    expect((await w.call('POST', '/api/mfa/users/r-1/reset', MANAGER, { reason: REASON })).body.error).toBe('MFA_REQUIRED');
    expect(w.provider.resets).toEqual([]);
  });

  it('denetim yazilamazsa sifirlama yapilmaz; Cognito hatasinda basarisizlik da denetlenir', async () => {
    const down = world(ENFORCE, { grants: { 'r-1': inApt() }, failAudit: true });
    expect((await down.call('POST', '/api/mfa/users/r-1/reset', mgr, { reason: REASON })).status).toBe(500);
    expect(down.provider.resets).toEqual([]);

    const w = world(ENFORCE, { grants: { 'r-1': inApt() } });
    w.provider.adminReset = async () => {
      throw new Error('cognito down');
    };
    expect((await w.call('POST', '/api/mfa/users/r-1/reset', mgr, { reason: REASON })).status).toBe(500);
    expect(w.audits.map((a) => a.action)).toEqual(['mfa.reset', 'mfa.reset.failed']);
  });
});

describe('Cognito MFA saglayicisi', () => {
  const cognito = mockClient(CognitoIdentityProviderClient);
  const provider = () => createCognitoMfaProvider('pool-1', new CognitoIdentityProviderClient({}));

  it('kurulum access token ile (IAM gerekmez); dogrulama SUCCESS degilse hatali kod', async () => {
    cognito.reset();
    cognito.on(AssociateSoftwareTokenCommand).resolves({ SecretCode: 'ABC' });
    cognito.on(VerifySoftwareTokenCommand).resolvesOnce({ Status: 'SUCCESS' }).resolvesOnce({ Status: 'ERROR' });
    cognito.on(SetUserMFAPreferenceCommand).resolves({});
    const p = provider();
    expect(await p.associate('at')).toEqual({ secretCode: 'ABC' });
    await p.verify('at', '123456', 'Telefon');
    await expect(p.verify('at', '123456', 'Telefon')).rejects.toMatchObject({ code: 'invalid_code' });
    await p.enable('at');
    expect(cognito.commandCalls(VerifySoftwareTokenCommand)[0]!.args[0].input).toEqual({ AccessToken: 'at', UserCode: '123456', FriendlyDeviceName: 'Telefon' });
    expect(cognito.commandCalls(SetUserMFAPreferenceCommand)[0]!.args[0].input).toEqual({
      AccessToken: 'at',
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });
  });

  it('Cognito hatalari anlamli kodlara eslenir', async () => {
    cognito.reset();
    cognito.on(VerifySoftwareTokenCommand).rejects(new CodeMismatchException({ message: 'x', $metadata: {} }));
    await expect(provider().verify('at', '000000', 'd')).rejects.toMatchObject({ code: 'invalid_code', httpStatus: 400 });
  });

  it('sifirlama: TOTP kapatilir ve tum oturumlar dusurulur; group kontrolu sayfali', async () => {
    cognito.reset();
    cognito.on(AdminSetUserMFAPreferenceCommand).resolves({});
    cognito.on(AdminUserGlobalSignOutCommand).resolves({});
    cognito
      .on(AdminListGroupsForUserCommand)
      .resolvesOnce({ Groups: [{ GroupName: 'x' }], NextToken: 'n' })
      .resolvesOnce({ Groups: [{ GroupName: 'platform_admin' }] });
    const p = provider();
    await p.adminReset('user-9');
    expect(cognito.commandCalls(AdminSetUserMFAPreferenceCommand)[0]!.args[0].input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'user-9',
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    });
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)[0]!.args[0].input).toEqual({ UserPoolId: 'pool-1', Username: 'user-9' });
    expect(await p.isPlatformAdmin('user-9')).toBe(true);
  });
});
