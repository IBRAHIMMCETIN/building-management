import { createSign, generateKeyPairSync } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { JwtExpiredError } from 'aws-jwt-verify/error';
import type { Context } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  bearerToken,
  createAuthenticatorFromEnv,
  createCognitoAuthenticator,
  createMockAuthenticator,
  encodeMockToken,
} from '../src/auth/authenticators.js';
import { apiGatewayAuthenticator, denyAll } from '../src/auth/claims.js';
import type { CoreService } from '../src/modules/core/service.js';

// ---------------------------------------------------------------------------
// Yardimcilar: gercek RSA anahtariyla imzali Cognito benzeri JWT'ler (ag erisimi yok)
// ---------------------------------------------------------------------------

const POOL_ID = 'eu-central-1_AbCdEf123';
const CLIENT_ID = 'test-client-id';
const ISSUER = `https://cognito-idp.eu-central-1.amazonaws.com/${POOL_ID}`;
const KID = 'test-kid';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload: Record<string, unknown>, key = privateKey): string {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64(payload);
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(key).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function accessToken(overrides: Record<string, unknown> = {}, key = privateKey): string {
  const claims: Record<string, unknown> = {
    sub: 'user-1',
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: 'access',
    iat: now(),
    exp: now() + 3600,
    role: 'apartment_manager',
    apartmentId: 'apt-1',
    ...overrides,
  };
  // undefined deger verilen alan token'dan tamamen cikarilir.
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return signJwt(claims, key);
}

function createVerifier() {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: POOL_ID,
    clientId: CLIENT_ID,
    tokenUse: 'access',
  });
  // JWKS onbellege konur: dogrulama sirasinda ag istegi yapilmaz.
  verifier.cacheJwks({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
  } as never);
  return verifier;
}

const ctx = (headers: Record<string, string> = {}) =>
  ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as Context;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Bearer ayristirma
// ---------------------------------------------------------------------------

