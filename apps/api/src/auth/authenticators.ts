import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Context } from 'hono';
import { type Authenticator, apiGatewayAuthenticator, claimsFromRecord, denyAll } from './claims.js';

/** `Authorization: Bearer <token>` basliginden token'i cikarir. */
export function bearerToken(c: Context): string | undefined {
  const header = c.req.header('authorization');
  return header ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;
}

// ---------------------------------------------------------------------------
// Cognito JWT (EC2/Node veya API Gateway disi dogrudan calisma)
// ---------------------------------------------------------------------------

export type TokenVerifier = { verify(token: string): Promise<unknown> };

export type CognitoAuthConfig = {
  userPoolId: string;
  clientId: string;
  /**
   * 'access' (varsayilan) veya 'id'. Ozel claim'ler (`apartmentId`, `role`) access token'a
   * ancak Pre Token Generation V2 trigger'i ile eklenir; V1 yalnizca ID token'i degistirir.
   */
  tokenUse?: 'access' | 'id';
};

/**
 * Imza (JWKS), issuer, sure, token_use ve client_id dogrulanir. Dogrulama basarisizsa
 * (suresi dolmus, bozuk, yanlis havuz...) null doner; ayrinti yalnizca `onReject`'e gider.
 */
export function createCognitoAuthenticator(
  config: CognitoAuthConfig,
  options: { verifier?: TokenVerifier; onReject?: (err: unknown) => void } = {},
): Authenticator {
  const verifier: TokenVerifier =
    options.verifier ??
    CognitoJwtVerifier.create({
      userPoolId: config.userPoolId,
      clientId: config.clientId,
      tokenUse: config.tokenUse ?? 'access',
    });

  return async (c) => {
    const token = bearerToken(c);
    if (!token) return null;
    try {
      return claimsFromRecord(await verifier.verify(token));
    } catch (err) {
      options.onReject?.(err);
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Yerel gelistirme (mock)
// ---------------------------------------------------------------------------

const MOCK_PREFIX = 'mock.';

/** `mock.<base64url(JSON claim'ler)>` bicimli gelistirme token'i uretir. */
export function encodeMockToken(claims: Record<string, unknown>): string {
  return MOCK_PREFIX + Buffer.from(JSON.stringify(claims)).toString('base64url');
}

/** Imza dogrulamasi YAPMAZ; yalnizca yerel gelistirme icindir. Rol yine dogrulanir. */
export function createMockAuthenticator(): Authenticator {
  return (c) => {
    const token = bearerToken(c);
    if (!token?.startsWith(MOCK_PREFIX)) return null;
    try {
      const json = Buffer.from(token.slice(MOCK_PREFIX.length), 'base64url').toString('utf8');
      return claimsFromRecord(JSON.parse(json));
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Ortam degiskenlerinden secim
// ---------------------------------------------------------------------------

/**
 * AUTH_MODE:
 *  - `cognito`: COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID (+ COGNITO_TOKEN_USE) ile JWT dogrular.
 *    AUTH_MODE verilmeyip COGNITO_USER_POOL_ID varsa bu mod secilir.
 *  - `apigw`: API Gateway JWT authorizer'in claim'lerini okur (Lambda).
 *  - `mock`: yerel gelistirme; production/Lambda ortaminda baslangicta hata verir.
 *  - `deny` (varsayilan): tum korumali istekler 401.
 * Yanlis yapilandirma sessizce gecmez, uygulama baslarken hata verir.
 */
export function createAuthenticatorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn'> = console,
): Authenticator {
  const mode = env.AUTH_MODE ?? (env.COGNITO_USER_POOL_ID ? 'cognito' : 'deny');

  switch (mode) {
    case 'cognito': {
      const { COGNITO_USER_POOL_ID: userPoolId, COGNITO_CLIENT_ID: clientId } = env;
      if (!userPoolId || !clientId) {
        throw new Error('AUTH_MODE=cognito icin COGNITO_USER_POOL_ID ve COGNITO_CLIENT_ID gerekli');
      }
      const tokenUse = env.COGNITO_TOKEN_USE ?? 'access';
      if (tokenUse !== 'access' && tokenUse !== 'id') {
        throw new Error("COGNITO_TOKEN_USE 'access' veya 'id' olmalidir");
      }
      return createCognitoAuthenticator(
        { userPoolId, clientId, tokenUse },
        {
          onReject: (err) =>
            log.warn(`JWT reddedildi: ${err instanceof Error ? err.constructor.name : 'bilinmeyen hata'}`),
        },
      );
    }
    case 'apigw':
      return apiGatewayAuthenticator;
    case 'mock':
      if (env.NODE_ENV === 'production' || env.AWS_LAMBDA_FUNCTION_NAME) {
        throw new Error('AUTH_MODE=mock production/Lambda ortaminda kullanilamaz');
      }
      log.warn('UYARI: AUTH_MODE=mock aktif; JWT imzasi dogrulanmiyor (yalnizca yerel gelistirme)');
      return createMockAuthenticator();
    case 'deny':
      return denyAll;
    default:
      throw new Error(`Gecersiz AUTH_MODE: ${mode} (cognito | apigw | mock | deny)`);
  }
}
