// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import type { Role } from '@/types/roles';
import { APARTMENT_ADMIN_ROLES, PLATFORM_ROLES } from '@/types/roles';
import { RequireRole } from './guards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** Router'daki /admin agacinin ozeti: apartman ve platform gruplari ayri korunur. */
async function landOn(path: string, role: Role | undefined, apartmentId?: string) {
  const auth = { user: role ? { sub: 'u1', role, apartmentId, exp: 0 } : { sub: 'u1', exp: 0 } } as unknown as AuthContextValue;
  const router = createMemoryRouter(
    [
      {
        path: '/admin',
        children: [
          {
            element: <RequireRole roles={APARTMENT_ADMIN_ROLES} redirectHome />,
            children: [
              { index: true, element: <Where /> },
              { path: 'finance', element: <Where /> },
            ],
          },
          {
            element: <RequireRole roles={PLATFORM_ROLES} redirectHome />,
            children: [
              { path: 'apartments', element: <Where /> },
              { path: 'payments', element: <Where /> },
            ],
          },
        ],
      },
      { path: '/select-context', element: <Where /> },
      { path: '*', element: <Where /> },
    ],
    { initialEntries: [path] },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AuthContext value={auth}>
        <RouterProvider router={router} />
      </AuthContext>,
    );
  });
  const where = host.querySelector('[data-testid="where"]')?.textContent;
  await act(async () => root.unmount());
  host.remove();
  return where;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('yonetim paneli yonlendirmesi', () => {
  it('platform yoneticisi /admin ve apartman ekranlarindan kendi acilis sayfasina yonlenir', async () => {
    expect(await landOn('/admin', 'platform_admin')).toBe('/admin/apartments');
    expect(await landOn('/admin/finance', 'platform_admin')).toBe('/admin/apartments');
    expect(await landOn('/admin/payments', 'platform_admin')).toBe('/admin/payments');
  });

  it('apartman rolleri platform ekranlarina giremez, kendi paneline doner', async () => {
    expect(await landOn('/admin/apartments', 'apartment_manager', 'apt-1')).toBe('/admin');
    expect(await landOn('/admin/payments', 'observer', 'apt-1')).toBe('/admin');
    expect(await landOn('/admin/finance', 'apartment_manager', 'apt-1')).toBe('/admin/finance');
  });

  it('rol secilmemisse baglam secimine gider', async () => {
    expect(await landOn('/admin', undefined)).toBe('/select-context');
  });
});
