import { z } from 'zod';

/**
 * Vite ortam degiskenleri tek noktada dogrulanir; eksik/yanlis yapilandirma
 * uygulama acilirken anlasilir bir hatayla durur (sessizce yanlis token gondermez).
 * Degerler Terraform `frontend_env` ciktisindan gelir.
 */
const schema = z
  .object({
    VITE_API_URL: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v.replace(/\/+$/, '') : '')),
    VITE_AUTH_MODE: z.enum(['cognito', 'mock']).default('cognito'),
    VITE_COGNITO_REGION: z.string().trim().optional(),
    VITE_COGNITO_USER_POOL_ID: z.string().trim().optional(),
    VITE_COGNITO_USER_POOL_CLIENT: z.string().trim().optional(),
    // LITE katmaninda Pre Token V1: rol/apartman claim'leri yalnizca ID token'da.
    VITE_COGNITO_TOKEN_USE: z.enum(['id', 'access']).default('id'),
  })
  .superRefine((env, ctx) => {
    if (env.VITE_AUTH_MODE !== 'cognito') return;
    for (const key of ['VITE_COGNITO_REGION', 'VITE_COGNITO_USER_POOL_ID', 'VITE_COGNITO_USER_POOL_CLIENT'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'cognito modunda zorunlu' });
    }
  });

const parsed = schema.safeParse(import.meta.env);
if (!parsed.success) {
  throw new Error(`Gecersiz ortam degiskenleri: ${z.prettifyError(parsed.error)}`);
}

if (parsed.data.VITE_AUTH_MODE === 'mock' && import.meta.env.PROD) {
  throw new Error('VITE_AUTH_MODE=mock production derlemesinde kullanilamaz');
}

export const env = {
  apiUrl: parsed.data.VITE_API_URL,
  authMode: parsed.data.VITE_AUTH_MODE,
  tokenUse: parsed.data.VITE_COGNITO_TOKEN_USE,
  cognito: {
    region: parsed.data.VITE_COGNITO_REGION ?? '',
    userPoolId: parsed.data.VITE_COGNITO_USER_POOL_ID ?? '',
    clientId: parsed.data.VITE_COGNITO_USER_POOL_CLIENT ?? '',
  },
} as const;

export type TokenUse = typeof env.tokenUse;
