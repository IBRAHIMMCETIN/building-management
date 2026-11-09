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
import { env } from '@/config/env';
import { AuthRequiredError } from '@/lib/api/errors';
import { AuthFlowError, toAuthFlowError } from './errors';
import { type AuthAdapter, type AuthSession, type SignInStep, decodeClaims } from './session';

/*
 * Cognito web istemcisi (infra/cognito.tf): ALLOW_USER_SRP_AUTH + ALLOW_REFRESH_TOKEN_AUTH,
 * gizli anahtar yok. SRP matematigi, challenge oturumu, token saklama/yenileme ve
 * cikista refresh token iptali (enable_token_revocation) Amplify Auth tarafindan yapilir.
 * Token'lar Amplify'in varsayilan deposunda (localStorage) tutulur; bu katman yalnizca
 * okur ve AuthSession'a cevirir.
 */
let configured = false;

/** Ilk kullanimda yapilandirilir; mock modunda Amplify hic yapilandirilmaz. */
function ensureConfigured() {
  if (configured) return;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: env.cognito.userPoolId,
        userPoolClientId: env.cognito.clientId,
        loginWith: { email: true },
      },
    },
  });
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
      // SMS MFA kapali, MFA OPTIONAL (zorunlu kurulum yok), self sign-up yok: buraya
      // dusmemeli. Dusersa sessizce gecmek yerine acik hata veririz.
      throw new AuthFlowError(
        out.nextStep.signInStep,
        'Bu giriş adımı henüz desteklenmiyor. Lütfen yöneticinizle iletişime geçin.',
      );
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

export const cognitoAuthAdapter: AuthAdapter = {
  async restore() {
    try {
      return await readSession();
    } catch {
      return null;
    }
  },

  signIn: ({ email, password }) =>
    guard(async () => {
      const attempt = () => signIn({ username: email, password, options: { authFlowType: 'USER_SRP_AUTH' } });
      try {
        return await toStep(await attempt());
      } catch (err) {
        // Amplify'da yarim kalmis/eski bir oturum varsa yeni giris reddedilir: temizleyip tekrar dene.
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
    let session: AuthSession | null = null;
    try {
      session = await readSession(true);
    } catch {
      session = null;
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

  confirmPasswordReset: ({ email, code, newPassword }) =>
    guard(() => confirmResetPassword({ username: email, confirmationCode: code, newPassword })),

  setActiveContext: (_current, context) =>
    guard(async () => {
      // Client'in write_attributes listesinde yalnizca bu iki ozel nitelik + name var.
      await updateUserAttributes({
        userAttributes: {
          'custom:active_apartment': context.apartmentId,
          'custom:active_role': context.role,
        },
      });
      // Refresh akisinda Pre Token Lambda yeniden calisir ve yeni tercihi yetkilere karsi dogrular.
      const session = await readSession(true);
      if (!session) throw new AuthRequiredError();
      return session;
    }),
};
