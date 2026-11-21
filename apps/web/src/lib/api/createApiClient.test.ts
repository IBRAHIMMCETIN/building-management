import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './createApiClient';
import { ApiError, AuthRequiredError, NetworkError } from './errors';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function setup(responses: Response[], tokens: Array<string | null> = ['id-1', 'id-2']) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  const getToken = vi.fn(async ({ forceRefresh }: { forceRefresh?: boolean }) =>
    forceRefresh ? (tokens[1] ?? null) : (tokens[0] ?? null),
  );
  const onAuthFailure = vi.fn();
  const client = createApiClient({ baseUrl: 'https://api.example.com', getToken, onAuthFailure, fetchImpl });
  const headerOf = (call: number) => new Headers(fetchImpl.mock.calls[call]?.[1]?.headers).get('authorization');
  return { client, fetchImpl, getToken, onAuthFailure, headerOf };
}

describe('createApiClient', () => {
  it('saglayicidan gelen ID token\'i Bearer olarak ekler', async () => {
    const { client, fetchImpl, headerOf } = setup([json(200, { ok: true })]);
    await expect(client.get('/api/sites')).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/sites');
    expect(headerOf(0)).toBe('Bearer id-1');
  });

  it('auth:false iken Authorization eklemez ve token istemez', async () => {
    const { client, getToken, headerOf } = setup([json(200, {})]);
    await client.get('/api/health', { auth: false });
    expect(getToken).not.toHaveBeenCalled();
    expect(headerOf(0)).toBeNull();
  });

  it('401 sonrasi bir kez yenileyip yeni token ile tekrar dener', async () => {
    const { client, getToken, headerOf, onAuthFailure } = setup([json(401, { error: 'unauthorized' }), json(200, [1])]);
    await expect(client.get('/api/finance/dues')).resolves.toEqual([1]);
    expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(headerOf(1)).toBe('Bearer id-2');
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('yenileme sonrasi yine 401 ise oturumu dusurur', async () => {
    const { client, onAuthFailure, fetchImpl } = setup([json(401), json(401, { error: 'unauthorized' })]);
    await expect(client.get('/api/sites')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it('oturum yoksa istek atmadan AuthRequiredError firlatir', async () => {
    const { client, fetchImpl, onAuthFailure } = setup([], [null, null]);
    await expect(client.get('/api/sites')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it('API hata govdesini ApiError\'a cevirir (403 tekrar denenmez)', async () => {
    const { client, fetchImpl } = setup([json(403, { error: 'forbidden', message: 'Bu islem icin yetkiniz yok' })]);
    const err = await client.post('/api/finance/dues', { amount: 150050 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'Bu islem icin yetkiniz yok' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('govdeyi JSON gonderir, query parametrelerini ekler (bos degerleri atlar)', async () => {
    const { client, fetchImpl } = setup([json(204)]);
    await expect(client.post('/api/x', { a: 1 }, { query: { year: 2026, month: undefined } })).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.com/api/x?year=2026');
    expect(init?.body).toBe('{"a":1}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('ag hatasini NetworkError olarak sarar', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ baseUrl: '', getToken: async () => 't', fetchImpl });
    await expect(client.get('/api/sites')).rejects.toBeInstanceOf(NetworkError);
  });

  it('403 MFA_REQUIRED kurulum geri cagirimini tetikler; diger 403 tetiklemez', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(403, { error: 'MFA_REQUIRED', message: 'TOTP zorunlu' }))
      .mockResolvedValueOnce(json(403, { error: 'forbidden' }));
    const onMfaRequired = vi.fn();
    const client = createApiClient({ baseUrl: '', getToken: async () => 't', fetchImpl, onMfaRequired });
    const err = await client.get('/api/finance/summary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isMfaRequired).toBe(true);
    expect(onMfaRequired).toHaveBeenCalledOnce();
    await expect(client.get('/api/sites')).rejects.toMatchObject({ code: 'forbidden', isMfaRequired: false });
    expect(onMfaRequired).toHaveBeenCalledOnce();
  });
});
