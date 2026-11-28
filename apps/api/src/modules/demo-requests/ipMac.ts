import { createHmac } from 'node:crypto';
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';

/**
 * Deneme sayaci anahtarlari icin IP ozeti. Duz SHA-256 (sabit, herkese acik tuzla) IPv4 uzayinda
 * kaba kuvvetle geri cevrilebilir; bu yuzden anahtar gizli bir HMAC'tir:
 *   - production: KMS HMAC_256 anahtari (`DEMO_IP_MAC_KEY_ID`, infra/public_site.tf); anahtar KMS'ten
 *     cikmaz, API rolu yalnizca `kms:GenerateMac` (HMAC_SHA_256) yapar,
 *   - yerel / test: bellek ici HMAC (`DEMO_IP_MAC_LOCAL_KEY` ile degistirilebilir).
 * Ayni istemci icin KMS cagrisi konteyner basina en fazla saatte bir yapilir (sinirli bellek onbellegi).
 * Production'da anahtar tanimsizsa macer yoktur ve form 503 doner (sessizce zayif ozete dusulmez).
 */

export const IP_MAC_ALGORITHM = 'HMAC_SHA_256';
const message = (bucket: string) => `demo-ip:v1|${bucket}`;

export type IpMacer = {
  readonly kind: 'kms' | 'local';
  /** `bucket` (ornegin `ip:203.0.113.7`, `net:203.0.113.0/24`) icin kisa, geri cevrilemez ozet. */
  mac(bucket: string): Promise<string>;
};

export class DemoUnavailableError extends Error {
  readonly code = 'unavailable' as const;
  readonly httpStatus = 503 as const;
  constructor(cause?: unknown) {
    super('Talep şu anda alınamıyor. Lütfen biraz sonra tekrar deneyin.', cause ? { cause } : undefined);
    this.name = 'DemoUnavailableError';
  }
}

export function createKmsIpMacer(options: { keyId: string; client: Pick<KMSClient, 'send'> }): IpMacer {
  return {
    kind: 'kms',
    async mac(bucket) {
      let out: { Mac?: Uint8Array } | undefined;
      try {
        out = await options.client.send(
          new GenerateMacCommand({ KeyId: options.keyId, MacAlgorithm: IP_MAC_ALGORITHM, Message: Buffer.from(message(bucket), 'utf8') }),
        );
      } catch (err) {
        throw new DemoUnavailableError(err);
      }
      if (!out?.Mac || out.Mac.byteLength === 0) throw new DemoUnavailableError();
      return `k1${Buffer.from(out.Mac).toString('hex').slice(0, 32)}`;
    },
  };
}

export function createLocalIpMacer(key = 'bm-local-demo-ip-mac-v1'): IpMacer {
  return {
    kind: 'local',
    async mac(bucket) {
      return `l1${createHmac('sha256', key).update(message(bucket), 'utf8').digest('hex').slice(0, 32)}`;
    },
  };
}

/** Konteyner ici sinirli onbellek (en fazla `max` kayit, `ttlMs` sure): ayni istemciye tekrar KMS cagrisi yok. */
export function withMacCache(macer: IpMacer, opts: { max?: number; ttlMs?: number; now?: () => number } = {}): IpMacer {
  const max = opts.max ?? 2000;
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: string; at: number }>();
  return {
    kind: macer.kind,
    async mac(bucket) {
      const hit = cache.get(bucket);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = await macer.mac(bucket);
      cache.delete(bucket);
      cache.set(bucket, { value, at: now() });
      if (cache.size > max) cache.delete(cache.keys().next().value as string);
      return value;
    },
  };
}

const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+$/;

export function loadIpMacer(env: NodeJS.ProcessEnv = process.env, kmsClient?: () => Pick<KMSClient, 'send'>): IpMacer | undefined {
  const keyId = env.DEMO_IP_MAC_KEY_ID?.trim();
  if (keyId) {
    if (!KMS_KEY_ARN.test(keyId)) throw new Error('DEMO_IP_MAC_KEY_ID gecerli bir KMS anahtar/alias ARN olmali');
    return withMacCache(createKmsIpMacer({ keyId, client: kmsClient ? kmsClient() : new KMSClient({}) }));
  }
  const isProd = env.NODE_ENV === 'production' || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  if (isProd) return undefined;
  return createLocalIpMacer(env.DEMO_IP_MAC_LOCAL_KEY?.trim() || undefined);
}
