import { z } from 'zod';

// Once kirp/kucult, sonra dogrula (z.email().trim() bicimi kirpmadan once denetler).
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Geçerli bir e-posta adresi girin.'));

/** Cognito parola politikasi ile ayni (infra/cognito.tf password_policy). */
export const PASSWORD_RULES = [
  { test: (v: string) => v.length >= 10, label: 'En az 10 karakter' },
  { test: (v: string) => /[a-z]/.test(v), label: 'Bir küçük harf (a-z)' },
  { test: (v: string) => /[A-Z]/.test(v), label: 'Bir büyük harf (A-Z)' },
  { test: (v: string) => /\d/.test(v), label: 'Bir rakam' },
] as const;

export const newPasswordSchema = z
  .string()
  .refine((v) => PASSWORD_RULES.every((r) => r.test(v)), 'Şifre, aşağıdaki kuralların tümünü karşılamalı.');

const passwordsMatch = (v: { newPassword: string; confirmPassword: string }) => v.newPassword === v.confirmPassword;
const mismatch = { path: ['confirmPassword'], message: 'Şifreler eşleşmiyor.' };

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Şifre gerekli.'),
});

export const newPasswordFormSchema = z
  .object({ newPassword: newPasswordSchema, confirmPassword: z.string() })
  .refine(passwordsMatch, mismatch);

export const totpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, '6 haneli kodu girin.'),
});

export const forgotRequestSchema = z.object({ email: emailSchema });

export const forgotConfirmSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'E-postanıza gelen 6 haneli kodu girin.'),
    newPassword: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, mismatch);

export type LoginInput = z.infer<typeof loginSchema>;
export type NewPasswordFormInput = z.infer<typeof newPasswordFormSchema>;
export type TotpInput = z.infer<typeof totpSchema>;
export type ForgotRequestInput = z.infer<typeof forgotRequestSchema>;
export type ForgotConfirmInput = z.infer<typeof forgotConfirmSchema>;
