import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUserGlobalSignOutCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  SetUserMFAPreferenceCommand,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { MfaError } from './errors.js';

/**
 * Kimlik saglayici portu (TOTP / software token MFA). Servis Cognito'ya dogrudan bagli
 * degildir; testlerde ve yerel `AUTH_MODE=mock`'ta sahte saglayici kullanilir.
 *
 * Kullanicinin kendi kurulumu (associate / verify / enable) KULLANICININ access token'i ile
 * yapilir: Cognito token'i kendisi dogrular ve IAM yetkisi gerekmez. Yonetici islemleri
 * (durum okuma, sifirlama) API rolunun IAM yetkisiyle ve kullanicinin `sub`'i ile yapilir.
 */
export type MfaProvider = {
  readonly kind: 'cognito' | 'mock';
  /** TOTP etkin mi. Kullanici yoksa MfaError('not_found'). */
  isEnabled(userId: string): Promise<boolean>;
  /** Yeni TOTP gizli anahtari (onceki kurulmamis anahtar gecersizlesir). */
  associate(accessToken: string): Promise<{ secretCode: string }>;
  /** Uygulamadaki 6 haneli kodu dogrular (anahtar kullaniciya baglanir). */
  verify(accessToken: string, code: string, deviceName: string): Promise<void>;
  /** TOTP'yi etkin ve tercih edilen MFA yapar (sonraki girislerde kod sorulur). */
  enable(accessToken: string): Promise<void>;
  /** Cihaz kaybi: TOTP'yi kapatir ve tum oturumlari (refresh token'lar) dusurur. */
  adminReset(userId: string): Promise<void>;
  /** Kullanici `platform_admin` group'unda mi (yonetici sifirlamasi icin). */
  isPlatformAdmin(userId: string): Promise<boolean>;
};

function mapCognitoError(err: unknown): never {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      throw new MfaError('invalid_code', 'Doğrulama kodu hatalı. Uygulamadaki güncel kodu girin.', { cause: err });
    case 'SoftwareTokenMFANotFoundException':
      throw new MfaError('setup_not_started', 'Önce kurulumu başlatıp QR kodunu okutun.', { cause: err });
    case 'NotAuthorizedException':
    case 'InvalidParameterException':
      throw new MfaError('access_token_invalid', 'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.', { cause: err });
    case 'UserNotFoundException':
      throw new MfaError('not_found', 'Kullanıcı bulunamadı', { cause: err });
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      throw new MfaError('rate_limited', 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.', { cause: err });
    default:
      throw err;
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return mapCognitoError(err);
  }
}

/**
 * Cognito uygulamasi. Gereken IAM (yalnizca bu havuz): cognito-idp:AdminGetUser,
 * cognito-idp:AdminListGroupsForUser, cognito-idp:AdminSetUserMFAPreference,
 * cognito-idp:AdminUserGlobalSignOut. Kullanici islemleri access token ile (IAM gerekmez).
 */
export function createCognitoMfaProvider(
  userPoolId: string,
  client: Pick<CognitoIdentityProviderClient, 'send'> = new CognitoIdentityProviderClient({}),
): MfaProvider {
  return {
    kind: 'cognito',
    isEnabled: (userId) =>
      guard(async () => {
        const out = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: userId }));
        return (out.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA');
      }),
    associate: (accessToken) =>
      guard(async () => {
        const out = await client.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }));
        if (!out.SecretCode) throw new MfaError('unavailable', 'Doğrulayıcı anahtarı alınamadı');
        return { secretCode: out.SecretCode };
      }),
    verify: (accessToken, code, deviceName) =>
      guard(async () => {
        const out = await client.send(
          new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: code, FriendlyDeviceName: deviceName }),
        );
        if (out.Status !== 'SUCCESS') {
          throw new MfaError('invalid_code', 'Doğrulama kodu hatalı. Uygulamadaki güncel kodu girin.');
        }
      }),
    enable: (accessToken) =>
      guard(async () => {
        await client.send(
          new SetUserMFAPreferenceCommand({
            AccessToken: accessToken,
            SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
          }),
        );
      }),
    adminReset: (userId) =>
      guard(async () => {
        await client.send(
          new AdminSetUserMFAPreferenceCommand({
            UserPoolId: userPoolId,
            Username: userId,
            SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
          }),
        );
        // Kaybolan cihazda acik kalmis oturumlar da gecersiz olsun (refresh token'lar iptal).
        await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: userId }));
      }),
    isPlatformAdmin: (userId) =>
      guard(async () => {
        let next: string | undefined;
        do {
          const out = await client.send(
            new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: userId, NextToken: next }),
          );
          if (out.Groups?.some((g) => g.GroupName === 'platform_admin')) return true;
          next = out.NextToken;
        } while (next);
        return false;
      }),
  };
}

/** Sahte saglayicida sabit dogrulama kodu (web mock adaptoru ile ayni). */
export const MOCK_TOTP_CODE = '123456';
const MOCK_SECRET = 'JBSWY3DPEHPK3PXPMOCKDEVSECRET234';

/**
 * YALNIZCA yerel gelistirme ve testler: bellek ici. Anahtar sabittir, kod `123456`.
 * Gercek bir TOTP dogrulamasi yapmaz; production'da (Lambda) kullanilmaz.
 */
export function createMockMfaProvider(seed: { enabled?: string[]; platformAdmins?: string[] } = {}): MfaProvider & {
  enabledUsers: Set<string>;
  resets: string[];
} {
  const enabledUsers = new Set(seed.enabled ?? []);
  const pending = new Set<string>();
  const verified = new Set<string>();
  const resets: string[] = [];
  // Mock token `mock.<base64url(JSON)>`: kullanici kimligi `sub`.
  const subOf = (token: string) => {
    try {
      const raw = JSON.parse(Buffer.from(token.replace(/^mock\./, '').split('.').at(-1) ?? '', 'base64url').toString('utf8'));
      return typeof raw.sub === 'string' ? raw.sub : token;
    } catch {
      return token;
    }
  };
  return {
    kind: 'mock',
    enabledUsers,
    resets,
    async isEnabled(userId) {
      return enabledUsers.has(userId);
    },
    async associate(token) {
      pending.add(subOf(token));
      return { secretCode: MOCK_SECRET };
    },
    async verify(token, code) {
      const sub = subOf(token);
      if (!pending.has(sub)) throw new MfaError('setup_not_started', 'Önce kurulumu başlatıp QR kodunu okutun.');
      if (code !== MOCK_TOTP_CODE) throw new MfaError('invalid_code', 'Doğrulama kodu hatalı. Uygulamadaki güncel kodu girin.');
      verified.add(sub);
    },
    async enable(token) {
      const sub = subOf(token);
      if (!verified.has(sub)) throw new MfaError('setup_not_started', 'Önce kurulumu başlatıp QR kodunu okutun.');
      enabledUsers.add(sub);
    },
    async adminReset(userId) {
      enabledUsers.delete(userId);
      resets.push(userId);
    },
    async isPlatformAdmin(userId) {
      return (seed.platformAdmins ?? []).includes(userId);
    },
  };
}
