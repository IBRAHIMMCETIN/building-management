// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MfaUser } from '@/lib/api/mfa';
import { MfaResetDialog } from './MfaResetDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchMfaUser: vi.fn(), findMfaUser: vi.fn(), resetUserMfa: vi.fn() }));
vi.mock('@/lib/api/mfa', () => api);
vi.mock('@/lib/api/support', () => ({ supportApi: {} }));
vi.mock('@/lib/api/audit', () => ({ auditApi: {} }));

// happy-dom <dialog> showModal destegi sinirli: acik nitelik yeterli.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const flush = () => act(async () => new Promise((r) => setTimeout(r, 10)));
const user = (over: Partial<MfaUser> = {}): MfaUser => ({ userId: 'r-1', email: 'r@o.com', mfaEnabled: true, accountEnabled: true, status: 'CONFIRMED', canReset: true, ...over });

async function render(props: { initial?: MfaUser }) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MfaResetDialog userId="r-1" displayName="Rıza Sakin" initial={props.initial} onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  await flush();
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
  return { host, onClose, button, unmount: () => act(async () => root.unmount()) };
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('MfaResetDialog', () => {
  it('durum okunur; gerekce 10 karakterden kisaysa gonderilemez; sifirlama gerekceyle cagrilir', async () => {
    api.fetchMfaUser.mockResolvedValue(user());
    api.resetUserMfa.mockResolvedValue({ userId: 'r-1', reset: true, signedOut: true });
    const view = await render({});
    expect(api.fetchMfaUser).toHaveBeenCalledWith('r-1', expect.anything());
    expect(view.host.textContent).toContain('2FA etkin');

    const submit = view.button('Sıfırla ve oturumları kapat')!;
    await type(view.host.querySelector('textarea')!, 'kısa');
    expect(submit.disabled).toBe(true);
    await type(view.host.querySelector('textarea')!, 'Telefon kayboldu, talep #42');
    expect(submit.disabled).toBe(false);
    await act(async () => (view.host.querySelector('form') as HTMLFormElement).requestSubmit());
    await flush();
    expect(api.resetUserMfa).toHaveBeenCalledWith('r-1', 'Telefon kayboldu, talep #42');
    expect(view.host.textContent).toContain('tüm oturumları kapatıldı');
    await view.unmount();
  });

  it('sifirlanamayan kullanicida neden gosterilir, form yok', async () => {
    const view = await render({ initial: user({ canReset: false, blockedReason: 'Platform yöneticisinin doğrulayıcısını yalnızca platform ekibi sıfırlayabilir.' }) });
    expect(api.fetchMfaUser).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('yalnızca platform ekibi');
    expect(view.host.querySelector('textarea')).toBeNull();
    await view.unmount();
  });
});
