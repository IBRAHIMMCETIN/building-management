import { type FakePaymentProvider, createFakePaymentProvider } from './fakeProvider.js';
import type { PaymentProvider } from './provider.js';

/**
 * Ortam degiskenleri:
 *   PAYMENTS_PROVIDER       bos/`disabled` (varsayilan) | `fake` (yerel) | `iyzico` (Adim 8b-2)
 *   PAYMENTS_API_BASE_URL   API'nin disaridan adresi (callback), ornegin http://localhost:3000
 *   WEB_APP_URL             odeme sonrasi donus, ornegin https://building-management-apx.pages.dev
 *   PAYMENTS_INTENT_TTL_MINUTES  saglayici sayfasinin gecerliligi (varsayilan 30)
 * Yanlis yapilandirma soguk baslangicta hata verir; sessizce calismaz.
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
  throw new Error('PAYMENTS_PROVIDER=iyzico henuz desteklenmiyor (Adim 8b-2)');
}
