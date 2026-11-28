/**
 * Expo push servisi istemcisi (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 *   POST https://exp.host/--/api/v2/push/send         en fazla 100 mesaj -> ayni sirada "ticket"lar
 *   POST https://exp.host/--/api/v2/push/getReceipts  en fazla 1000 ticket kimligi -> makbuzlar
 *
 * `accessToken` (Expo "Enhanced Security for Push Notifications") verilirse `Authorization: Bearer`
 * basligi eklenir; verilmezse istek basliksiz gider (Expo projesinde zorunlu degilse calisir).
 *
 * Hata siniflari:
 *  - `TransientPushError`: ag / zaman asimi, 429, 5xx, 401/403 (erisim anahtari / yapilandirma) ve
 *    beklenmeyen yanit. Cagiran FIRLATIR -> SQS yeniden dener (yapilandirma hatasi sonunda DLQ + alarm).
 *  - `PermanentPushError`: diger 4xx (istek kalici olarak gecersiz): tekrar denemek duzeltmez.
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
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentPushError';
    this.code = code;
  }
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
  accessToken?: string;
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
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
    ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
  };

  async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new TransientPushError(`Expo istegi basarisiz: ${err instanceof Error ? err.name : 'unknown'}`, { cause: err });
    }
    const json = await res.json().catch(() => undefined);
    if (res.status === 429 || res.status >= 500) throw new TransientPushError(`Expo gecici hata: HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new TransientPushError(`Expo yetkilendirme hatasi: HTTP ${res.status} (EXPO_ACCESS_TOKEN)`);
    if (res.status >= 400) {
      const first = isObject(json) && Array.isArray(json.errors) && isObject(json.errors[0]) ? json.errors[0] : undefined;
      const code = typeof first?.code === 'string' ? first.code : `HTTP_${res.status}`;
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
