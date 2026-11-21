/**
 * PayTR HTTP istemcisi (bagimliliksiz: Node `fetch` + `crypto`).
 *
 * Kimlik dogrulama (dev.paytr.com): her istekte `paytr_token`
 *   = base64(HMAC-SHA256(merchant_key, hash_str + merchant_salt))
 * `hash_str` servise ozgu alanlarin ayiricisiz birlesimidir. Istekler `application/x-www-form-urlencoded`,
 * yanitlar JSON'dur (`status: success | failed | error`). `merchant_key` ve `merchant_salt` istekte
 * GONDERILMEZ (PayTR'nin bazi ornek kodlari gonderse de gerekmez).
 *
 * Bildirim (webhook) imzasi farklidir: hash = base64(HMAC-SHA256(merchant_key,
 *   merchant_oid + merchant_salt + status + total_amount)).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Kurus, toKurus } from '../../core/types.js';
import { PaymentProviderError } from '../provider.js';

export type PaytrCredentials = { merchantId: string; merchantKey: string; merchantSalt: string };

export const PAYTR_BASE_URL = 'https://www.paytr.com';

export const PAYTR_PATHS = {
  token: '/odeme/api/get-token',
  status: '/odeme/durum-sorgu',
  refund: '/odeme/iade',
} as const;

/** iFrame odeme sayfasi: `https://www.paytr.com/odeme/guvenli/<token>`. */
export const paytrIframeUrl = (token: string, baseUrl: string = PAYTR_BASE_URL) =>
  `${baseUrl.replace(/\/+$/, '')}/odeme/guvenli/${encodeURIComponent(token)}`;

// ---------------------------------------------------------------------------
// Imza
// ---------------------------------------------------------------------------

/** base64(HMAC-SHA256(merchantKey, message)). */
export function paytrHash(merchantKey: string, message: string): string {
  return createHmac('sha256', merchantKey).update(message, 'utf8').digest('base64');
}

/** Istek token'i: `hash_str + merchant_salt`. */
export function paytrToken(c: PaytrCredentials, hashStr: string): string {
  return paytrHash(c.merchantKey, hashStr + c.merchantSalt);
}

/** Bildirim imzasi: `merchant_oid + merchant_salt + status + total_amount`. */
export function notificationHash(c: Pick<PaytrCredentials, 'merchantKey' | 'merchantSalt'>, f: { merchantOid: string; status: string; totalAmount: string }): string {
  return paytrHash(c.merchantKey, f.merchantOid + c.merchantSalt + f.status + f.totalAmount);
}

/** Sabit sureli karsilastirma (base64 imzalar; buyuk/kucuk harf duyarli). */
export function safeEqualBase64(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Tutar
// ---------------------------------------------------------------------------

/** 102550 -> "1025.50" (PayTR sepet fiyati ve iade tutari: nokta ayiricili TL). */
export function kurusToTl(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Gecersiz kurus: ${amount}`);
  return `${Math.trunc(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

/**
 * PayTR yanitindaki TL tutari -> kurus. Belgelerde hem "10.25" hem "10,8" bicimi gecer:
 * virgul varsa ondalik ayirici virguldur (nokta binlik), yoksa nokta. Ikiden fazla anlamli
 * ondalik veya cozumlenemeyen deger `undefined` (cagiran incelemeye alir; tahmin yapilmaz).
 */
export function tlToKurus(value: unknown): Kurus | undefined {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    s = value.toFixed(2);
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    return undefined;
  }
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > 2) return undefined;
  return toKurus(Number(m[1]) * 100 + Number(frac.padEnd(2, '0')));
}

/** PayTR alanlarina giden metin: satir sonlari/bosluklar tekillesir, uzunluk sinirlanir. */
export function clip(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** PayTR'nin ortak yanit zarfi. `status` disindaki alanlar servise gore degisir. */
export type PaytrEnvelope = {
  status?: 'success' | 'failed' | 'error' | string;
  reason?: string;
  err_no?: string | number;
  err_msg?: string;
  [key: string]: unknown;
};

export type PaytrClientOptions = {
  /** Varsayilan https://www.paytr.com (testlerde sahte sunucu). */
  baseUrl?: string;
  /** Lambda soguk baslangicinda degil, ilk istekte okunur (Secrets Manager). */
  credentials: () => Promise<PaytrCredentials>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PaytrClient = {
  readonly baseUrl: string;
  /** Form POST; `paytr_token` cagiran tarafindan eklenir (servise ozgu hash). */
  post<T extends PaytrEnvelope>(path: string, form: Record<string, string>): Promise<T>;
  credentials(): Promise<PaytrCredentials>;
};

export function createPaytrClient(options: PaytrClientOptions): PaytrClient {
  const baseUrl = (options.baseUrl ?? PAYTR_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function post<T extends PaytrEnvelope>(path: string, form: Record<string, string>): Promise<T> {
    if (!path.startsWith('/') || path.includes('?')) throw new Error(`Gecersiz PayTR yolu: ${path}`);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new PaymentProviderError(timeout ? 'timeout' : 'unavailable', "PayTR'ye ulasilamadi", true);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new PaymentProviderError(`http_${res.status}`, `PayTR gecici hata: HTTP ${res.status}`, true);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PaymentProviderError('invalid_response', `PayTR yaniti JSON degil (HTTP ${res.status})`, true);
    }
    if (typeof json !== 'object' || json === null) throw new PaymentProviderError('invalid_response', 'PayTR yaniti bos', true);
    if (!res.ok) throw new PaymentProviderError(`http_${res.status}`, `PayTR hatasi: HTTP ${res.status}`);
    return json as T;
  }

  return { baseUrl, credentials: options.credentials, post };
}
