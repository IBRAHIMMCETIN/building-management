// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, use } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sm = vi.hoisted(() => {
  const state = { status: 'ready' as const, session: { claims: { sub: 'u1', role: 'management_company', apartmentId: 'apt-1', exp: 0 } } };
  return { state, setActiveContext: vi.fn(), subscribe: () => () => {}, getState: () => state };
});
vi.mock('@/lib/auth/sessionManager', () => ({ sessionManager: sm }));
vi.mock('@/lib/auth', () => ({ authAdapter: {} }));

const { AuthContext, AuthProvider, clearForContextSwitch } = await import('./AuthContext');

function seed(client: QueryClient) {
  client.setQueryData(['finance', 'summary', 'apt-1'], { cash: 1 });
  client.setQueryData(['me', 'contexts', 'u1'], { contexts: [] });
  client.setQueryData(['portfolio', 'u1'], { pages: [] });
  client.setQueryData(['portfolio', 'someone-else'], { pages: [] });
}
const keys = (client: QueryClient) => client.getQueryCache().getAll().map((q) => JSON.stringify(q.queryKey)).sort();

async function render(client: QueryClient) {
  let value: Parameters<typeof AuthContext.Provider>[0]['value'] = null;
  function Capture() {
    value = use(AuthContext);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Capture />
        </AuthProvider>
      </QueryClientProvider>,
    );
  });
  return { value: () => value as NonNullable<typeof value>, unmount: () => act(async () => root.unmount()) };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('baglam degisiminde onbellek', () => {
  it('apartman verisi ve bekleyen mutasyonlar silinir; ayni kullanicinin portfoyu kalir', () => {
    const client = new QueryClient();
    seed(client);
    client.getMutationCache().build(client, { mutationFn: async () => 1 });
    clearForContextSwitch(client, 'u1');
    expect(keys(client)).toEqual(['["portfolio","u1"]']);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    seed(client);
    clearForContextSwitch(client, undefined);
    expect(keys(client)).toEqual([]);
  });

  it('basarisiz secimde de onceki apartmanin onbellegi temizlenir (hata yine firlatilir)', async () => {
    const client = new QueryClient();
    sm.setActiveContext.mockRejectedValueOnce(new Error('Seçilen apartman/rol doğrulanamadı.'));
    const view = await render(client);
    // Destek modu kapaliyken saglayici acilista apartman verisini zaten temizler; once ac, sonra doldur.
    seed(client);
    await expect(view.value().setActiveContext({ apartmentId: 'apt-2', role: 'observer' })).rejects.toThrow(/doğrulanamadı/);
    expect(keys(client)).toEqual(['["portfolio","u1"]']);

    seed(client);
    sm.setActiveContext.mockResolvedValueOnce({ claims: { sub: 'u1', role: 'observer', apartmentId: 'apt-2', exp: 0 } });
    await expect(view.value().setActiveContext({ apartmentId: 'apt-2', role: 'observer' })).resolves.toMatchObject({ claims: { apartmentId: 'apt-2' } });
    expect(keys(client)).toEqual(['["portfolio","u1"]']);
    await view.unmount();
  });
});
