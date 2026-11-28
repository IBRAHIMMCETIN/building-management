import type { Role } from '@bm/shared/roles';
import type { SessionClaims, SignInStep } from '@bm/shared/auth/session';

/*
 * Cok adimli giris akisi (web: apps/web/src/pages/auth/LoginPage.tsx `Stage`). Mobilde her adim
 * ayri ekrandir (giris -> yeni sifre -> MFA); hangi adimda olundugu ve e-posta bu durumda tutulur.
 * Cognito challenge oturumunun kendisi adapter'dadir (Amplify bellegi / mock).
 */

export type AuthStage = 'credentials' | 'newPassword' | 'totp';

export type AuthFlowState = {
  stage: AuthStage;
  /** Son girilen e-posta (adim ekranlarinda gosterilir, sifre sifirlamaya tasinir). */
  email: string;
  /** Giris ekraninda bir kez gosterilecek bilgi (ornek: sifre guncellendi). */
  notice?: string;
  /** Sifre sifirlama ekranina tasinan aciklama (yonetici sifreyi sifirlamis). */
  resetNotice?: string;
};

export type AuthFlowAction =
  | { type: 'submitted'; email: string }
  | { type: 'step'; step: SignInStep }
  | { type: 'restart' }
  | { type: 'passwordReset'; email: string }
  | { type: 'clearNotice' };

export const initialAuthFlow: AuthFlowState = { stage: 'credentials', email: '' };

export const RESET_REQUIRED_NOTICE = 'Şifreniz yönetici tarafından sıfırlandı. Yeni şifre belirlemek için kod isteyin.';
export const PASSWORD_UPDATED_NOTICE = 'Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.';

export function authFlowReducer(state: AuthFlowState, action: AuthFlowAction): AuthFlowState {
  switch (action.type) {
    case 'submitted':
      return { stage: 'credentials', email: action.email.trim().toLowerCase() };
    case 'step':
      switch (action.step.type) {
        case 'done':
          return { ...initialAuthFlow, email: state.email };
        case 'newPasswordRequired':
          return { ...state, stage: 'newPassword', notice: undefined };
        case 'totpRequired':
          return { ...state, stage: 'totp', notice: undefined };
        case 'resetPasswordRequired':
          return { ...state, stage: 'credentials', resetNotice: RESET_REQUIRED_NOTICE };
      }
      return state;
    case 'restart':
      return { stage: 'credentials', email: state.email };
    case 'passwordReset':
      return { stage: 'credentials', email: action.email, notice: PASSWORD_UPDATED_NOTICE };
    case 'clearNotice':
      return { ...state, notice: undefined, resetNotice: undefined };
  }
}

/** Adimin acilacagi ekran; `done` icin null (oturum degisince yonlendirme kok yerlesimdedir). */
export function routeForStep(step: SignInStep): '/new-password' | '/mfa' | '/forgot-password' | null {
  switch (step.type) {
    case 'newPasswordRequired':
      return '/new-password';
    case 'totpRequired':
      return '/mfa';
    case 'resetPasswordRequired':
      return '/forgot-password';
    case 'done':
      return null;
  }
}

/** Mobil uygulamada role gore alan: sakin, guvenlik, gorevli; digerleri "panel web'de" ekrani. */
export type RoleArea = 'resident' | 'guard' | 'staff' | 'panel';

export function areaForRole(role: Role): RoleArea {
  if (role === 'resident') return 'resident';
  if (role === 'security_guard') return 'guard';
  if (role === 'building_staff') return 'staff';
  return 'panel';
}

export type SessionRoute = '/login' | '/select-context' | '/resident' | '/guard' | '/staff' | '/panel';

/** Oturuma gore acilis ekrani: oturum yok -> giris, rol yok -> baglam secimi, rol -> alani. */
export function homeRouteFor(claims: SessionClaims | null | undefined): SessionRoute {
  if (!claims) return '/login';
  if (!claims.role) return '/select-context';
  return `/${areaForRole(claims.role)}`;
}
