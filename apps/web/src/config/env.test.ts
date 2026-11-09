import { describe, expect, it } from 'vitest';
import { TEST_ENV, parseEnv } from './env';

const cognito = {
  VITE_AUTH_MODE: 'cognito',
  VITE_API_URL: 'https://api.example.com/',
  VITE_COGNITO_REGION: 'eu-north-1',
  VITE_COGNITO_USER_POOL_ID: 'eu-north-1_abc',
  VITE_COGNITO_USER_POOL_CLIENT: 'client',
};

describe('parseEnv', () => {
  it('cognito yapilandirmasini okur, API adresinin sondaki / isaretini kirpar', () => {
    expect(parseEnv(cognito, { MODE: 'development' })).toEqual({
      apiUrl: 'https://api.example.com',
      authMode: 'cognito',
      tokenUse: 'id',
      cognito: { region: 'eu-north-1', userPoolId: 'eu-north-1_abc', clientId: 'client' },
    });
  });

  it('gelistirme/production modunda eksik Cognito degeri acik hatayla durur', () => {
    expect(() => parseEnv({ VITE_AUTH_MODE: 'cognito' }, { MODE: 'development' })).toThrow(/cognito modunda zorunlu/);
    expect(() => parseEnv({}, { MODE: 'production', PROD: true })).toThrow(/VITE_COGNITO_REGION/);
  });

  it('test modunda eksik yapilandirma hata degil, mock test varsayilanlari', () => {
    expect(parseEnv({ VITE_AUTH_MODE: 'cognito' }, { MODE: 'test' })).toEqual(TEST_ENV);
    expect(TEST_ENV.authMode).toBe('mock');
  });

  it('mock kimlik production derlemesinde yasak', () => {
    expect(() => parseEnv({ VITE_AUTH_MODE: 'mock' }, { MODE: 'production', PROD: true })).toThrow(/production/);
    expect(parseEnv({ VITE_AUTH_MODE: 'mock' }, { MODE: 'development' }).authMode).toBe('mock');
  });
});
