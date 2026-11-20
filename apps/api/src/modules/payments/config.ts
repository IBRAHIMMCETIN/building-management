import { type FakePaymentProvider, createFakePaymentProvider } from './fakeProvider.js';
import { IYZICO_BASE_URLS, createIyzicoClient } from './iyzico/client.js';
import { createIyzicoProvider } from './iyzico/provider.js';
import type { PaymentProvider } from './provider.js';
import { envCredentials, secretsManagerCredentials } from './secrets.js';

/**
 * Ortam degiskenleri:
 *   PAYMENTS_PROVIDER       bos/`disabled` (varsayilan) | `fake` (yerel) | `iyzico`
 *   PAYMENTS_API_BASE_URL   API'nin disaridan adresi (callback), ornegin http://localhost:3000
 *   WEB_APP_URL             odeme sonrasi donus, ornegin https://building-management-apx.pages.dev
 *   PAYMENTS_INTENT_TTL_MINUTES  saglayici sayfasinin gecerliligi (varsayilan 30)
 * iyzico icin ek olarak:
 *   IYZICO_BASE_URL         https://sandbox-api.iyzipay.com | https://api.iyzipay.com
 *   PAYMENTS_SECRET_ARN     Secrets Manager (Lambda)  -- veya --
 *   IYZICO_API_KEY / IYZICO_SECRET_KEY (yalnizca yerel gelistirme)
 * Yanlis yapilandirma soguk baslangicta hata verir; sessizce calismaz. Anahtarin kendisi ilk
 * istekte okunur (soguk baslangicta Secrets Manager cagrisi yapilmaz).
 */
export type PaymentsRuntimeConfig = {
  provider?: PaymentProvider;
  fake?: FakePaymentProvider;
  apiBaseUrl: string;
  webAppUrl: string;
  intentTtlMinutes: number;
};

function requireUrl(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} ortam degiskeni tanimli degil (PAYMENTS_PROVIDER acik)`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} gecerli bir URL degil`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`${key} https olmali`);
  }
  return value.replace(/\/+$/, '');
}

export function loadPaymentsConfig(env: NodeJS.ProcessEnv = process.env): PaymentsRuntimeConfig {
  const name = (env.PAYMENTS_PROVIDER ?? '').trim();
  const ttl = Number(env.PAYMENTS_INTENT_TTL_MINUTES ?? 30);
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 120) throw new Error('PAYMENTS_INTENT_TTL_MINUTES 5-120 olmali');

  if (name === '' || name === 'disabled') {
    return { apiBaseUrl: 'http://localhost:3000', webAppUrl: 'http://localhost:5173', intentTtlMinutes: ttl };
  }
  if (name !== 'fake' && name !== 'iyzico') throw new Error(`Bilinmeyen PAYMENTS_PROVIDER: ${name}`);
  const apiBaseUrl = requireUrl(env, 'PAYMENTS_API_BASE_URL');
  const webAppUrl = requireUrl(env, 'WEB_APP_URL');

  if (name === 'fake') {
    if (env.NODE_ENV === 'production') {
      throw new Error('PAYMENTS_PROVIDER=fake production ortaminda kullanilamaz');
    }
    const fake = createFakePaymentProvider({ apiBaseUrl });
    return { provider: fake, fake, apiBaseUrl, webAppUrl, intentTtlMinutes: ttl };
  }

  const baseUrl = (env.IYZICO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrl !== IYZICO_BASE_URLS.sandbox && baseUrl !== IYZICO_BASE_URLS.live) {
    throw new Error(`IYZICO_BASE_URL ${IYZICO_BASE_URLS.sandbox} veya ${IYZICO_BASE_URLS.live} olmali`);
  }
  const secretArn = env.PAYMENTS_SECRET_ARN?.trim();
  const credentials = secretArn ? secretsManagerCredentials(secretArn) : envCredentials(env);
  const provider = createIyzicoProvider({
    client: createIyzicoClient({ baseUrl, credentials }),
    sandbox: baseUrl === IYZICO_BASE_URLS.sandbox,
  });
  return { provider, apiBaseUrl, webAppUrl, intentTtlMinutes: ttl };
}
