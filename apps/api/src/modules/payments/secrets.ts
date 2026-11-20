/**
 * Odeme saglayicisi anahtarlarinin okunmasi. Anahtarlar koda gomulmez:
 *   - Lambda: PAYMENTS_SECRET_ARN -> AWS Secrets Manager, JSON `{ "apiKey": "...", "secretKey": "..." }`
 *   - Yerel : IYZICO_API_KEY / IYZICO_SECRET_KEY ortam degiskenleri
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

export function secretsManagerCredentials(
  secretArn: string,
  options: { client?: Pick<SecretsManagerClient, 'send'>; now?: () => number } = {},
): () => Promise<IyzicoCredentials> {
  const client = options.client ?? new SecretsManagerClient({});
  const now = options.now ?? Date.now;
  let cached: { value: IyzicoCredentials; at: number } | undefined;
  let inflight: Promise<IyzicoCredentials> | undefined;

  async function load(): Promise<IyzicoCredentials> {
    try {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      return parseCredentials(out.SecretString);
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
  if (!apiKey || !secretKey) throw new Error('IYZICO_API_KEY ve IYZICO_SECRET_KEY tanimli olmali (veya PAYMENTS_SECRET_ARN)');
  return async () => ({ apiKey, secretKey });
}
