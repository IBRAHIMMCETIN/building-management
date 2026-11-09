import { z } from 'zod';

/**
 * Vite ortam degiskenleri tek noktada dogrulanir; eksik/yanlis yapilandirma
 * uygulama acilirken anlasilir bir hatayla durur (sessizce yanlis token gondermez).
 * Degerler Terraform `frontend_env` ciktisindan gelir.
 *
 * Test modu (Vitest, MODE=test): `.env.local` olmayan ortamlarda (CI) Cognito degerleri
 * eksik olabilir. Testler gercek kimlik saglayicisina baglanmadigi icin bu durumda hata
 * firlatilmaz; guvenli test varsayilanlari (mock kimlik) kullanilir. Varsayilanlar ayrica
 * vite.config.ts `test.env` ile de verilir; buradaki tolerans son savunma hattidir.
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

export type AppEnv = {
  apiUrl: string;
  authMode: 'cognito' | 'mock';
  tokenUse: 'id' | 'access';
  cognito: { region: string; userPoolId: string; clientId: string };
};

/** Test modunda yapilandirma eksikse kullanilan degerler: ag/Cognito'ya hic gidilmez. */
export const TEST_ENV: AppEnv = {
  apiUrl: '',
  authMode: 'mock',
  tokenUse: 'id',
  cognito: { region: 'eu-north-1', userPoolId: 'test-pool', clientId: 'test-client' },
};

type Meta = { MODE?: string; PROD?: boolean };

/** Saf ayristirici (birim test edilebilir). */
export function parseEnv(raw: Record<string, unknown>, meta: Meta): AppEnv {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    if (meta.MODE === 'test') return TEST_ENV;
    throw new Error(`Gecersiz ortam degiskenleri: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.VITE_AUTH_MODE === 'mock' && meta.PROD) {
    throw new Error('VITE_AUTH_MODE=mock production derlemesinde kullanilamaz');
  }
  return {
    apiUrl: parsed.data.VITE_API_URL,
    authMode: parsed.data.VITE_AUTH_MODE,
    tokenUse: parsed.data.VITE_COGNITO_TOKEN_USE,
    cognito: {
      region: parsed.data.VITE_COGNITO_REGION ?? '',
      userPoolId: parsed.data.VITE_COGNITO_USER_POOL_ID ?? '',
      clientId: parsed.data.VITE_COGNITO_USER_POOL_CLIENT ?? '',
    },
  };
}

export const env: Readonly<AppEnv> = parseEnv(import.meta.env, import.meta.env);

export type TokenUse = AppEnv['tokenUse'];
