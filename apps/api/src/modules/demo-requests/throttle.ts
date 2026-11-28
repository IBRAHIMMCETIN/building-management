import { isIP } from 'node:net';
import type { IpMacer } from './ipMac.js';

/**
 * Demo talep formu icin sabit pencereli deneme sinirlari (gate/throttle.ts ile ayni desen):
 * DynamoDB'de kosullu `ADD count` sayaci, kayit `ttl` ile pencere bitiminden 1 saat sonra duser.
 *
 *   PK = `DEMOTHR#ip#<hmac>`    SK = `W#<pencere>`   istemci: IPv4 adresi / IPv6 /64   (1 saatte 5)
 *   PK = `DEMOTHR#net#<hmac>`   SK = `W#<pencere>`   ag: IPv4 /24 / IPv6 /48           (1 saatte 20)
 *   PK = `DEMOTHR#all`          SK = `W#<pencere>`   platform geneli, gunluk
 *
 * Platform geneli sayac bir bot dalgasinin formu herkese kapatmasini engellemek icin SERT degil:
 * `softLimit` (gunde 200) asilinca talep yine kaydedilir ama `suspect` isaretlenir ve
 * `DemoRequestSuspect` metrigi alarm uretir (infra/public_site.tf); yalnizca maliyet korumasi olan
 * `hardCap` (gunde 2.000) asilinca 429 doner.
 *
 * IP, API Gateway istek baglamindaki `sourceIp`'den alinir (istemci basligi `X-Forwarded-For`
 * Lambda'da DIKKATE ALINMAZ: sahtelenebilir). Ham IP saklanmaz: sayac anahtari gizli anahtarli HMAC'tir
 * (ipMac.ts). Sira: once istemci, sonra ag, en son platform sayaci; ilk dolu sayacta durulur.
 */

export type DemoThrottleLimits = {
  ip: { windowSeconds: number; limit: number };
  net: { windowSeconds: number; limit: number };
  global: { windowSeconds: number; softLimit: number; hardCap: number };
};

export const DEMO_THROTTLE: DemoThrottleLimits = {
  ip: { windowSeconds: 60 * 60, limit: 5 },
  net: { windowSeconds: 60 * 60, limit: 20 },
  global: { windowSeconds: 24 * 60 * 60, softLimit: 200, hardCap: 2000 },
};

export const THROTTLE_TTL_GRACE_SECONDS = 3600;

export type CounterStore = {
  /** `count < limit` iken 1 artirir; sinir doluysa `ok: false` (sayac artmaz). */
  hit(pk: string, sk: string, opts: { limit: number; ttl: number }): Promise<{ ok: boolean; count: number }>;
};

export type ThrottleScope = 'ip' | 'net' | 'global';

export class DemoRateLimitError extends Error {
  readonly code = 'rate_limited' as const;
  readonly httpStatus = 429 as const;
  constructor(
    readonly retryAfterSeconds: number,
    readonly scope: ThrottleScope,
  ) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      scope === 'global'
        ? `Şu anda çok fazla talep alıyoruz. ${minutes} dakika sonra tekrar deneyin.`
        : `Bu bağlantıdan çok fazla talep gönderildi. ${minutes} dakika sonra tekrar deneyin.`,
    );
    this.name = 'DemoRateLimitError';
  }
}

function expandIpv6(raw: string): string[] {
  const [head = '', tail] = raw.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].map((g) => g.replace(/^0+(?=.)/, ''));
}

function parse(ip: string | undefined): { v: 4; parts: string[] } | { v: 6; groups: string[] } | undefined {
  const raw = ip?.trim();
  if (!raw) return undefined;
  const v4 = raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  if (isIP(v4) === 4) return { v: 4, parts: v4.split('.') };
  if (isIP(raw) === 6) return { v: 6, groups: expandIpv6(raw) };
  return undefined;
}

/** Istemci kovasi: IPv4 tam adres, IPv6 /64; gecersiz veya bos ise `unknown`. */
export function clientBucket(ip: string | undefined): string {
  const p = parse(ip);
  if (!p) return 'unknown';
  return p.v === 4 ? p.parts.join('.') : `${p.groups.slice(0, 4).join(':')}::/64`;
}

/** Ag kovasi: IPv4 /24, IPv6 /48; gecersiz veya bos ise `unknown`. */
export function networkBucket(ip: string | undefined): string {
  const p = parse(ip);
  if (!p) return 'unknown';
  return p.v === 4 ? `${p.parts.slice(0, 3).join('.')}.0/24` : `${p.groups.slice(0, 3).join(':')}::/48`;
}

export const throttleKeys = {
  ip: (mac: string) => `DEMOTHR#ip#${mac}`,
  net: (mac: string) => `DEMOTHR#net#${mac}`,
  global: () => 'DEMOTHR#all',
  window: (start: number) => `W#${start}`,
};

function windowOf(nowMs: number, size: number) {
  const start = Math.floor(nowMs / 1000 / size) * size;
  return { start, end: start + size };
}

const retryAfter = (nowMs: number, end: number) => Math.max(1, Math.ceil(end - nowMs / 1000));

export function createDemoThrottle(deps: { store: CounterStore; macer: IpMacer; now: () => Date; limits?: DemoThrottleLimits }) {
  const limits = deps.limits ?? DEMO_THROTTLE;

  async function step(pk: string, size: number, limit: number, nowMs: number, scope: ThrottleScope) {
    const w = windowOf(nowMs, size);
    const res = await deps.store.hit(pk, throttleKeys.window(w.start), { limit, ttl: w.end + THROTTLE_TTL_GRACE_SECONDS });
    if (!res.ok) throw new DemoRateLimitError(retryAfter(nowMs, w.end), scope);
    return res.count;
  }

  return {
    /**
     * Kaydedilecek talep basina bir puan; dolu sayacta `DemoRateLimitError`. `suspect`: platform geneli
     * gunluk olagan hacim (`softLimit`) asildi (talep yine kaydedilir, alarm uretilir).
     */
    async consume(ip: string | undefined): Promise<{ suspect: boolean }> {
      const nowMs = deps.now().getTime();
      const [ipMac, netMac] = await Promise.all([deps.macer.mac(`ip:${clientBucket(ip)}`), deps.macer.mac(`net:${networkBucket(ip)}`)]);
      await step(throttleKeys.ip(ipMac), limits.ip.windowSeconds, limits.ip.limit, nowMs, 'ip');
      await step(throttleKeys.net(netMac), limits.net.windowSeconds, limits.net.limit, nowMs, 'net');
      const count = await step(throttleKeys.global(), limits.global.windowSeconds, limits.global.hardCap, nowMs, 'global');
      return { suspect: count > limits.global.softLimit };
    },
  };
}

export type DemoThrottle = ReturnType<typeof createDemoThrottle>;
