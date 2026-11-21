/**
 * Odeme saglayicisi anahtarlarinin okunmasi. Anahtarlar koda gomulmez:
 *   - iyzico Lambda: IYZICO_SECRET_ARN (eski ad PAYMENTS_SECRET_ARN) -> Secrets Manager,
 *     JSON `{ "apiKey": "...", "secretKey": "..." }`; yerel: IYZICO_API_KEY / IYZICO_SECRET_KEY
 *   - PayTR Lambda: PAYTR_SECRET_ARN -> Secrets Manager,
 *     JSON `{ "merchantId": "...", "merchantKey": "...", "merchantSalt": "..." }`;
 *     yerel: PAYTR_MERCHANT_ID / PAYTR_MERCHANT_KEY / PAYTR_MERCHANT_SALT
 * Secrets Manager degeri 5 dakika bellekte tutulur (sicak Lambda'da her istekte cagri yapilmaz);
 * anahtar dondurulunce en gec 5 dakikada yenisi kullanilir.
 */
import {
  DecryptionFailure,
  GetSecretValueCommand,
  InvalidRequestException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { IyzicoCredentials } from './iyzico/client.js';
import type { PaytrCredentials } from './paytr/client.js';
import { PaymentProviderError } from './provider.js';

export const SECRET_CACHE_MS = 5 * 60_000;

function parseCredentials(raw: string | undefined): IyzicoCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '');
  } catch {
    throw new PaymentProviderError('config', 'Odeme anahtari JSON degil ({"apiKey","secretKey"} bekleniyor)');
  }
  const o = value as Record<string, unknown>;
  if (typeof o?.apiKey !== 'string' || !o.apiKey || typeof o.secretKey !== 'string' || !o.secretKey) {
    throw new PaymentProviderError('config', 'Odeme anahtarinda apiKey/secretKey eksik');
  }
  return { apiKey: o.apiKey, secretKey: o.secretKey };
}

/** PayTR magaza anahtarlari: `{ merchantId, merchantKey, merchantSalt }`. */
export function parsePaytrCredentials(raw: string | undefined): PaytrCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '');
  } catch {
    throw new PaymentProviderError('config', 'PayTR anahtari JSON degil ({"merchantId","merchantKey","merchantSalt"} bekleniyor)');
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const id = typeof o.merchantId === 'number' ? String(o.merchantId) : o.merchantId;
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id) || typeof o.merchantKey !== 'string' || !o.merchantKey || typeof o.merchantSalt !== 'string' || !o.merchantSalt) {
    throw new PaymentProviderError('config', 'PayTR anahtarinda merchantId/merchantKey/merchantSalt eksik veya gecersiz');
  }
  return { merchantId: id, merchantKey: o.merchantKey, merchantSalt: o.merchantSalt };
}

type SecretOptions = { client?: Pick<SecretsManagerClient, 'send'>; now?: () => number };

export function secretsManagerCredentials(secretArn: string, options: SecretOptions = {}): () => Promise<IyzicoCredentials> {
  return secretsManagerJson(secretArn, parseCredentials, options);
}

export function secretsManagerPaytrCredentials(secretArn: string, options: SecretOptions = {}): () => Promise<PaytrCredentials> {
  return secretsManagerJson(secretArn, parsePaytrCredentials, options);
}

/** Secrets Manager'daki JSON degeri ayristirip 5 dakika bellekte tutar (es zamanli tek okuma). */
export function secretsManagerJson<T>(secretArn: string, parse: (raw: string | undefined) => T, options: SecretOptions = {}): () => Promise<T> {
  const client = options.client ?? new SecretsManagerClient({});
  const now = options.now ?? Date.now;
  let cached: { value: T; at: number } | undefined;
  let inflight: Promise<T> | undefined;

  async function load(): Promise<T> {
    try {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      return parse(out.SecretString);
    } catch (err) {
      if (err instanceof PaymentProviderError) throw err;
      if (err instanceof ResourceNotFoundException) {
        throw new PaymentProviderError('config', 'Odeme anahtari (secret) bulunamadi veya degeri girilmemis');
      }
      if (err instanceof DecryptionFailure || err instanceof InvalidRequestException) {
        throw new PaymentProviderError('config', 'Odeme anahtari okunamadi');
      }
      throw new PaymentProviderError('secrets_unavailable', 'Odeme anahtari gecici olarak okunamadi', true);
    }
  }

  return async () => {
    if (cached && now() - cached.at < SECRET_CACHE_MS) return cached.value;
    inflight ??= load().finally(() => {
      inflight = undefined;
    });
    const value = await inflight;
    cached = { value, at: now() };
    return value;
  };
}

export function envCredentials(env: NodeJS.ProcessEnv): () => Promise<IyzicoCredentials> {
  const apiKey = env.IYZICO_API_KEY?.trim();
  const secretKey = env.IYZICO_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) throw new Error('IYZICO_API_KEY ve IYZICO_SECRET_KEY tanimli olmali (veya IYZICO_SECRET_ARN)');
  return async () => ({ apiKey, secretKey });
}

export function envPaytrCredentials(env: NodeJS.ProcessEnv): () => Promise<PaytrCredentials> {
  const merchantId = env.PAYTR_MERCHANT_ID?.trim();
  const merchantKey = env.PAYTR_MERCHANT_KEY?.trim();
  const merchantSalt = env.PAYTR_MERCHANT_SALT?.trim();
  if (!merchantId || !merchantKey || !merchantSalt) {
    throw new Error('PAYTR_MERCHANT_ID, PAYTR_MERCHANT_KEY ve PAYTR_MERCHANT_SALT tanimli olmali (veya PAYTR_SECRET_ARN)');
  }
  const value = parsePaytrCredentials(JSON.stringify({ merchantId, merchantKey, merchantSalt }));
  return async () => value;
}
