import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  type AttributeType,
  CognitoIdentityProviderClient,
  UnsupportedUserStateException,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Kullanici dizini portu. Servis Cognito'ya dogrudan bagli degildir; testlerde sahte
 * dizin enjekte edilir.
 */
export type FindOrCreateResult = {
  userId: string;
  created: boolean;
  /** YALNIZCA mock dizin: yerel testte ilk giris icin gecici sifre. Cognito'da e-postayla gider. */
  temporaryPassword?: string;
};

export type UserDirectory = {
  /**
   * E-postaya ait kullaniciyi bulur; yoksa olusturur ve Cognito gecici sifre e-postasini
   * gonderir (ilk giriste NEW_PASSWORD_REQUIRED). Var olan kullaniciya e-posta GITMEZ.
   */
  findOrCreate(input: { email: string; fullName: string; sendInvitation?: boolean }): Promise<FindOrCreateResult>;
  /**
   * Sessiz olusturulmus (sendInvitation: false) ve henuz ilk girisini yapmamis kullaniciya
   * gecici sifre e-postasini gonderir. Hesabini zaten etkinlestirmis kullaniciya gitmez.
   */
  resendInvitation(email: string): Promise<'sent' | 'not_pending'>;
  /** Dizin turu (yanitta yerel test ipucu gostermek icin). */
  readonly kind?: 'cognito' | 'mock';
};

export class DirectoryUnavailableError extends Error {
  constructor(message = 'Davet servisi yapilandirilmamis') {
    super(message);
    this.name = 'DirectoryUnavailableError';
  }
}

const attr = (attrs: AttributeType[] | undefined, name: string) => attrs?.find((a) => a.Name === name)?.Value;

/**
 * Cognito uygulamasi. Havuz `username_attributes = ["email"]` oldugu icin kullanici adi
 * e-postadir. Gereken IAM: cognito-idp:AdminGetUser, cognito-idp:AdminCreateUser
 * (davet yeniden gonderme de AdminCreateUser + MessageAction=RESEND ile yapilir).
 */
export function createCognitoDirectory(
  userPoolId: string,
  client: Pick<CognitoIdentityProviderClient, 'send'> = new CognitoIdentityProviderClient({}),
): UserDirectory {
  const kind = 'cognito' as const;
  async function find(email: string): Promise<string | undefined> {
    try {
      const out = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
      return attr(out.UserAttributes, 'sub');
    } catch (err) {
      if (err instanceof UserNotFoundException) return undefined;
      throw err;
    }
  }

  return {
    kind,
    async resendInvitation(email) {
      try {
        await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: email,
            MessageAction: 'RESEND',
            DesiredDeliveryMediums: ['EMAIL'],
          }),
        );
        return 'sent';
      } catch (err) {
        // Kullanici sifresini belirlemis (CONFIRMED): davet gerekmez.
        if (err instanceof UnsupportedUserStateException) return 'not_pending';
        throw err;
      }
    },
    async findOrCreate({ email, fullName, sendInvitation = true }) {
      const existing = await find(email);
      if (existing) return { userId: existing, created: false };

      try {
        const out = await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              // Yonetici e-postayi biliyor ve gecici sifre o adrese gidiyor: giris, sahipligi kanitlar.
              { Name: 'email_verified', Value: 'true' },
              { Name: 'name', Value: fullName },
            ],
            // Toplu aktarimda once sessiz olusturulur; yonetici kontrol ettikten sonra
            // resendInvitation ile gonderilir (gonderilmis e-posta geri alinamaz).
            ...(sendInvitation ? { DesiredDeliveryMediums: ['EMAIL'] as ['EMAIL'] } : { MessageAction: 'SUPPRESS' as const }),
          }),
        );
        const sub = attr(out.User?.Attributes, 'sub');
        if (!sub) throw new Error('Olusturulan Cognito kullanicisinda sub yok');
        return { userId: sub, created: true };
      } catch (err) {
        // Es zamanli iki davet: digeri once olusturduysa onu kullan.
        if (err instanceof UsernameExistsException) {
          const sub = await find(email);
          if (sub) return { userId: sub, created: false };
        }
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Yerel gelistirme (mock)
// ---------------------------------------------------------------------------

/**
 * Mock kullanici kimligi: e-postadan deterministik. Web'in mock girisi de ayni kurali
 * kullanir (`mock-<e-postanin yerel kismi>`), boylece davet edilen kisi yerelde ayni
 * e-postayla girdiginde uyelik kayitlari onunla eslesir.
 */
export function mockUserId(email: string): string {
  const local = (email.split('@')[0] ?? '').replace(/\+.*/, '');
  const safe = local.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 59) || 'user';
  return `mock-${safe}`;
}

function mockTemporaryPassword(): string {
  // Cognito politikasina uygun (10+ karakter, buyuk/kucuk harf, rakam); yalnizca yerel.
  return `Gecici${Math.floor(10000 + Math.random() * 90000)}`;
}

/**
 * Cognito olmadan yerel davet: kullanici olusturulmaz, e-posta gonderilmez. Ayni surec
 * icinde ikinci davet "mevcut kullanici" sayilir. Gecici sifre konsola ve yanita yazilir.
 */
export function createMockDirectory(log: Pick<Console, 'info'> = console): UserDirectory {
  const known = new Set<string>();
  return {
    kind: 'mock',
    async findOrCreate({ email, sendInvitation = true }) {
      const userId = mockUserId(email);
      if (known.has(email)) return { userId, created: false };
      known.add(email);
      const temporaryPassword = mockTemporaryPassword();
      log.info(
        `[mock davet] ${email} -> ${userId}, gecici sifre: ${temporaryPassword} (e-posta gonderilmedi${sendInvitation ? '' : ', sessiz'})`,
      );
      return { userId, created: true, temporaryPassword };
    },
    async resendInvitation(email) {
      log.info(`[mock davet] ${email}: davet yeniden gonderildi (e-posta gonderilmedi)`);
      return 'sent';
    },
  };
}

/**
 * Ortamdan secim:
 *  - COGNITO_USER_POOL_ID varsa: Cognito.
 *  - AUTH_MODE=mock ve production/Lambda degilse: mock dizin (yerel test).
 *  - Aksi halde: davet devre disi (503).
 */
export function createDirectoryFromEnv(env: NodeJS.ProcessEnv = process.env): UserDirectory {
  const poolId = env.COGNITO_USER_POOL_ID;
  if (poolId) return createCognitoDirectory(poolId);
  if (env.AUTH_MODE === 'mock' && env.NODE_ENV !== 'production' && !env.AWS_LAMBDA_FUNCTION_NAME) {
    return createMockDirectory();
  }
  const unavailable = async (): Promise<never> => {
    throw new DirectoryUnavailableError();
  };
  return { findOrCreate: unavailable, resendInvitation: unavailable };
}
