import { decodeClaims } from '@bm/shared/auth/session';
import { issueMockToken } from '@bm/shared/auth/mockScenarios';
import { PASSWORD_UPDATED_NOTICE, RESET_REQUIRED_NOTICE, areaForRole, authFlowReducer, homeRouteFor, initialAuthFlow, routeForStep } from './flow';

const session = (email: string) => {
  const token = issueMockToken(email);
  const claims = decodeClaims(token);
  if (!claims) throw new Error('claims');
  return { idToken: token, accessToken: token, claims };
};

describe('authFlowReducer', () => {
  it('giris gonderilince e-posta kucuk harfe cevrilir ve onceki bilgi notu temizlenir', () => {
    const state = authFlowReducer({ ...initialAuthFlow, notice: PASSWORD_UPDATED_NOTICE }, { type: 'submitted', email: ' Ayse@Site.COM ' });
    expect(state).toEqual({ stage: 'credentials', email: 'ayse@site.com' });
  });

  it('Cognito adimlarini ekran asamasina cevirir', () => {
    const base = authFlowReducer(initialAuthFlow, { type: 'submitted', email: 'a@b.c' });
    expect(authFlowReducer(base, { type: 'step', step: { type: 'newPasswordRequired' } }).stage).toBe('newPassword');
    expect(authFlowReducer(base, { type: 'step', step: { type: 'totpRequired' } }).stage).toBe('totp');
    const reset = authFlowReducer(base, { type: 'step', step: { type: 'resetPasswordRequired' } });
    expect(reset).toMatchObject({ stage: 'credentials', resetNotice: RESET_REQUIRED_NOTICE, email: 'a@b.c' });
    const done = authFlowReducer({ ...base, stage: 'totp' }, { type: 'step', step: { type: 'done', session: session('a@b.c') } });
    expect(done).toEqual({ stage: 'credentials', email: 'a@b.c' });
  });

  it('yeni sifre -> MFA zinciri ve bastan baslama', () => {
    let s = authFlowReducer(initialAuthFlow, { type: 'submitted', email: 'x+mfa@dev.local' });
    s = authFlowReducer(s, { type: 'step', step: { type: 'newPasswordRequired' } });
    s = authFlowReducer(s, { type: 'step', step: { type: 'totpRequired' } });
    expect(s.stage).toBe('totp');
    s = authFlowReducer(s, { type: 'restart' });
    expect(s).toEqual({ stage: 'credentials', email: 'x+mfa@dev.local' });
  });

  it('sifre sifirlaninca giris ekraninda bilgi notu ve e-posta', () => {
    const s = authFlowReducer(initialAuthFlow, { type: 'passwordReset', email: 'r@dev.local' });
    expect(s).toEqual({ stage: 'credentials', email: 'r@dev.local', notice: PASSWORD_UPDATED_NOTICE });
    expect(authFlowReducer(s, { type: 'clearNotice' }).notice).toBeUndefined();
  });
});

describe('yonlendirme', () => {
  it('adim -> ekran', () => {
    expect(routeForStep({ type: 'newPasswordRequired' })).toBe('/new-password');
    expect(routeForStep({ type: 'totpRequired' })).toBe('/mfa');
    expect(routeForStep({ type: 'resetPasswordRequired' })).toBe('/forgot-password');
    expect(routeForStep({ type: 'done', session: session('resident@dev.local') })).toBeNull();
  });

  it('role gore alan: sakin, guvenlik, gorevli; yonetim rolleri web paneli', () => {
    expect(areaForRole('resident')).toBe('resident');
    expect(areaForRole('security_guard')).toBe('guard');
    expect(areaForRole('building_staff')).toBe('staff');
    for (const role of ['apartment_manager', 'management_company', 'observer', 'platform_admin'] as const) expect(areaForRole(role)).toBe('panel');
  });

  it('oturuma gore acilis ekrani', () => {
    expect(homeRouteFor(null)).toBe('/login');
    expect(homeRouteFor(session('multi@dev.local').claims)).toBe('/select-context');
    expect(homeRouteFor(session('resident@dev.local').claims)).toBe('/resident');
    expect(homeRouteFor(session('security_guard@dev.local').claims)).toBe('/guard');
    expect(homeRouteFor(session('apartment_manager@dev.local').claims)).toBe('/panel');
  });
});
