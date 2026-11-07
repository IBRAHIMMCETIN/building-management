// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_CODE, MOCK_TEMP_PASSWORD, mockAuthAdapter as auth } from './mockAdapter';

describe('mockAuthAdapter senaryolari', () => {
  beforeEach(() => localStorage.clear());

  it('tek apartmanli rol dogrudan baglamla girer', async () => {
    const step = await auth.signIn({ email: 'resident@dev.local', password: 'x' });
    expect(step.type === 'done' && step.session.claims).toMatchObject({ role: 'resident', apartmentId: 'apt-dev-1' });
  });

  it('coklu apartmanda rol claim\'i olmadan girer, secimle baglam alir', async () => {
    const step = await auth.signIn({ email: 'multi@dev.local', password: 'x' });
    if (step.type !== 'done') throw new Error('beklenmedik adim');
    expect(step.session.claims.role).toBeUndefined();

    const next = await auth.setActiveContext(step.session, { apartmentId: 'apt-dev-2', role: 'resident' });
    expect(next.claims).toMatchObject({ role: 'resident', apartmentId: 'apt-dev-2' });
    // Tercih kalici: yeniden yuklemede ayni baglam
    expect((await auth.restore())?.claims.apartmentId).toBe('apt-dev-2');
  });

  it('yetkisi olmayan baglam secilirse rol claim\'i uretilmez', async () => {
    const step = await auth.signIn({ email: 'multi@dev.local', password: 'x' });
    if (step.type !== 'done') throw new Error('beklenmedik adim');
    const next = await auth.setActiveContext(step.session, { apartmentId: 'apt-dev-2', role: 'apartment_manager' });
    expect(next.claims.role).toBeUndefined();
  });

  it('gecici sifre -> yeni sifre -> (+mfa) TOTP zinciri', async () => {
    expect(await auth.signIn({ email: 'resident+mfa@dev.local', password: MOCK_TEMP_PASSWORD })).toEqual({
      type: 'newPasswordRequired',
    });
    expect(await auth.confirmNewPassword('YeniSifre123')).toEqual({ type: 'totpRequired' });
    await expect(auth.confirmTotp('000000')).rejects.toMatchObject({ code: 'CodeMismatchException' });
    expect((await auth.confirmTotp(MOCK_CODE)).type).toBe('done');
  });

  it('sifre sifirlama kodu dogrulanir', async () => {
    expect(await auth.requestPasswordReset('ayse@site.com')).toEqual({ destination: 'a***@site.com' });
    await expect(auth.confirmPasswordReset({ email: 'ayse@site.com', code: '1', newPassword: 'x' })).rejects.toThrow();
    await expect(auth.confirmPasswordReset({ email: 'ayse@site.com', code: MOCK_CODE, newPassword: 'x' })).resolves.toBeUndefined();
  });
});
