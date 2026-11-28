import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Demo talep formu icin sabit pencereli deneme sinirlari (gate/throttle.ts ile ayni desen):
 * DynamoDB'de kosullu `ADD count` sayaci, kayit `ttl` ile pencere bitiminden 1 saat sonra duser.
 *
 *   PK = `DEMOTHR#ip#<ozet>`   SK = `W#<pencere baslangici>`   IP basina (1 saatte 5 talep)
 *   PK = `DEMOTHR#all`         SK = `W#<pencere baslangici>`   tum platform (gunde 200 talep)
 *
 * IP, API Gateway istek baglamindaki `sourceIp`'den alinir (istemci basligi `X-Forwarded-For`
 * Lambda'da DIKKATE ALINMAZ: sahtelenebilir). IPv6'da /64 oneki tek istemci sayilir (tek abone
 * genellikle butun /64'u kullanir). Ham IP saklanmaz: sayac anahtari tuzlu SHA-256 ozetidir.
 * Sira: once IP sayaci (asilirsa genel sayaca dokunulmaz), sonra genel sayac.
 */

export const DEMO_THROTTLE = {
  ip: { windowSeconds: 60 * 60, limit: 5 },
  global: { windowSeconds: 24 * 60 * 60, limit: 200 },
} as const;
export type DemoThrottleLimits = { ip: { windowSeconds: number; limit: number }; global: { windowSeconds: number; limit: number } };

export const THROTTLE_TTL_GRACE_SECONDS = 3600;

export type CounterStore = {
  /** `count < limit` iken 1 artirir; sinir doluysa `ok: false` (sayac artmaz). */
  hit(pk: string, sk: string, opts: { limit: number; ttl: number }): Promise<{ ok: boolean; count: number }>;
};

export class DemoRateLimitError extends Error {
  readonly code = 'rate_limited' as const;
  readonly httpStatus = 429 as const;
  constructor(
    readonly retryAfterSeconds: number,
    readonly scope: 'ip' | 'global',
  ) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      scope === 'ip'
        ? `Bu bağlantıdan çok fazla talep gönderildi. ${minutes} dakika sonra tekrar deneyin.`
        : `Şu anda çok fazla talep alıyoruz. ${minutes} dakika sonra tekrar deneyin.`,
    );
    this.name = 'DemoRateLimitError';
  }
}

/** IPv4 tam adres, IPv6 /64 oneki; gecersiz veya bos ise `unknown` (tum bilinmeyenler tek kovada). */
export function clientBucket(ip: string | undefined): string {
  const raw = ip?.trim();
  if (!raw) return 'unknown';
  const v4 = raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  if (isIP(v4) === 4) return v4;
  if (isIP(raw) === 6) {
    const [head = '', tail] = raw.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return `${groups
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, ''))
      .join(':')}::/64`;
  }
  return 'unknown';
}

export const throttleKeys = {
  ip: (bucket: string) => `DEMOTHR#ip#${createHash('sha256').update(`yonesist-demo:${bucket}`).digest('hex').slice(0, 32)}`,
  global: () => 'DEMOTHR#all',
  window: (start: number) => `W#${start}`,
};

function windowOf(nowMs: number, size: number) {
  const start = Math.floor(nowMs / 1000 / size) * size;
  return { start, end: start + size };
}

const retryAfter = (nowMs: number, end: number) => Math.max(1, Math.ceil(end - nowMs / 1000));

export function createDemoThrottle(deps: { store: CounterStore; now: () => Date; limits?: DemoThrottleLimits }) {
  const limits = deps.limits ?? DEMO_THROTTLE;
  return {
    /** Basarili istek basina bir puan; sinir doluysa `DemoRateLimitError`. */
    async consume(ip: string | undefined): Promise<void> {
      const nowMs = deps.now().getTime();
      const ipWindow = windowOf(nowMs, limits.ip.windowSeconds);
      const ipHit = await deps.store.hit(throttleKeys.ip(clientBucket(ip)), throttleKeys.window(ipWindow.start), {
        limit: limits.ip.limit,
        ttl: ipWindow.end + THROTTLE_TTL_GRACE_SECONDS,
      });
      if (!ipHit.ok) throw new DemoRateLimitError(retryAfter(nowMs, ipWindow.end), 'ip');
      const allWindow = windowOf(nowMs, limits.global.windowSeconds);
      const allHit = await deps.store.hit(throttleKeys.global(), throttleKeys.window(allWindow.start), {
        limit: limits.global.limit,
        ttl: allWindow.end + THROTTLE_TTL_GRACE_SECONDS,
      });
      if (!allHit.ok) throw new DemoRateLimitError(retryAfter(nowMs, allWindow.end), 'global');
    },
  };
}

export type DemoThrottle = ReturnType<typeof createDemoThrottle>;
