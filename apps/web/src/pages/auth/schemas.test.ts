import { describe, expect, it } from 'vitest';
import { forgotConfirmSchema, newPasswordFormSchema } from './schemas';

describe('sifre semalari (Cognito politikasi)', () => {
  it.each([
    ['kisa1A', false],
    ['tumukucuk123', false],
    ['TUMUBUYUK123', false],
    ['RakamYokHarfVar', false],
    ['GecerliSifre1', true],
  ])('%s -> %s', (pw, ok) => {
    expect(newPasswordFormSchema.safeParse({ newPassword: pw, confirmPassword: pw }).success).toBe(ok);
  });

  it('tekrar alani eslesmeli', () => {
    const r = newPasswordFormSchema.safeParse({ newPassword: 'GecerliSifre1', confirmPassword: 'GecerliSifre2' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['confirmPassword']);
  });

  it('sifirlama kodu 6 hane', () => {
    const base = { newPassword: 'GecerliSifre1', confirmPassword: 'GecerliSifre1' };
    expect(forgotConfirmSchema.safeParse({ ...base, code: '12345' }).success).toBe(false);
    expect(forgotConfirmSchema.safeParse({ ...base, code: ' 123456 ' }).success).toBe(true);
  });
});

describe('e-posta', () => {
  it('bosluklu ve buyuk harfli girisi normalize edip kabul eder', async () => {
    const { loginSchema } = await import('./schemas');
    expect(loginSchema.parse({ email: '  Ayse@Site.COM ', password: 'x' }).email).toBe('ayse@site.com');
  });
});
