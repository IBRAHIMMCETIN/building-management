// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import type { MfaStatus } from '@/lib/api/mfa';
import { MfaSetupPage } from './MfaSetupPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  fetchMfaStatus: vi.fn(),
  beginTotpSetup: vi.fn(),
  verifyTotp: vi.fn(),
}));
vi.mock('@/lib/api/mfa', () => api);
vi.mock('qrcode', () => ({ toDataURL: vi.fn(async () => 'data:image/png;base64,QR') }));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

const status = (over: Partial<MfaStatus> = {}): MfaStatus => ({
  mode: 'enforce',
  graceDays: 7,
  roleRequiresMfa: true,
  enabled: false,
  status: 'required',
  ...over,
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function render(auth: Partial<AuthContextValue>) {
  const value = {
    user: { sub: 'u1', role: 'apartment_manager', apartmentId: 'apt-1', exp: 0 },
    mfaSetupRequired: true,
    refreshSession: vi.fn(async () => ({ claims: { sub: 'u1', role: 'apartment_manager', exp: 0 } })),
    signOut: vi.fn(async () => {}),
    ...auth,
  } as unknown as AuthContextValue;
  const router = createMemoryRouter(
    [
      { path: '/mfa-setup', element: <MfaSetupPage /> },
      { path: '*', element: <Where /> },
    ],
    { initialEntries: [{ pathname: '/mfa-setup', state: { from: '/admin/finance' } }] },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext value={value}>
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await flush();
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
  return { host, value, button, unmount: () => act(async () => root.unmount()) };
}

async function typeCode(host: HTMLElement, code: string) {
  const input = host.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, code);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    (host.querySelector('form') as HTMLFormElement).requestSubmit();
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('MfaSetupPage', () => {
  it('zorunlu kurulum: QR + anahtar gosterilir, kod dogrulaninca token yenilenir ve geldigi sayfaya doner', async () => {
    api.fetchMfaStatus.mockResolvedValue(status());
    api.beginTotpSetup.mockResolvedValue({
      secretCode: 'JBSWY3DPEHPK3PXPJBSWY3DP',
      otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXPJBSWY3DP',
      issuer: 'YÖNESİST',
      account: 'mgr@ornek.com',
    });
    api.verifyTotp.mockResolvedValue({ enabled: true });
    const view = await render({});

    expect(view.host.textContent).toContain('zorunludur');
    expect(view.button('Daha sonra')).toBeUndefined();
    await act(async () => view.button('Kurulumu başlat')!.click());
    await flush();

    expect(view.host.querySelector('[data-testid="mfa-secret"]')?.textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP');
    expect(view.host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QR');
    expect(view.host.textContent).toContain('mgr@ornek.com');

    await typeCode(view.host, '123456');
    expect(api.verifyTotp).toHaveBeenCalledWith({ code: '123456' });
    expect(view.value.refreshSession).toHaveBeenCalledOnce();
    expect(view.host.querySelector('[data-testid="where"]')?.textContent).toBe('/admin/finance');
    await view.unmount();
  });

  it('hatali kod mesaji gosterilir, oturum yenilenmez', async () => {
    api.fetchMfaStatus.mockResolvedValue(status());
    api.beginTotpSetup.mockResolvedValue({ secretCode: 'A'.repeat(32), otpauthUri: 'otpauth://totp/x', issuer: 'Y', account: 'a' });
    const { ApiError } = await import('@/lib/api/errors');
    api.verifyTotp.mockRejectedValue(new ApiError(400, { error: 'invalid_code', message: 'Doğrulama kodu hatalı.' }));
    const view = await render({});
    await act(async () => view.button('Kurulumu başlat')!.click());
    await flush();
    await typeCode(view.host, '000000');
    expect(view.host.textContent).toContain('Doğrulama kodu hatalı.');
    expect(view.value.refreshSession).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('gecis donemi: kalan sure ve "Daha sonra" secenegi', async () => {
    api.fetchMfaStatus.mockResolvedValue(status({ mode: 'warn', status: 'grace', graceUntil: '2099-01-01T00:00:00.000Z' }));
    const view = await render({ mfaSetupRequired: false });
    expect(view.host.textContent).toContain('zorunlu hale geliyor');
    await act(async () => view.button('Daha sonra')!.click());
    expect(view.host.querySelector('[data-testid="where"]')?.textContent).toBe('/admin/finance');
    await view.unmount();
  });

  it('zaten etkinse kurulum yerine devam secenegi', async () => {
    api.fetchMfaStatus.mockResolvedValue(status({ enabled: true, status: 'enabled' }));
    const view = await render({ mfaSetupRequired: false });
    expect(view.host.textContent).toContain('etkin');
    expect(view.button('Kurulumu başlat')).toBeUndefined();
    await view.unmount();
  });
});