describe('bearerToken', () => {
  it('Bearer token cikarir (buyuk/kucuk harf duyarsiz)', () => {
    expect(bearerToken(ctx({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
    expect(bearerToken(ctx({ authorization: 'bearer abc' }))).toBe('abc');
  });

  it.each([['Basic abc'], ['Bearer'], ['Bearer a b'], ['abc']])('gecersiz baslik: %j', (value) => {
    expect(bearerToken(ctx({ authorization: value }))).toBeUndefined();
  });

  it('baslik yoksa undefined doner', () => {
    expect(bearerToken(ctx())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cognito JWT dogrulama
// ---------------------------------------------------------------------------

describe('createCognitoAuthenticator', () => {
  const make = (onReject = vi.fn()) => ({
    authenticate: createCognitoAuthenticator(
      { userPoolId: POOL_ID, clientId: CLIENT_ID },
      { verifier: createVerifier(), onReject },
    ),
    onReject,
  });

  it('gecerli token icin claim modelini dondurur', async () => {
    const { authenticate, onReject } = make();

    const claims = await authenticate(ctx(bearer(accessToken({ organizationId: 'org-1' }))));

    expect(claims).toEqual({
      userId: 'user-1',
      role: 'apartment_manager',
      apartmentId: 'apt-1',
      organizationId: 'org-1',
    });
    expect(onReject).not.toHaveBeenCalled();
  });

  it('suresi dolmus token reddedilir', async () => {
    const { authenticate, onReject } = make();

    const claims = await authenticate(ctx(bearer(accessToken({ exp: now() - 100, iat: now() - 3700 }))));

    expect(claims).toBeNull();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0]![0]).toBeInstanceOf(JwtExpiredError);
  });

  it('baska anahtarla imzalanmis token reddedilir', async () => {
    const { authenticate, onReject } = make();

    expect(await authenticate(ctx(bearer(accessToken({}, otherKey))))).toBeNull();
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['yanlis client_id', { client_id: 'baska-client' }],
    ['yanlis issuer', { iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_Baska' }],
    ['id token (access bekleniyor)', { token_use: 'id' }],
  ])('%s reddedilir', async (_label, overrides) => {
    const { authenticate } = make();
    expect(await authenticate(ctx(bearer(accessToken(overrides))))).toBeNull();
  });

  it('token olmayan veya bozuk istek dogrulayiciya hic gitmez', async () => {
    const verify = vi.fn();
    const authenticate = createCognitoAuthenticator(
      { userPoolId: POOL_ID, clientId: CLIENT_ID },
      { verifier: { verify } },
    );

    expect(await authenticate(ctx())).toBeNull();
    expect(await authenticate(ctx({ authorization: 'Basic abc' }))).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('bozuk JWT metni reddedilir', async () => {
    const { authenticate } = make();
    expect(await authenticate(ctx(bearer('bu.bir.jwt.degil')))).toBeNull();
  });

  it('rol claim\'i eksik veya gecersizse reddedilir', async () => {
    const { authenticate } = make();

    expect(await authenticate(ctx(bearer(accessToken({ role: undefined }))))).toBeNull();
    expect(await authenticate(ctx(bearer(accessToken({ role: 'superuser' }))))).toBeNull();
  });

  it('apartmentId eksikse kimlik gecerlidir ama apartman baglami yoktur', async () => {
    const { authenticate } = make();

    const claims = await authenticate(ctx(bearer(accessToken({ apartmentId: undefined }))));

    expect(claims).toMatchObject({ userId: 'user-1', role: 'apartment_manager' });
    expect(claims?.apartmentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mock mod
// ---------------------------------------------------------------------------

describe('createMockAuthenticator', () => {
  const authenticate = createMockAuthenticator();

  it('mock token ile claim cozer', async () => {
    const token = encodeMockToken({ sub: 'dev-1', role: 'observer', apartmentId: 'apt-9' });

    expect(await authenticate(ctx(bearer(token)))).toEqual({
      userId: 'dev-1',
      role: 'observer',
      apartmentId: 'apt-9',
      organizationId: undefined,
    });
  });

  it('mock olmayan, bozuk veya gecersiz rollu token reddedilir', async () => {
    expect(await authenticate(ctx())).toBeNull();
    expect(await authenticate(ctx(bearer(accessToken())))).toBeNull();
    expect(await authenticate(ctx(bearer('mock.%%%')))).toBeNull();
    expect(await authenticate(ctx(bearer('mock.bm90LWpzb24')))).toBeNull();
    expect(await authenticate(ctx(bearer(encodeMockToken({ sub: 'x', role: 'root' }))))).toBeNull();
    expect(await authenticate(ctx(bearer(encodeMockToken({ role: 'observer' }))))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ortam degiskenlerinden secim
// ---------------------------------------------------------------------------

describe('createAuthenticatorFromEnv', () => {
  const log = () => ({ warn: vi.fn() });

  it('hicbir sey ayarli degilse varsayilan olarak hepsini reddeder', () => {
    expect(createAuthenticatorFromEnv({}, log())).toBe(denyAll);
    expect(createAuthenticatorFromEnv({ AUTH_MODE: 'deny' }, log())).toBe(denyAll);
  });

  it('apigw modu API Gateway claim okuyucusunu kullanir', () => {
    expect(createAuthenticatorFromEnv({ AUTH_MODE: 'apigw' }, log())).toBe(apiGatewayAuthenticator);
  });

  it('mock modu gelistirmede calisir ve uyari yazar', async () => {
    const logger = log();
    const authenticate = createAuthenticatorFromEnv({ AUTH_MODE: 'mock' }, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const token = encodeMockToken({ sub: 'dev', role: 'apartment_manager', apartmentId: 'a' });
    expect(await authenticate(ctx(bearer(token)))).toMatchObject({ userId: 'dev' });
  });

  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['Lambda ortami', { AWS_LAMBDA_FUNCTION_NAME: 'bm-api' }],
  ])('mock modu %s icinde baslangicta hata verir', (_label, extra) => {
    expect(() => createAuthenticatorFromEnv({ AUTH_MODE: 'mock', ...extra }, log())).toThrow(
      /mock/,
    );
  });

  it('cognito modu: havuz ve client yoksa hata, varsa dogrulayici olusturur', () => {
    expect(() => createAuthenticatorFromEnv({ AUTH_MODE: 'cognito' }, log())).toThrow(
      /COGNITO_USER_POOL_ID/,
    );
    expect(() =>
      createAuthenticatorFromEnv({ AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: POOL_ID }, log()),
    ).toThrow(/COGNITO_CLIENT_ID/);

    const env = { COGNITO_USER_POOL_ID: POOL_ID, COGNITO_CLIENT_ID: CLIENT_ID };
    // AUTH_MODE verilmese de havuz tanimliysa cognito secilir.
    expect(createAuthenticatorFromEnv(env, log())).toBeTypeOf('function');
    expect(createAuthenticatorFromEnv(env, log())).not.toBe(denyAll);
  });

  it('gecersiz AUTH_MODE ve COGNITO_TOKEN_USE baslangicta hata verir', () => {
    expect(() => createAuthenticatorFromEnv({ AUTH_MODE: 'herkes' }, log())).toThrow(/AUTH_MODE/);
    expect(() =>
      createAuthenticatorFromEnv(
        {
          AUTH_MODE: 'cognito',
          COGNITO_USER_POOL_ID: POOL_ID,
          COGNITO_CLIENT_ID: CLIENT_ID,
          COGNITO_TOKEN_USE: 'refresh',
        },
        log(),
      ),
    ).toThrow(/COGNITO_TOKEN_USE/);
  });
});

// ---------------------------------------------------------------------------
// Uctan uca: createApp + Cognito dogrulayici
// ---------------------------------------------------------------------------

describe('korumali rotalar (JWT ile)', () => {
  let getSite: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    getSite = vi.fn(async (apartmentId: string) => ({ PK: `APT#${apartmentId}`, SK: 'SITE', siteId: apartmentId }));
    app = createApp({
      version: 'test',
      coreService: { getSite } as unknown as CoreService,
      authenticate: createCognitoAuthenticator(
        { userPoolId: POOL_ID, clientId: CLIENT_ID },
        { verifier: createVerifier() },
      ),
    });
  });

  const get = async (path: string, token?: string) => {
    const res = await app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  it('gecerli token ile istek basarili olur; apartman JWT claim\'inden gelir', async () => {
    const res = await get('/api/sites', accessToken());

    expect(res.status).toBe(200);
    expect(res.json.items[0]).toMatchObject({ siteId: 'apt-1' });
    expect(getSite).toHaveBeenCalledWith('apt-1');
  });

  it('token yok, suresi dolmus veya rolsuz ise 401 doner', async () => {
    expect((await get('/api/sites')).status).toBe(401);
    expect((await get('/api/sites', accessToken({ exp: now() - 100 }))).status).toBe(401);
    expect((await get('/api/sites', accessToken({ role: undefined }))).status).toBe(401);
  });

  it('apartmentId claim\'i yoksa apartman rotalari 403, liste bos doner', async () => {
    const token = accessToken({ apartmentId: undefined });

    expect((await get('/api/sites/apt-1', token)).status).toBe(403);
    const list = await get('/api/sites', token);
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([]);
  });

  it('baska apartmanin URL\'i token apartmaniyla eslesmezse 403 doner', async () => {
    const res = await get('/api/sites/apt-2', accessToken());
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('forbidden');
  });

  it('health endpoint\'i kimlik gerektirmez', async () => {
    expect((await get('/api/health')).status).toBe(200);
  });
});
