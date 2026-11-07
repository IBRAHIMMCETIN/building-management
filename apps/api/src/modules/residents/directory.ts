import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  type AttributeType,
  CognitoIdentityProviderClient,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Kullanici dizini portu. Servis Cognito'ya dogrudan bagli degildir; testlerde sahte
 * dizin enjekte edilir.
 */
export type UserDirectory = {
  /**
   * E-postaya ait kullaniciyi bulur; yoksa olusturur ve Cognito gecici sifre e-postasini
   * gonderir (ilk giriste NEW_PASSWORD_REQUIRED). Var olan kullaniciya e-posta GITMEZ.
   */
  findOrCreate(input: { email: string; fullName: string }): Promise<{ userId: string; created: boolean }>;
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
 * e-postadir. Gereken IAM: cognito-idp:AdminGetUser, cognito-idp:AdminCreateUser.
 */
export function createCognitoDirectory(
  userPoolId: string,
  client: Pick<CognitoIdentityProviderClient, 'send'> = new CognitoIdentityProviderClient({}),
): UserDirectory {
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
    async findOrCreate({ email, fullName }) {
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
            DesiredDeliveryMediums: ['EMAIL'],
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

/** Ortamdan: COGNITO_USER_POOL_ID yoksa davet devre disi (503). */
export function createDirectoryFromEnv(env: NodeJS.ProcessEnv = process.env): UserDirectory {
  const poolId = env.COGNITO_USER_POOL_ID;
  if (!poolId) {
    return {
      findOrCreate: async () => {
        throw new DirectoryUnavailableError();
      },
    };
  }
  return createCognitoDirectory(poolId);
}
