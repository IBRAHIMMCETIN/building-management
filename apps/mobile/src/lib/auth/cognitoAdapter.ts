import { AuthRequiredError, NetworkError } from '@bm/shared/api/errors';
import { AuthFlowError, toAuthFlowError } from '@bm/shared/auth/errors';
import { type AuthAdapter, type AuthSession, type SignInStep, decodeClaims } from '@bm/shared/auth/session';
import { Amplify } from 'aws-amplify';
import {
  type SignInOutput,
  confirmResetPassword,
  confirmSignIn,
  fetchAuthSession,
  resetPassword,
  signIn,
  signOut,
  updateUserAttributes,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { secureStorage } from '../storage/secureStorage';
import type { KeyValueStorage } from '../storage/types';
import { isAuthRejection, isNetworkFailure } from './errors';

/*
 * Cognito (Amplify v6, React Native). Akislar web ile ayni (apps/web/src/lib/auth/cognitoAdapter.ts):
 * SRP girisi, NEW_PASSWORD_REQUIRED, TOTP, sifre sifirlama kodu, baglam secimi (ozel nitelik +
 * token yenileme), cikista refresh token iptali. Fark: token'lar Amplify'in varsayilani olan
 * AsyncStorage yerine guvenli depoda (Keychain / Keystore; web onizlemesinde localStorage).
 *
 * Native'de @aws-amplify/react-native (SRP icin native modul + crypto/URL polyfill'leri) gerekir:
 * Expo Go'da CALISMAZ, gelistirme derlemesi (expo-dev-client / EAS) ister. Mock modda bu modul hic
 * yuklenmez (adapter.ts tembel import eder).
 */

export type CognitoConfig = { userPoolId: string; clientId: string };

/** Amplify'in token anahtarlari (aws-amplify TokenStore: `CognitoIdentityServiceProvider.<istemci>.<kullanici>.<token>`). */
const AMPLIFY_PREFIX = 'CognitoIdentityServiceProvider';

/**
 * Saklanan son oturum, YENILEMEDEN (cevrimdisi acilis icin). Suresi dolmus olabilir: ilk API istegi
 * yenilemeyi dener; ag yoksa ag hatasi, kesin redde oturum kapanir.
 */
export async function readStoredSession(clientId: string, storage: KeyValueStorage): Promise<AuthSession | null> {
  try {
    const user = await storage.getItem(`${AMPLIFY_PREFIX}.${clientId}.LastAuthUser`);
    if (!user) return null;
    const [idToken, accessToken] = await Promise.all([
      storage.getItem(`${AMPLIFY_PREFIX}.${clientId}.${user}.idToken`),
      storage.getItem(`${AMPLIFY_PREFIX}.${clientId}.${user}.accessToken`),
    ]);
    const claims = idToken ? decodeClaims(idToken) : null;
    return idToken && accessToken && claims ? { idToken, accessToken, claims } : null;
  } catch {
    return null;
  }
}

export function createCognitoAuthAdapter(config: CognitoConfig, storage: KeyValueStorage = secureStorage): AuthAdapter {
  let configured = false;

  function ensureConfigured() {
    if (configured) return;
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.clientId,
          loginWith: { email: true },
        },
      },
    });
    cognitoUserPoolsTokenProvider.setKeyValueStorage(storage);
    configured = true;
  }

  async function readSession(forceRefresh = false): Promise<AuthSession | null> {
    ensureConfigured();
    const { tokens } = await fetchAuthSession({ forceRefresh });
    if (!tokens?.idToken || !tokens.accessToken) return null;
    const idToken = tokens.idToken.toString();
    const claims = decodeClaims(idToken);
    if (!claims) return null;
    return { idToken, accessToken: tokens.accessToken.toString(), claims };
  }

  async function toStep(out: SignInOutput): Promise<SignInStep> {
    switch (out.nextStep.signInStep) {
      case 'DONE': {
        const session = await readSession();
        if (!session) throw new AuthRequiredError();
        return { type: 'done', session };
      }
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        return { type: 'newPasswordRequired' };
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
        return { type: 'totpRequired' };
      case 'RESET_PASSWORD':
        return { type: 'resetPasswordRequired' };
      default:
        throw new AuthFlowError(out.nextStep.signInStep, 'Bu giriş adımı henüz desteklenmiyor. Lütfen yöneticinizle iletişime geçin.');
    }
  }

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    ensureConfigured();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      throw toAuthFlowError(err);
    }
  }

  return {
    async restore() {
      try {
        return await readSession();
      } catch (err) {
        // Cevrimdisi soguk acilis (suresi dolmus token yenilenemedi): saklanan token'larla acilir;
        // API istegi ag hatasi verir, baglanti gelince ilk istek yeniler. Diger hatalarda giris ekrani.
        return isNetworkFailure(err) ? readStoredSession(config.clientId, storage) : null;
      }
    },

    signIn: ({ email, password }) =>
      guard(async () => {
        const attempt = () => signIn({ username: email, password, options: { authFlowType: 'USER_SRP_AUTH' } });
        try {
          return await toStep(await attempt());
        } catch (err) {
          // Yarim kalmis/eski bir oturum varsa yeni giris reddedilir: temizleyip tekrar dene.
          if (err instanceof Error && err.name === 'UserAlreadyAuthenticatedException') {
            await signOut();
            return toStep(await attempt());
          }
          throw err;
        }
      }),

    confirmNewPassword: (newPassword) => guard(async () => toStep(await confirmSignIn({ challengeResponse: newPassword }))),

    confirmTotp: (code) => guard(async () => toStep(await confirmSignIn({ challengeResponse: code }))),

    async refresh() {
      let session: AuthSession | null;
      try {
        session = await readSession(true);
      } catch (err) {
        // Amplify kesin redde token'lari siler (NotAuthorized -> token yok); ag / gecici hatada korur.
        if (isAuthRejection(err)) throw new AuthRequiredError();
        if (isNetworkFailure(err)) throw new NetworkError(err);
        throw err;
      }
      if (!session) throw new AuthRequiredError();
      return session;
    },

    async signOut() {
      ensureConfigured();
      // Yerel token'lar her durumda temizlenir; iptal cagrisi basarisiz olsa da kullanici beklemez.
      await signOut().catch(() => undefined);
    },

    requestPasswordReset: (email) =>
      guard(async () => {
        const out = await resetPassword({ username: email });
        return { destination: out.nextStep.codeDeliveryDetails?.destination };
      }),

    confirmPasswordReset: ({ email, code, newPassword }) => guard(() => confirmResetPassword({ username: email, confirmationCode: code, newPassword })),

    setActiveContext: (_current, context) =>
      guard(async () => {
        await updateUserAttributes({
          userAttributes: {
            'custom:active_apartment': context.apartmentId,
            'custom:active_role': context.role,
          },
        });
        // Refresh akisinda Pre Token Lambda yeniden calisir ve tercihi yetkilere karsi dogrular.
        const session = await readSession(true);
        if (!session) throw new AuthRequiredError();
        return session;
      }),
  };
}
