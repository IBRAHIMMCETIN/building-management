import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Expo push servisi istemcisi (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 *   POST https://exp.host/--/api/v2/push/send         en fazla 100 mesaj -> ayni sirada "ticket"lar
 *   POST https://exp.host/--/api/v2/push/getReceipts  en fazla 1000 ticket kimligi -> makbuzlar
 *
 * `accessToken` (Expo "Enhanced Security for Push Notifications") verilirse `Authorization: Bearer`
 * basligi eklenir; verilmezse istek basliksiz gider (Expo projesinde zorunlu degilse calisir). Lambda'da
 * anahtar Secrets Manager'dan okunur (`secretsManagerAccessToken`, 5 dk bellekte); deger girilmemisse
 * anahtarsiz gonderilir.
 *
 * Hata siniflari:
 *  - `TransientPushError`: ag / zaman asimi, 429, 5xx ve beklenmeyen yanit. Cagiran FIRLATIR -> SQS
 *    yeniden dener.
 *  - `PermanentPushError`: diger 4xx (istek kalici olarak gecersiz) ve 401/403 (`auth`: erisim anahtari /
 *    yapilandirma): tekrar denemek duzeltmez; cagiran loglar + metrik (alarm), olayi DLQ'ya dusurmez.
 *  - `MixedProjectsError` (`PUSH_TOO_MANY_EXPERIENCE_IDS`): istekte birden fazla Expo projesinin token'i
 *    var; `groups` proje -> token listesi (Expo hata ayrintisi). Cagiran parcayi projelere boler.
 */

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
export const EXPO_SEND_BATCH = 100;
export const EXPO_RECEIPTS_BATCH = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  /** Yalnizca iOS (site adi). */
  subtitle?: string;
  data: Record<string, string>;
  sound: 'default';
  /** Android bildirim kanali. */
  channelId: string;
  priority: 'default' | 'high';
  /** Saniye: suresi gecen bildirim teslim edilmez. */
  ttl?: number;
};

export type ExpoError = { status: 'error'; message?: string; details?: { error?: string } };
export type ExpoTicket = { status: 'ok'; id: string } | ExpoError;
export type ExpoReceipt = { status: 'ok' } | ExpoError;

export class TransientPushError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientPushError';
  }
}

export class PermanentPushError extends Error {
  readonly code: string;
  /** 401/403: erisim anahtari / yapilandirma hatasi (alarm). */
  readonly auth: boolean;
  constructor(code: string, message: string, options: { auth?: boolean } = {}) {
    super(message);
    this.name = 'PermanentPushError';
    this.code = code;
    this.auth = options.auth ?? false;
  }
}

/** Istekte farkli Expo projelerinin token'lari: `groups` proje kimligi -> token'lar. */
export class MixedProjectsError extends PermanentPushError {
  readonly groups: Record<string, string[]>;
  constructor(groups: Record<string, string[]>) {
    super('PUSH_TOO_MANY_EXPERIENCE_IDS', `Expo istegi birden fazla projenin token'ini iceriyor (${Object.keys(groups).length} proje)`);
    this.name = 'MixedProjectsError';
    this.groups = groups;
  }
}

