import { ApiError, AuthRequiredError, NetworkError, errorMessage } from '@bm/shared/api/errors';
import { toAuthFlowError } from '@bm/shared/auth/errors';
import { z } from 'zod';
import { createApiClient } from './createApiClient';
import { shouldRetry } from './queryClient';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body?: unknown; raw?: string } | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('beklenmeyen istek');
    if (next instanceof Error) throw next;
    const text = next.raw ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const header = (call: Call | undefined, name: string) => (call?.init.headers as Record<string, string> | undefined)?.[name];

describe('createApiClient (web istemcisiyle ayni hata modeli)', () => {
  it('bearer token, sorgu parametreleri ve zod dogrulamasi', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 'tok', fetchImpl: impl });
    const res = await api.get('/api/portal/my-summary', { query: { unitId: 'u 1', empty: undefined }, schema: z.object({ ok: z.boolean() }) });
    expect(res).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://api.test/api/portal/my-summary?unitId=u%201');
    expect(header(calls[0], 'authorization')).toBe('Bearer tok');
  });

  it('API hata govdesindeki Turkce mesaj ve kod korunur', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { error: 'unit_selection_required', message: 'Daire seçin', units: [{ unitId: 'u1', label: 'Daire 1' }] } }]);
    const api = createApiClient({ baseUrl: '', getToken: async () => 'tok', fetchImpl: impl });
    const err = await api.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'unit_selection_required', message: 'Daire seçin' });
  });

  it('govdesiz / JSON olmayan hata varsayilan Turkce mesaja duser', async () => {
    const { impl } = fakeFetch([
      { status: 502, raw: '<html>Bad gateway</html>' },
      { status: 404 },
      { status: 429 },
      { status: 403 },
    ]);
    const api = createApiClient({ baseUrl: '', getToken: async () => 'tok', fetchImpl: impl });
    expect(errorMessage(await api.get('/a').catch((e: unknown) => e))).toBe('Sunucuda beklenmeyen bir hata oluştu.');
    expect(errorMessage(await api.get('/b').catch((e: unknown) => e))).toBe('Kayıt bulunamadı.');
    expect(errorMessage(await api.get('/c').catch((e: unknown) => e))).toBe('Çok fazla istek gönderildi, biraz sonra tekrar deneyin.');
    expect(errorMessage(await api.get('/d').catch((e: unknown) => e))).toBe('Bu işlem için yetkiniz yok.');
  });

  it('ag hatasi NetworkError; iptal hatasi oldugu gibi gecer', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { impl } = fakeFetch([new TypeError('Network request failed'), abort]);
    const api = createApiClient({ baseUrl: '', getToken: async () => 'tok', fetchImpl: impl });
    const err = await api.get('/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(errorMessage(err)).toBe('Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.');
    expect(await api.get('/b').catch((e: unknown) => e)).toBe(abort);
  });

  it('401: token bir kez yenilenip tekrar denenir', async () => {
    const { impl, calls } = fakeFetch([{ status: 401 }, { status: 200, body: { a: 1 } }]);
    const getToken = jest.fn(async ({ forceRefresh }: { forceRefresh?: boolean }) => (forceRefresh ? 'yeni' : 'eski'));
    const api = createApiClient({ baseUrl: '', getToken, fetchImpl: impl });
    expect(await api.get('/a')).toEqual({ a: 1 });
    expect(header(calls[1], 'authorization')).toBe('Bearer yeni');
  });

  it('ikinci 401 ve oturumsuz istek: oturum dusurulur', async () => {
    const onAuthFailure = jest.fn();
    const { impl } = fakeFetch([{ status: 401 }, { status: 401 }]);
    const api = createApiClient({ baseUrl: '', getToken: async () => 'tok', fetchImpl: impl, onAuthFailure });
    await expect(api.get('/a')).rejects.toBeInstanceOf(ApiError);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);

    const none = createApiClient({ baseUrl: '', getToken: async () => null, fetchImpl: impl, onAuthFailure });
    const err = await none.get('/b').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(errorMessage(err)).toBe('Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.');
  });

  it('PUT govdesi JSON olarak gider (yalnizca degisen alan)', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { email: { enabled: true, finance: false } } }]);
    const api = createApiClient({ baseUrl: '', getToken: async () => 'tok', fetchImpl: impl });
    await api.put('/api/me/notification-preferences', { email: { finance: false } });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.init.body).toBe('{"email":{"finance":false}}');
    expect(header(calls[0], 'content-type')).toBe('application/json');
  });
});

describe('hata mesajlari ve tekrar deneme', () => {
  it('Cognito hata adlari Turkce mesaja cevrilir', () => {
    expect(errorMessage(toAuthFlowError(Object.assign(new Error('x'), { name: 'NotAuthorizedException' })))).toBe('E-posta veya şifre hatalı.');
    expect(errorMessage(toAuthFlowError(Object.assign(new Error('Invalid session for the user'), { name: 'NotAuthorizedException' })))).toBe(
      'Giriş oturumu zaman aşımına uğradı. Lütfen baştan giriş yapın.',
    );
    expect(errorMessage(new Error('ham ayrinti'))).toBe('Beklenmeyen bir hata oluştu.');
  });

  it("4xx ve oturum hatalari tekrar denenmez, 5xx / ag 2 kez", () => {
    expect(shouldRetry(0, new ApiError(400))).toBe(false);
    expect(shouldRetry(0, new AuthRequiredError())).toBe(false);
    expect(shouldRetry(0, new ApiError(503))).toBe(true);
    expect(shouldRetry(2, new NetworkError(null))).toBe(false);
  });
});
