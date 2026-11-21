import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';

/**
 * Istek bagli denetim baglami (AsyncLocalStorage).
 *
 * `app.ts` her istegi bir baglamla sarar (requestId, kisaltilmis IP, kisaltilmis User-Agent);
 * kimlik dogrulamasi sonrasi aktor (kullanici, rol, destek oturumu) eklenir. Repository
 * katmanindaki denetim yazimi bu bilgiyi okur: servis imzalarini degistirmeden her hassas
 * yazim, kimin / nereden / hangi istekle yapildigini tasir. Istek disi isler (zamanlayici,
 * worker) baglamsizdir; aktor `system` olur.
 *
 * KVKK: IP adresi tam saklanmaz (IPv4 /24, IPv6 /48), User-Agent en fazla 200 karakter.
 */

export type AuditActor = {
  userId: string;
  role: string;
  /** `platform_admin` destek oturumu ile yapilan istek. */
  supportSessionId?: string;
};

export type RequestContext = {
  requestId: string;
  /** Kisaltilmis (maskeli) IP. */
  ip?: string;
  /** Kisaltilmis User-Agent. */
  userAgent?: string;
  actor?: AuditActor;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Kimlik dogrulandiktan sonra aktoru baglama yazar (baglam yoksa etkisiz). */
export function setRequestActor(actor: AuditActor): void {
  const ctx = storage.getStore();
  if (ctx) ctx.actor = actor;
}

export const USER_AGENT_MAX = 200;

/** IPv4 -> /24 (son oktet 0), IPv6 -> /48 (ilk 3 grup). Gecersizse undefined. */
export function maskIp(raw: string | undefined | null): string | undefined {
  const ip = raw?.split(',')[0]?.trim();
  if (!ip) return undefined;
  const v4 = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const parts = v4.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (isIP(ip) === 6) {
    const groups = expandIpv6(ip);
    return groups ? `${groups.slice(0, 3).join(':')}::/48` : undefined;
  }
  return undefined;
}

function expandIpv6(ip: string): string[] | undefined {
  const [head = '', tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined && h.length !== 8) return undefined;
  const missing = 8 - h.length - t.length;
  if (missing < 0) return undefined;
  return [...h, ...Array<string>(missing).fill('0'), ...t].map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''));
}

/** Kontrol karakterleri temizlenmis, en fazla 200 karakter. */
export function truncateUserAgent(raw: string | undefined | null): string | undefined {
  // eslint-disable-next-line no-control-regex
  const ua = raw?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!ua) return undefined;
  return ua.length > USER_AGENT_MAX ? ua.slice(0, USER_AGENT_MAX) : ua;
}
