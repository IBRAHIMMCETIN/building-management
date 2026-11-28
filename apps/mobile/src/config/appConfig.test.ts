import type { ExpoConfig } from 'expo/config';
import appJson from '../../app.json';
import { appVariant, buildConfig } from '../../app.config';
import eas from '../../eas.json';

const base = appJson.expo as unknown as ExpoConfig;

describe('app.config.ts', () => {
  it('ortam bosken bugunku degerler (production)', () => {
    const c = buildConfig(base, {});
    expect(c.name).toBe('YÖNESİST');
    expect(c.scheme).toBe('yonesist');
    expect(c.ios?.bundleIdentifier).toBe('com.yonesist.app');
    expect(c.android?.package).toBe('com.yonesist.app');
    expect(c.extra).toEqual({ appVariant: 'production' });
    expect(c.android?.googleServicesFile).toBeUndefined();
    // Sabit degerler app.json'dan aynen gelir.
    expect(c.plugins).toEqual(base.plugins);
    // iPad destegi acik; yon serbest (telefonda acilista dikey kilit: lib/orientation.ts).
    expect(c.orientation).toBe('default');
    expect(c.ios?.supportsTablet).toBe(true);
  });

  it('development / preview sonekli kimlik, ad ve sema (yan yana kurulum)', () => {
    const dev = buildConfig(base, { APP_VARIANT: 'development' });
    expect(dev.ios?.bundleIdentifier).toBe('com.yonesist.app.dev');
    expect(dev.android?.package).toBe('com.yonesist.app.dev');
    expect(dev.name).toBe('YÖNESİST (Geliştirme)');
    expect(dev.scheme).toBe('yonesist-dev');
    const preview = buildConfig(base, { APP_VARIANT: 'preview' });
    expect(preview.ios?.bundleIdentifier).toBe('com.yonesist.app.preview');
    expect(preview.android?.package).toBe('com.yonesist.app.preview');
    expect(preview.name).toBe('YÖNESİST (Test)');
  });

  it('paket kimligi, EAS proje kimligi, sahip ve FCM dosyasi ortamdan', () => {
    const c = buildConfig(base, {
      APP_BUNDLE_ID: 'tr.com.ornek.yonesist',
      APP_PACKAGE: 'tr.com.ornek.yonesist',
      EAS_PROJECT_ID: '00000000-0000-4000-8000-000000000000',
      EXPO_OWNER: 'ornek',
      GOOGLE_SERVICES_JSON: '/tmp/google-services.json',
    });
    expect(c.ios?.bundleIdentifier).toBe('tr.com.ornek.yonesist');
    expect(c.android?.package).toBe('tr.com.ornek.yonesist');
    expect(c.extra?.eas).toEqual({ projectId: '00000000-0000-4000-8000-000000000000' });
    expect(c.owner).toBe('ornek');
    expect(c.android?.googleServicesFile).toBe('/tmp/google-services.json');
  });

  it('FCM dosyasi varyanta ozel (her paket adinin kendi Firebase istemcisi); yoksa ortak dosya', () => {
    const env = { GOOGLE_SERVICES_JSON: '/eas/prod.json', GOOGLE_SERVICES_JSON_DEV: '/eas/dev.json', GOOGLE_SERVICES_JSON_PREVIEW: '/eas/preview.json' };
    expect(buildConfig(base, { ...env, APP_VARIANT: 'development' }).android?.googleServicesFile).toBe('/eas/dev.json');
    expect(buildConfig(base, { ...env, APP_VARIANT: 'preview' }).android?.googleServicesFile).toBe('/eas/preview.json');
    expect(buildConfig(base, env).android?.googleServicesFile).toBe('/eas/prod.json');
    expect(buildConfig(base, { APP_VARIANT: 'preview', GOOGLE_SERVICES_JSON: '/eas/all.json' }).android?.googleServicesFile).toBe('/eas/all.json');
  });

  it('app.json extra.eas.projectId korunur (eas init elle yazildiysa)', () => {
    const c = buildConfig({ ...base, extra: { eas: { projectId: 'from-app-json' } } }, {});
    expect(c.extra?.eas).toEqual({ projectId: 'from-app-json' });
  });

  it('gecersiz APP_VARIANT reddedilir', () => {
    expect(() => appVariant({ APP_VARIANT: 'staging' })).toThrow(/APP_VARIANT/);
    expect(appVariant({ APP_VARIANT: ' ' })).toBe('production');
  });

  it('eas.json profilleri: gelistirme istemcisi, dahili test ve magaza', () => {
    const b = eas.build as Record<string, { developmentClient?: boolean; distribution?: string; environment?: string; env?: Record<string, string> }>;
    expect(b.development).toMatchObject({ developmentClient: true, distribution: 'internal', env: { APP_VARIANT: 'development' } });
    expect(b.preview).toMatchObject({ distribution: 'internal', environment: 'preview', env: { APP_VARIANT: 'preview', EXPO_PUBLIC_AUTH_MODE: 'cognito' } });
    expect(b.production).toMatchObject({ environment: 'production', env: { APP_VARIANT: 'production', EXPO_PUBLIC_AUTH_MODE: 'cognito', EXPO_PUBLIC_API_MODE: 'live' } });
    // Profillerde gizli bilgi yok: yalnizca EXPO_PUBLIC_* ve APP_VARIANT.
    for (const p of Object.values(b)) for (const k of Object.keys(p.env ?? {})) expect(k).toMatch(/^(APP_VARIANT|EXPO_PUBLIC_(AUTH|API)_MODE)$/);
  });
});