/** `PUSH_TOO_MANY_EXPERIENCE_IDS` ayrintisi: `{ "<proje>": ["ExponentPushToken[...]", ...] }`. */
function projectGroups(details: unknown): Record<string, string[]> | undefined {
  if (!isObject(details)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [project, tokens] of Object.entries(details)) {
    if (Array.isArray(tokens)) out[project] = tokens.filter((t): t is string => typeof t === 'string');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type ExpoClient = {
  send(messages: ExpoMessage[]): Promise<ExpoTicket[]>;
  getReceipts(ids: string[]): Promise<Record<string, ExpoReceipt>>;
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export type ExpoClientOptions = {
  /** Sabit anahtar veya her istekte cagrilan okuyucu (bos / undefined: basliksiz). */
  accessToken?: string | (() => Promise<string | undefined>);
  fetch?: FetchLike;
  timeoutMs?: number;
  sendUrl?: string;
  receiptsUrl?: string;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ticket / makbuz: yalnizca bilinen alanlar (beklenmeyen bicimde hata sayilir). */
function toResult(v: unknown): ExpoTicket | ExpoReceipt {
  if (isObject(v) && v.status === 'ok') return typeof v.id === 'string' ? { status: 'ok', id: v.id } : { status: 'ok' };
  const details = isObject(v) && isObject(v.details) && typeof v.details.error === 'string' ? { error: v.details.error } : undefined;
  return { status: 'error', ...(isObject(v) && typeof v.message === 'string' ? { message: v.message.slice(0, 300) } : {}), ...(details ? { details } : {}) };
}

export function createExpoClient(options: ExpoClientOptions = {}): ExpoClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'gzip, deflate', 'content-type': 'application/json' };
  const fixed = options.accessToken;
  const tokenOf = typeof fixed === 'function' ? fixed : async () => fixed;

  async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
    let token: string | undefined;
    try {
      token = await tokenOf();
    } catch (err) {
      throw new TransientPushError('Expo erisim anahtari okunamadi', { cause: err });
    }
    const headers = { ...base, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new TransientPushError(`Expo istegi basarisiz: ${err instanceof Error ? err.name : 'unknown'}`, { cause: err });
    }
    const json = await res.json().catch(() => undefined);
    if (res.status === 429 || res.status >= 500) throw new TransientPushError(`Expo gecici hata: HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new PermanentPushError(`HTTP_${res.status}`, `Expo yetkilendirme hatasi: HTTP ${res.status} (Expo erisim anahtari)`, { auth: true });
    }
    if (res.status >= 400) {
      const first = isObject(json) && Array.isArray(json.errors) && isObject(json.errors[0]) ? json.errors[0] : undefined;
      const code = typeof first?.code === 'string' ? first.code : `HTTP_${res.status}`;
      if (code === 'PUSH_TOO_MANY_EXPERIENCE_IDS') {
        const groups = projectGroups(first?.details);
        if (groups) throw new MixedProjectsError(groups);
      }
      throw new PermanentPushError(code, `Expo istegi reddetti: ${code}`);
    }
    if (!isObject(json)) throw new TransientPushError('Expo yaniti JSON degil');
    return json;
  }

  return {
    async send(messages) {
      if (messages.length === 0) return [];
      if (messages.length > EXPO_SEND_BATCH) throw new Error(`Expo istegi en fazla ${EXPO_SEND_BATCH} mesaj alir`);
      const json = await post(options.sendUrl ?? EXPO_SEND_URL, messages);
      const data = json.data;
      if (!Array.isArray(data) || data.length !== messages.length) throw new TransientPushError('Expo yaniti mesaj sayisiyla uyusmuyor');
      return data.map((t) => {
        const r = toResult(t);
        // Kimliksiz "ok" ticket: makbuzu sorgulanamaz ama gonderim basarili.
        return r.status === 'ok' ? { status: 'ok' as const, id: 'id' in r ? r.id : '' } : r;
      });
    },
    async getReceipts(ids) {
      if (ids.length === 0) return {};
      if (ids.length > EXPO_RECEIPTS_BATCH) throw new Error(`Expo makbuz istegi en fazla ${EXPO_RECEIPTS_BATCH} kimlik alir`);
      const json = await post(options.receiptsUrl ?? EXPO_RECEIPTS_URL, { ids });
      const data = json.data;
      if (!isObject(data)) throw new TransientPushError('Expo makbuz yaniti beklenmeyen bicimde');
      const out: Record<string, ExpoReceipt> = {};
      for (const [id, v] of Object.entries(data)) {
        const r = toResult(v);
        out[id] = r.status === 'ok' ? { status: 'ok' } : r;
      }
      return out;
    },
  };
}

export const ACCESS_TOKEN_CACHE_MS = 5 * 60_000;

/**
 * Secrets Manager'daki Expo erisim anahtari: duz metin veya `{ "accessToken": "..." }`. Deger hic
 * girilmemisse (`ResourceNotFoundException`) anahtarsiz gonderilir. 5 dk bellekte; es zamanli tek okuma.
 * Diger okuma hatalari firlatilir (istemci gecici hata sayar).
 */
export function secretsManagerAccessToken(
  secretArn: string,
  options: { client?: Pick<SecretsManagerClient, 'send'>; now?: () => number } = {},
): () => Promise<string | undefined> {
  const client = options.client ?? new SecretsManagerClient({});
  const now = options.now ?? Date.now;
  let cached: { value: string | undefined; at: number } | undefined;
  let inflight: Promise<string | undefined> | undefined;

  async function load(): Promise<string | undefined> {
    try {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      const raw = out.SecretString?.trim();
      if (!raw) return undefined;
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw) as { accessToken?: unknown };
        return typeof parsed.accessToken === 'string' && parsed.accessToken.trim() ? parsed.accessToken.trim() : undefined;
      }
      return raw;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  return async () => {
    if (cached && now() - cached.at < ACCESS_TOKEN_CACHE_MS) return cached.value;
    inflight ??= load().finally(() => {
      inflight = undefined;
    });
    const value = await inflight;
    cached = { value, at: now() };
    return value;
  };
}
