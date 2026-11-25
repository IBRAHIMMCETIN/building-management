// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import { AUDIT_FIXTURE } from '@/lib/audit/fixture';
import { AuditPage } from './AuditPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ page: vi.fn(), integrity: vi.fn() }));
vi.mock('@/lib/api/audit', () => ({ auditApi: api }));
vi.mock('@/hooks/useUnits', () => ({
  usePeople: () => ({ data: [{ userId: 'mgr-1', fullName: 'Ayşe Yönetici', email: 'a@o.com' }] }),
}));
vi.mock('@/lib/api/apartmentRoles', () => ({ apartmentRolesApi: { listCurrent: vi.fn().mockResolvedValue({ items: [] }) } }));

const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));

async function render(user: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext value={{ user } as unknown as AuthContextValue}>
          <AuditPage />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return { host, unmount: () => act(async () => root.unmount()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.page.mockResolvedValue({ items: structuredClone(AUDIT_FIXTURE) });
  api.integrity.mockResolvedValue({ status: 'verified', latestSeq: 2, verifiedSeq: 2, verifiedAt: '2026-11-21T00:40:00.000Z', staleAfterHours: 26 });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('AuditPage', () => {
  it('apartman zinciri: kayitlar Turkce, aktor adi cozulur, sunucu ve tarayici dogrulamasi gorunur', async () => {
    const view = await render({ sub: 'mgr-1', role: 'apartment_manager', apartmentId: 'apt-1', exp: 0 });
    expect(api.page).toHaveBeenCalledWith('apartment', {}, undefined, expect.anything());
    expect(view.host.textContent).toContain('Zincir doğrulandı');
    expect(view.host.textContent).toContain('Defter: tahsilat');
    expect(view.host.textContent).toContain('Ayşe Yönetici');
    expect(view.host.querySelector('[data-testid="page-check"]')?.textContent).toContain('2 kayıt tarayıcıda doğrulandı');

    const row = [...view.host.querySelectorAll('ul[aria-label="Denetim kayıtları"] button')].find((b) => b.textContent?.includes('#1'));
    await act(async () => (row as HTMLButtonElement).click());
    expect(document.body.textContent).toContain(AUDIT_FIXTURE[1]!.hash);
    expect(document.body.textContent).toContain('Hash ve bağ doğru');
    await view.unmount();
  });

  it('kurcalanmis kayit tarayicida yakalanir; bayat dogrulama uyarisi', async () => {
    const tampered = structuredClone(AUDIT_FIXTURE);
    tampered[1]!.reason = 'sonradan değişti';
    api.page.mockResolvedValue({ items: tampered });
    api.integrity.mockResolvedValue({ status: 'stale', latestSeq: 2, verifiedSeq: 1, verifiedAt: '2026-11-18T00:40:00.000Z', staleAfterHours: 26 });
    const view = await render({ sub: 'o-1', role: 'observer', apartmentId: 'apt-1', exp: 0 });
    expect(view.host.querySelector('[data-testid="page-check"]')?.textContent).toContain('1 kayıt doğrulanamadı');
    expect(view.host.textContent).toContain('Doğrulama güncel değil');
    await view.unmount();
  });

  it('platform yoneticisi platform zincirini okur; filtreler API sorgusuna gecer', async () => {
    const view = await render({ sub: 'admin-1', role: 'platform_admin', exp: 0 });
    expect(api.page).toHaveBeenCalledWith('platform', {}, undefined, expect.anything());
    expect(api.integrity).toHaveBeenCalledWith('platform', expect.anything());

    const form = view.host.querySelector('form[aria-label="Denetim filtresi"]') as HTMLFormElement;
    const select = form.querySelector('select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'mfa.');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => form.requestSubmit());
    await flush();
    expect(api.page).toHaveBeenLastCalledWith('platform', { action: 'mfa.' }, undefined, expect.anything());
    await view.unmount();
  });
});
