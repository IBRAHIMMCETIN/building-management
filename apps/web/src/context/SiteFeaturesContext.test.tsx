// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import { FEATURE_KEYS, type FeatureKey, uniformFeatures } from '@/lib/features/catalog';
import { RequireFeature } from '@/router/RequireFeature';
import { SiteFeaturesProvider, useFeature } from './SiteFeaturesContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const current = vi.fn();
vi.mock('@/lib/api/siteFeatures', () => ({
  siteFeaturesApi: {
    current: () => current(),
    siteRequests: async () => ({ items: [] }),
    requestEnable: vi.fn(),
  },
}));

const view = (features: Partial<Record<FeatureKey, boolean>>) => ({
  apartmentId: 'apt-1',
  version: 1,
  profile: 'simple',
  inherited: false,
  overrides: {},
  features: { ...uniformFeatures(false), ...features },
  catalog: FEATURE_KEYS.map((key) => ({ key, area: 'resident', label: `L ${key}`, description: 'd', defaults: { legacy: true, simple: false } })),
});

function Probe() {
  return <p data-testid="probe">{useFeature('admin.debtRestructure') ? 'acik' : 'kapali'}</p>;
}

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
  current.mockReset();
});

async function render(node: ReactNode, role = 'apartment_manager', withProvider = true) {
  const auth = { user: { sub: 'u1', role, apartmentId: 'apt-1', exp: 0 } } as unknown as AuthContextValue;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext value={auth}>{withProvider ? <SiteFeaturesProvider>{node}</SiteFeaturesProvider> : node}</AuthContext>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return host;
}

describe('SiteFeaturesProvider', () => {
  it('saglayici yoksa eski davranis: tum ozellikler acik (tekil bilesen testleri)', async () => {
    const host = await render(<Probe />, 'apartment_manager', false);
    expect(host.querySelector('[data-testid=probe]')?.textContent).toBe('acik');
    expect(current).not.toHaveBeenCalled();
  });

  it('API durumunu uygular', async () => {
    current.mockResolvedValue(view({ 'admin.debtRestructure': true }));
    const host = await render(<Probe />);
    expect(host.querySelector('[data-testid=probe]')?.textContent).toBe('acik');
  });

  it('yukleme hatasinda kapali kalir (fail closed)', async () => {
    current.mockRejectedValue(new Error('ag'));
    const host = await render(<Probe />);
    expect(host.querySelector('[data-testid=probe]')?.textContent).toBe('kapali');
  });
});

describe('RequireFeature', () => {
  const routes = (feature: FeatureKey) =>
    createMemoryRouter([{ element: <RequireFeature feature={feature} />, children: [{ path: '/x', element: <p data-testid="page">sayfa</p> }] }], {
      initialEntries: ['/x'],
    });

  it('kapali ozellikte sayfa yerine kapali gorunumu ve yoneticiye talep dugmesi', async () => {
    current.mockResolvedValue(view({}));
    const host = await render(<RouterProvider router={routes('payments.online')} />);
    expect(host.querySelector('[data-testid=page]')).toBeNull();
    expect(host.textContent).toContain('Bu özellik siteniz için kapalı');
    expect(host.textContent).toContain('Açtırmak istiyorum');
  });

  it('sakin talep dugmesi gormez; acik ozellikte sayfa acilir', async () => {
    current.mockResolvedValue(view({}));
    const off = await render(<RouterProvider router={routes('payments.online')} />, 'resident');
    expect(off.textContent).not.toContain('Açtırmak istiyorum');

    current.mockResolvedValue(view({ 'payments.online': true }));
    const on = await render(<RouterProvider router={routes('payments.online')} />, 'resident');
    expect(on.querySelector('[data-testid=page]')?.textContent).toBe('sayfa');
  });
});
