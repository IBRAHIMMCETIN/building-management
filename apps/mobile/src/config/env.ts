import type { TokenUse } from '@bm/shared/auth/session';
import { z } from 'zod';

/**
 * Expo ortam degiskenleri tek noktada dogrulanir (web: apps/web/src/config/env.ts ile ayni kurallar).
 * EXPO_PUBLIC_* degerleri derleme aninda pakete gomulur; bu yuzden `process.env.X` ifadeleri
 * tek tek ve statik yazilir (Expo dinamik erisimi doldurmaz). Gizli bilgi tasimazlar.
 * Yapilandirma hataliysa uygulama acilista anlasilir bir hata ekrani gosterir (sessizce
 * yanlis token gondermez).
 */
const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v.replace(/\/+$/, '') : ''));

const schema = z
  .object({
    EXPO_PUBLIC_API_URL: optionalUrl,
    EXPO_PUBLIC_AUTH_MODE: z.enum(['cognito', 'mock']).default('cognito'),
    EXPO_PUBLIC_API_MODE: z.enum(['live', 'demo']).default('live'),
    EXPO_PUBLIC_COGNITO_REGION: z.string().trim().optional(),
    EXPO_PUBLIC_COGNITO_USER_POOL_ID: z.string().trim().optional(),
    EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT: z.string().trim().optional(),
    // LITE katmaninda Pre Token V1: rol/apartman claim'leri yalnizca ID token'da.
    EXPO_PUBLIC_COGNITO_TOKEN_USE: z.enum(['id', 'access']).default('id'),
    EXPO_PUBLIC_WEB_URL: optionalUrl,
  })
  .superRefine((env, ctx) => {
    if (env.EXPO_PUBLIC_AUTH_MODE === 'cognito') {
      for (const key of ['EXPO_PUBLIC_COGNITO_REGION', 'EXPO_PUBLIC_COGNITO_USER_POOL_ID', 'EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'cognito modunda zorunlu' });
      }
    }
    if (env.EXPO_PUBLIC_API_MODE === 'demo' && env.EXPO_PUBLIC_AUTH_MODE !== 'mock') {
      ctx.addIssue({ code: 'custom', path: ['EXPO_PUBLIC_API_MODE'], message: 'demo yalnizca EXPO_PUBLIC_AUTH_MODE=mock ile kullanilabilir' });
    }
    if (env.EXPO_PUBLIC_API_MODE === 'live' && !env.EXPO_PUBLIC_API_URL) {
      ctx.addIssue({ code: 'custom', path: ['EXPO_PUBLIC_API_URL'], message: 'API adresi zorunlu (demo modu disinda)' });
    }
  });

export type AppEnv = {
  apiUrl: string;
  authMode: 'cognito' | 'mock';
  /** `demo`: API'ye gidilmez, ornek veriyle calisir (yalnizca mock kimlik, web onizlemesi). */
  apiMode: 'live' | 'demo';
  tokenUse: TokenUse;
  cognito: { region: string; userPoolId: string; clientId: string };
  /** Web uygulamasinin koku (mobilde olmayan ekranlar ve online odeme). Bos olabilir. */
  webUrl: string;
};

export type EnvResult = { ok: true; env: AppEnv } | { ok: false; error: string };

/** Saf ayristirici (birim test edilebilir). `dev`: Metro gelistirme paketi (__DEV__). */
export function parseEnv(raw: Record<string, string | undefined>, meta: { dev: boolean }): EnvResult {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const d = parsed.data;
  if (d.EXPO_PUBLIC_AUTH_MODE === 'mock' && !meta.dev) {
    return { ok: false, error: 'EXPO_PUBLIC_AUTH_MODE=mock yalnizca gelistirme paketinde kullanilabilir (store / production derlemesinde reddedilir).' };
  }
  return {
    ok: true,
    env: {
      apiUrl: d.EXPO_PUBLIC_API_URL,
      authMode: d.EXPO_PUBLIC_AUTH_MODE,
      apiMode: d.EXPO_PUBLIC_API_MODE,
      tokenUse: d.EXPO_PUBLIC_COGNITO_TOKEN_USE,
      cognito: {
        region: d.EXPO_PUBLIC_COGNITO_REGION ?? '',
        userPoolId: d.EXPO_PUBLIC_COGNITO_USER_POOL_ID ?? '',
        clientId: d.EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT ?? '',
      },
      webUrl: d.EXPO_PUBLIC_WEB_URL,
    },
  };
}

export const envResult: EnvResult = parseEnv(
  {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_AUTH_MODE: process.env.EXPO_PUBLIC_AUTH_MODE,
    EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
    EXPO_PUBLIC_COGNITO_REGION: process.env.EXPO_PUBLIC_COGNITO_REGION,
    EXPO_PUBLIC_COGNITO_USER_POOL_ID: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID,
    EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT,
    EXPO_PUBLIC_COGNITO_TOKEN_USE: process.env.EXPO_PUBLIC_COGNITO_TOKEN_USE,
    EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL,
  },
  { dev: typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production' },
);

/**
 * Uygulamanin kullandigi yapilandirma. Hatali yapilandirmada kok yerlesim (app/_layout.tsx) hata
 * ekrani gosterir ve bu nesneye dayanan hicbir sey calismaz; guvenli (ag/Cognito'ya gitmeyen)
 * yer tutucu degerler doner.
 */
export const env: Readonly<AppEnv> = envResult.ok
  ? envResult.env
  : { apiUrl: '', authMode: 'mock', apiMode: 'demo', tokenUse: 'id', cognito: { region: '', userPoolId: '', clientId: '' }, webUrl: '' };
