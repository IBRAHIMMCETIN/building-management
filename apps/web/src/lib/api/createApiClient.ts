import type { z } from 'zod';
import { ApiError, AuthRequiredError, NetworkError, isApiErrorBody } from './errors';

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
  /**
   * false: destek modundayken bile `X-Support-Session` eklenmez (destek oturumunu yoneten
   * platform uclari; baslikla rol denetciye duser). Varsayilan true.
   */
  support?: boolean;
};

export type TokenProvider = (options: { forceRefresh?: boolean }) => Promise<string | null>;

export type ApiClientConfig = {
  /** Terraform `VITE_API_URL` (API Gateway invoke URL). Bos ise goreli istek (Vite proxy). */
  baseUrl: string;
  getToken: TokenProvider;
  /** Yenileme sonrasi da 401 alinirsa cagrilir (oturumu kapatip girise yonlendirmek icin). */
  onAuthFailure?: () => void;
  /** API `403 MFA_REQUIRED` dondu: kullanici TOTP kurulum ekranina yonlendirilmeli. */
  onMfaRequired?: () => void;
  /** Destek modunda (platform yoneticisi) eklenecek `X-Support-Session` degeri; yoksa undefined. */
  getSupportHeader?: () => string | undefined;
  fetchImpl?: typeof fetch;
};

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  function buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  async function send(path: string, options: RequestOptions<unknown>, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const support = token && options.support !== false ? config.getSupportHeader?.() : undefined;
    if (support) headers['x-support-session'] = support;

    try {
      return await doFetch(buildUrl(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new NetworkError(err);
    }
  }

  async function parse<T>(res: Response, schema?: z.ZodType<T>): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const body = isApiErrorBody(data) ? data : undefined;
      if (res.status === 403 && body?.error === 'MFA_REQUIRED') config.onMfaRequired?.();
      throw new ApiError(res.status, body);
    }
    return schema ? schema.parse(data) : (data as T);
  }

  async function request<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const useAuth = options.auth ?? true;

    let token: string | null = null;
    if (useAuth) {
      token = await config.getToken({});
      if (!token) {
        config.onAuthFailure?.();
        throw new AuthRequiredError();
      }
    }

    let res = await send(path, options, token);

    // Token sunucuda reddedildiyse (suresi dolmus, iptal edilmis, uyelik degismis) bir kez
    // yenileyip tekrar dene. Ikinci 401 kalici kabul edilir.
    if (res.status === 401 && useAuth) {
      try {
        token = await config.getToken({ forceRefresh: true });
      } catch {
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
    get: <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'POST', body }),
    put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'PUT', body }),
    patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'PATCH', body }),
    delete: <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'DELETE' }),
  };
}
