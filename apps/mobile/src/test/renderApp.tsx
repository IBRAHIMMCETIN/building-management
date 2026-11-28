import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { AppEnv } from '@/config/env';
import { AuthProvider } from '@/context/AuthProvider';
import { PortalUnitProvider } from '@/context/PortalUnitProvider';
import { createMockAuthAdapter } from '@/lib/auth/mockAdapter';
import type { KeyValueStorage } from '@/lib/storage/types';
import { createServices } from '@/services';
import { ServicesProvider } from '@/services';

/*
 * Ekran testleri icin uygulama iskeleti: mock kimlik (gercek senaryolar), sahte API (fetch),
 * React Query, oturum ve daire baglami. Ag / Cognito'ya gidilmez.
 */

export const TEST_ENV: AppEnv = {
  apiUrl: 'https://api.test',
  authMode: 'mock',
  apiMode: 'live',
  tokenUse: 'id',
  cognito: { region: 'eu-north-1', userPoolId: 'test-pool', clientId: 'test-client' },
  webUrl: 'https://web.test',
};

export function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    setItem: async (k, v) => void data.set(k, v),
    getItem: async (k) => data.get(k) ?? null,
    removeItem: async (k) => void data.delete(k),
    clear: async () => data.clear(),
  };
}

type Handler = unknown | ((req: { url: string; query: Record<string, string>; body: unknown }) => { status: number; body?: unknown } | unknown);
export type Routes = Record<string, Handler>;
export type ApiCall = { method: string; path: string; query: Record<string, string>; body: unknown };

/** `{ status: <sayi>, body }`: hata / ozel durum yaniti (govdedeki `status: 'overdue'` gibi metinlerle karismaz). */
const isResponse = (v: unknown): v is { status: number; body?: unknown } =>
  !!v && typeof v === 'object' && typeof (v as { status?: unknown }).status === 'number' && Object.keys(v).every((k) => k === 'status' || k === 'body');

/** `fetch` yerine: "GET /api/portal/my-summary" -> govde (200), { status, body } veya bunlari donduren fonksiyon. */
export function mockApi(routes: Routes) {
  const calls: ApiCall[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const [base = '', qs = ''] = input.replace('https://api.test', '').split('?');
    const query = Object.fromEntries(qs.split('&').filter(Boolean).map((p) => p.split('=').map(decodeURIComponent) as [string, string]));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: base, query, body });
    const handler = routes[`${method} ${base}`];
    let status = 200;
    let payload: unknown;
    if (handler === undefined) {
      status = 404;
      payload = { error: 'not_found', message: 'Kayıt bulunamadı.' };
    } else {
      // Fonksiyon Promise dondurebilir (yaniti test bekletir: "yukleniyor" durumlari).
      const out = await (typeof handler === 'function' ? handler({ url: input, query, body }) : handler);
      if (isResponse(out)) {
        status = out.status;
        payload = out.body;
      } else {
        payload = out;
      }
    }
    const text = payload === undefined ? '' : JSON.stringify(payload);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

type Options = { email?: string | null; routes?: Routes; env?: Partial<AppEnv>; withUnit?: boolean };

export async function renderApp(ui: ReactElement, { email = 'resident@dev.local', routes = {}, env = {}, withUnit = true }: Options = {}) {
  const api = mockApi(routes);
  const services = createServices({ ...TEST_ENV, ...env }, { adapter: createMockAuthAdapter({ storage: memoryStorage(), delayMs: 0 }), fetchImpl: api.fetchImpl });
  await services.session.ready;
  if (email) await services.session.signIn({ email, password: 'Mock123456' });
  // Ekran sorgulari kendi tekrar kuralini verir (5xx 2 kez); testte beklemesiz tekrarlanir.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const tree = withUnit ? <PortalUnitProvider>{ui}</PortalUnitProvider> : ui;
  const utils = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <ServicesProvider services={services}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{tree}</AuthProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </SafeAreaProvider>,
  );
  return { ...utils, services, queryClient, calls: api.calls };
}
