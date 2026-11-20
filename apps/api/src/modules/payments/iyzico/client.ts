/**
 * iyzico HTTP istemcisi (bagimliliksiz: Node `fetch` + `crypto`).
 *
 * Kimlik dogrulama: IYZWSv2 (docs.iyzico.com, "IYZWSv2 Authentication")
 *   encryptedData = hex(HMAC-SHA256(secretKey, randomKey + uri.path + request.body))
 *   Authorization = "IYZWSv2 " + base64("apiKey:<apiKey>&randomKey:<randomKey>&signature:<encryptedData>")
 *   x-iyzi-rnd    = randomKey
 * Govde imzalanan metnin AYNISI olarak gonderilir (tek `JSON.stringify`).
 *
 * Yanit imzasi (docs.iyzico.com, "Response Signature Validation"): alanlar ':' ile birlestirilir,
 * HMAC-SHA256(secretKey) hex; ondalik tutarlarda sondaki sifirlar atilir ("50.00" -> "50").
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Kurus, toKurus } from '../../core/types.js';
import { PaymentProviderError } from '../provider.js';

export type IyzicoCredentials = { apiKey: string; secretKey: string };

export const IYZICO_BASE_URLS = {
  sandbox: 'https://sandbox-api.iyzipay.com',
  live: 'https://api.iyzipay.com',
} as const;

// ---------------------------------------------------------------------------
// Imza
// ---------------------------------------------------------------------------

export function hmacHex(secretKey: string, message: string): string {
  return createHmac('sha256', secretKey).update(message, 'utf8').digest('hex');
}

/** IYZWSv2 Authorization basligi. `path` sorgu dizgisi icermeyen yol (ornegin /onboarding/submerchant). */
export function iyzicoAuthorization(credentials: IyzicoCredentials, randomKey: string, path: string, body: string): string {
  const encryptedData = hmacHex(credentials.secretKey, randomKey + path + body);
  const raw = `apiKey:${credentials.apiKey}&randomKey:${randomKey}&signature:${encryptedData}`;
  return `IYZWSv2 ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/** Sabit sureli karsilastirma (hex imzalar). */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), 'utf8');
  const y = Buffer.from(b.toLowerCase(), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Yanit imzasi icin ondalik bicim: "3135.00" -> "3135", "10.50" -> "10.5". */
export function signaturePrice(value: unknown): string {
  const s = typeof value === 'number' ? numberToPlain(value) : String(value ?? '');
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function responseSignature(secretKey: string, fields: readonly unknown[]): string {
  return hmacHex(secretKey, fields.map((f) => (f === undefined || f === null ? '' : String(f))).join(':'));
}

// ---------------------------------------------------------------------------
// Tutar donusumu (kurus <-> iyzico ondalik)
// ---------------------------------------------------------------------------

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new PaymentProviderError('invalid_response', `Gecersiz tutar: ${n}`);
  // Kurus hassasiyetindeki tutarlar icin toFixed(2) yeterli; ustel gosterimi onler.
  return n.toFixed(2);
}

/** 313500 -> "3135.00" */
export function kurusToPrice(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Gecersiz kurus: ${amount}`);
  const lira = Math.trunc(amount / 100);
  const kr = amount % 100;
  return `${lira}.${String(kr).padStart(2, '0')}`;
}

/** "3135.0" | 3135 | "3135.50" -> kurus. Ikiden fazla anlamli ondalik hata sayilir (kayan nokta yok). */
export function priceToKurus(value: unknown): Kurus {
  const s = typeof value === 'number' ? numberToPlain(value) : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) throw new PaymentProviderError('invalid_response', `Gecersiz tutar: ${String(value)}`);
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > 2) throw new PaymentProviderError('invalid_response', `Kurus hassasiyetini asan tutar: ${s}`);
  return toKurus(Number(m[1]) * 100 + Number(frac.padEnd(2, '0')));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** iyzico'nun ortak yanit zarfi. `status: 'failure'` is hatasidir (HTTP 200 donebilir). */
export type IyzicoEnvelope = {
  status?: 'success' | 'failure' | string;
  errorCode?: string;
  errorMessage?: string;
  conversationId?: string;
  systemTime?: number;
  [key: string]: unknown;
};

export type IyzicoClientOptions = {
  baseUrl: string;
  /** Lambda soguk baslangicinda degil, ilk istekte okunur (Secrets Manager). */
  credentials: () => Promise<IyzicoCredentials>;
  fetch?: typeof fetch;
  randomKey?: () => string;
  timeoutMs?: number;
};

export type IyzicoClient = {
  readonly baseUrl: string;
  post<T extends IyzicoEnvelope>(path: string, body: Record<string, unknown>): Promise<T>;
  credentials(): Promise<IyzicoCredentials>;
};

export function createIyzicoClient(options: IyzicoClientOptions): IyzicoClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const randomKey = options.randomKey ?? (() => `${Date.now()}${randomBytes(6).toString('hex')}`);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    baseUrl,
    credentials: options.credentials,
    async post<T extends IyzicoEnvelope>(path: string, body: Record<string, unknown>): Promise<T> {
      if (!path.startsWith('/') || path.includes('?')) throw new Error(`Gecersiz iyzico yolu: ${path}`);
      const credentials = await options.credentials();
      const payload = JSON.stringify(body);
      const rnd = randomKey();
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            authorization: iyzicoAuthorization(credentials, rnd, path, payload),
            'x-iyzi-rnd': rnd,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new PaymentProviderError(timeout ? 'timeout' : 'unavailable', 'iyzico\'ya ulasilamadi', true);
      }
      if (res.status >= 500 || res.status === 429) {
        throw new PaymentProviderError(`http_${res.status}`, `iyzico gecici hata: HTTP ${res.status}`, true);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new PaymentProviderError('invalid_response', `iyzico yaniti JSON degil (HTTP ${res.status})`, res.status >= 500);
      }
      if (typeof json !== 'object' || json === null) {
        throw new PaymentProviderError('invalid_response', 'iyzico yaniti bos');
      }
      if (!res.ok && (json as IyzicoEnvelope).status !== 'failure') {
        throw new PaymentProviderError(`http_${res.status}`, `iyzico hatasi: HTTP ${res.status}`);
      }
      return json as T;
    },
  };
}
