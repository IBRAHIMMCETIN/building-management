import { parseEnv } from './env';
import { decodeUtf8, installPolyfills } from '../polyfills';

const cognito = {
  EXPO_PUBLIC_API_URL: 'https://api.test/',
  EXPO_PUBLIC_COGNITO_REGION: 'eu-north-1',
  EXPO_PUBLIC_COGNITO_USER_POOL_ID: 'eu-north-1_x',
  EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT: 'client',
};

describe('parseEnv', () => {
  it('cognito: zorunlu alanlar, sondaki / kirpilir, varsayilan token turu id', () => {
    const r = parseEnv({ ...cognito, EXPO_PUBLIC_WEB_URL: 'https://web.test///' }, { dev: false });
    expect(r).toEqual({
      ok: true,
      env: {
        apiUrl: 'https://api.test',
        authMode: 'cognito',
        apiMode: 'live',
        tokenUse: 'id',
        cognito: { region: 'eu-north-1', userPoolId: 'eu-north-1_x', clientId: 'client' },
        webUrl: 'https://web.test',
      },
    });
  });

  it('cognito modunda havuz bilgisi eksikse hata', () => {
    const r = parseEnv({ EXPO_PUBLIC_API_URL: 'https://api.test' }, { dev: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('EXPO_PUBLIC_COGNITO_USER_POOL_ID');
  });

  it('mock yalnizca gelistirme paketinde; demo yalnizca mock ile', () => {
    expect(parseEnv({ EXPO_PUBLIC_AUTH_MODE: 'mock', EXPO_PUBLIC_API_MODE: 'demo' }, { dev: true }).ok).toBe(true);
    expect(parseEnv({ EXPO_PUBLIC_AUTH_MODE: 'mock', EXPO_PUBLIC_API_MODE: 'demo' }, { dev: false }).ok).toBe(false);
    expect(parseEnv({ ...cognito, EXPO_PUBLIC_API_MODE: 'demo' }, { dev: true }).ok).toBe(false);
    expect(parseEnv({ EXPO_PUBLIC_AUTH_MODE: 'mock' }, { dev: true }).ok).toBe(false);
  });
});

describe('Hermes polyfill', () => {
  it("eksikse UTF-8 TextDecoder tanimlar; Turkce karakterler dogru cozulur", () => {
    const target: Record<string, unknown> = {};
    installPolyfills(target);
    const Decoder = target.TextDecoder as new () => { decode(b: Uint8Array): string };
    const bytes = new TextEncoder().encode('Çınar Apartmanı · ğüşöİ ₺ 🏠');
    expect(new Decoder().decode(bytes)).toBe('Çınar Apartmanı · ğüşöİ ₺ 🏠');
    expect(decodeUtf8(bytes)).toBe('Çınar Apartmanı · ğüşöİ ₺ 🏠');
  });

  it('var olan TextDecoder degistirilmez', () => {
    const existing = function TextDecoder() {};
    const target: Record<string, unknown> = { TextDecoder: existing };
    installPolyfills(target);
    expect(target.TextDecoder).toBe(existing);
  });
});
