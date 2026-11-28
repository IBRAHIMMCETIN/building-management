import { ApiError, AuthRequiredError, NetworkError, isApiErrorBody } from '@bm/shared/api/errors';
import type { z } from 'zod';
import { isAuthRejection, isNetworkFailure } from '../auth/errors';
import { OfflineError } from './offline';

/*
 * Web istemcisinin (apps/web/src/lib/api/createApiClient.ts) React Native kopyasi; ayni hata
 * modeli ve davranis (bearer token, 401'de bir kez yenileyip tekrar deneme, zod dogrulamasi).
 * Mekanik tasinamadi: RN'de global `DOMException` olmayabilir (iptal hatasi adla taninir) ve
 * RN'in `URLSearchParams`'i eksiktir (`set` yok; sorgu elle kurulur). JSON olmayan hata govdesi
 * (ornek: ag gecidi HTML 502) varsayilan Turkce mesaja duser. Destek modu basligi mobilde yoktur.
 */

type QueryValue = string | number | boolean | null | undefined;

export type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON olarak gonderilir. */
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** false: Authorization basligi eklenmez (ornek: /api/health). Varsayilan true. */
  auth?: boolean;
  /** Verilirse yanit zod ile dogrulanir; sozlesme kaymasi erken yakalanir. */
  schema?: z.ZodType<T>;
};

export type TokenProvider = (options: { forceRefresh?: boolean }) => Promise<string | null>;

export type ApiClientConfig = {
  /** API Gateway adresi (EXPO_PUBLIC_API_URL). */
  baseUrl: string;
  getToken: TokenProvider;
  /** Yenileme sonrasi da 401 alinirsa cagrilir (oturumu kapatip girise yonlendirmek icin). */
  onAuthFailure?: () => void;
  fetchImpl?: typeof fetch;
  /** false donerse yazan istekler gonderilmez (`OfflineError`); okumalar React Query'de bekler. */
  isOnline?: () => boolean;
};

export type ApiClient = ReturnType<typeof createApiClient>;

const isAbortError = (err: unknown) => typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  function buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.length ? `${url}?${parts.join('&')}` : url;
  }

  async function send(path: string, options: RequestOptions<unknown>, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      return await doFetch(buildUrl(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new NetworkError(err);
    }
  }

  async function parse<T>(res: Response, schema?: z.ZodType<T>): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      let body = isApiErrorBody(data) ? data : undefined;
      // Deneme siniri: `Retry-After` basligi (sn) govdede yoksa eklenir (kapi dogrulama / plaka, cihaz kaydi).
      const retryAfter = res.status === 429 ? Number(res.headers?.get?.('retry-after')) : NaN;
      if (Number.isFinite(retryAfter) && retryAfter > 0 && body?.retryAfterSeconds === undefined) {
        body = { ...body, error: body?.error ?? 'rate_limited', retryAfterSeconds: retryAfter };
      }
      throw new ApiError(res.status, body);
    }
    return schema ? schema.parse(data) : (data as T);
  }

  async function request<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const useAuth = options.auth ?? true;
    // Cevrimdisi: degisiklik gonderilmez, acik mesajla hemen doner (yarida kalan / sessizce bekleyen islem yok).
    if ((options.method ?? 'GET') !== 'GET' && config.isOnline && !config.isOnline()) throw new OfflineError();

    let token: string | null = null;
    if (useAuth) {
      token = await config.getToken({});
      if (!token) {
        config.onAuthFailure?.();
        throw new AuthRequiredError();
      }
    }

    let res = await send(path, options, token);

    // Token sunucuda reddedildiyse bir kez yenileyip tekrar dene. Ikinci 401 kalici kabul edilir.
    if (res.status === 401 && useAuth) {
      try {
        token = await config.getToken({ forceRefresh: true });
      } catch (err) {
        // Yenileme reddedildiyse oturum duser; ag kesintisi / gecici hatada oturum korunur, istek hata verir.
        if (!isAuthRejection(err)) throw isNetworkFailure(err) && !(err instanceof NetworkError) ? new NetworkError(err) : err;
        token = null;
      }
      if (!token) {
        config.onAuthFailure?.();
        throw new AuthRequiredError();
      }
      res = await send(path, options, token);
      if (res.status === 401) config.onAuthFailure?.();
    }

    return parse(res, options.schema);
  }

  return {
    request,
    get: <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>) => request<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'POST', body }),
    put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'PUT', body }),
    patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'PATCH', body }),
    delete: <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>) => request<T>(path, { ...options, method: 'DELETE' }),
  };
}
