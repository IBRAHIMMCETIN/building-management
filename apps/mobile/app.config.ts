import type { ConfigContext, ExpoConfig } from 'expo/config';

/*
 * Dinamik Expo yapilandirmasi. Sabit degerler (izin metinleri, eklentiler, ikonlar) app.json'da kalir;
 * Expo onu `config` olarak verir. Burada yalnizca derleme profiline gore degisenler ortamdan okunur
 * (eas.json `env` / EAS ortam degiskenleri / yerelde .env). Ortam bos ise bugunku degerler kalir.
 *
 *   APP_VARIANT       development | preview | production (varsayilan: production)
 *   APP_BUNDLE_ID     iOS paket kimligi kok degeri (varsayilan: app.json, com.yonesist.app)
 *   APP_PACKAGE       Android paket adi kok degeri (varsayilan: app.json, com.yonesist.app)
 *   EAS_PROJECT_ID    `eas init` ciktisi (push kaydi icin; gizli degil). Yoksa app.json extra.eas.projectId
 *   EXPO_OWNER        Expo hesabi / kurulus (istege bagli)
 *   GOOGLE_SERVICES_JSON  Android FCM dosyasinin yolu (EAS dosya ortam degiskeni; repoya girmez)
 *
 * development ve preview kimlikleri `.dev` / `.preview` sonekli: uc derleme ayni cihazda yan yana kurulur.
 * API / Cognito / web adresleri EXPO_PUBLIC_* olarak pakete gomulur ve src/config/env.ts'te dogrulanir;
 * gizli bilgi bu dosyaya da EXPO_PUBLIC_* degiskenlerine de yazilmaz.
 */

export const APP_VARIANTS = ['development', 'preview', 'production'] as const;
export type AppVariant = (typeof APP_VARIANTS)[number];

type Env = Record<string, string | undefined>;

export function appVariant(env: Env): AppVariant {
  const raw = env.APP_VARIANT?.trim();
  if (!raw) return 'production';
  if ((APP_VARIANTS as readonly string[]).includes(raw)) return raw as AppVariant;
  throw new Error(`APP_VARIANT gecersiz: "${raw}" (development | preview | production)`);
}

const SUFFIX: Record<AppVariant, string> = { development: '.dev', preview: '.preview', production: '' };
const NAME_SUFFIX: Record<AppVariant, string> = { development: ' (Geliştirme)', preview: ' (Test)', production: '' };
const SCHEME_SUFFIX: Record<AppVariant, string> = { development: '-dev', preview: '-preview', production: '' };

const clean = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

export function buildConfig(config: ExpoConfig, env: Env): ExpoConfig {
  const variant = appVariant(env);
  const bundleId = clean(env.APP_BUNDLE_ID) ?? config.ios?.bundleIdentifier ?? 'com.yonesist.app';
  const androidPackage = clean(env.APP_PACKAGE) ?? config.android?.package ?? 'com.yonesist.app';
  const extra = (config.extra ?? {}) as { eas?: { projectId?: string } } & Record<string, unknown>;
  const projectId = clean(env.EAS_PROJECT_ID) ?? clean(extra.eas?.projectId);
  const googleServicesFile = clean(env.GOOGLE_SERVICES_JSON) ?? config.android?.googleServicesFile;
  const scheme = typeof config.scheme === 'string' ? config.scheme : 'yonesist';
  const owner = clean(env.EXPO_OWNER) ?? config.owner;

  return {
    ...config,
    name: `${config.name}${NAME_SUFFIX[variant]}`,
    scheme: `${scheme}${SCHEME_SUFFIX[variant]}`,
    ...(owner ? { owner } : {}),
    ios: { ...config.ios, bundleIdentifier: `${bundleId}${SUFFIX[variant]}` },
    android: {
      ...config.android,
      package: `${androidPackage}${SUFFIX[variant]}`,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    extra: {
      ...extra,
      appVariant: variant,
      ...(projectId ? { eas: { ...extra.eas, projectId } } : {}),
    },
  };
}

export default ({ config }: ConfigContext): ExpoConfig => buildConfig(config as ExpoConfig, process.env);
