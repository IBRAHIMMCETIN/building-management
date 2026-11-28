// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Mobil uygulama "Online öde" -> /app/odeme?unitId=<daire>: istenen daire kullanicinin dairesiyse
 * secilir; degilse yok sayilir; parametre yoksa davranis degismez.
 */

const quoteFor = vi.fn((unitId: string | undefined) => ({
  unitId: unitId ?? 'u-3',
  currency: 'TRY',
  onlinePaymentEnabled: true,
  requiresGsmNumber: false,
  asOf: '2026-11-28T09:00:00.000Z',
  lateFeeMonthlyBasisPoints: 500,
  parties: [{ liableParty: 'owner', balance: 150000, debt: 150000, advance: 0, accruedLateFee: 0, totalDue: 150000, items: [], postedLateFees: [] }],
  totalDue: 150000,
}));

let contextsPending = false;
const user = { sub: 'user-1', role: 'resident', apartmentId: 'apt-1', exp: 0 };

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user }) }));
vi.mock('@/hooks/useContexts', () => ({
  useContexts: () =>
    contextsPending
      ? { isPending: true, data: undefined }
      : {
          isPending: false,
          data: {
            contexts: [
              {
                apartmentId: 'apt-1',
                apartmentName: 'Site',
                role: 'resident',
                units: [
                  { unitId: 'u-3', unitNumber: '3', relation: 'owner' },
                  { unitId: 'u-9', unitNumber: '9', relation: 'tenant' },
                ],
              },
            ],
          },
        },
}));
vi.mock('@/hooks/usePayments', async () => {
  const { usePortalUnit } = await import('@/context/PortalUnitContext');
  return {
    usePaymentQuote: () => ({ isPending: false, isError: false, data: quoteFor(usePortalUnit().unitId) }),
    useCreatePayment: () => ({ isPending: false, isError: false, error: null, reset: vi.fn(), mutateAsync: vi.fn() }),
  };
});

const { PortalUnitProvider } = await import('@/context/PortalUnitContext');
const { PaymentPage } = await import('./PaymentPage');

const KEY = 'bm.portal-unit.user-1.apt-1';
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  contextsPending = false;
});
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});

async function render(url: string) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <MemoryRouter initialEntries={[url]}>
        <PortalUnitProvider>
          <PaymentPage />
        </PortalUnitProvider>
      </MemoryRouter>,
    ),
  );
}

const lastQuotedUnit = () => quoteFor.mock.calls.at(-1)?.[0];

describe('online odeme: istenen daire (?unitId=)', () => {
  it('kullanicinin dairesiyse secilir ve odeme o daire icin hazirlanir', async () => {
    localStorage.setItem(KEY, 'u-3');
    await render('/app/odeme?unitId=u-9');
    expect(localStorage.getItem(KEY)).toBe('u-9');
    expect(lastQuotedUnit()).toBe('u-9');
    expect(container.textContent).toContain('Kartla güvenli öde');
  });

  it('kullanicinin dairesi degilse yok sayilir (secim degismez)', async () => {
    localStorage.setItem(KEY, 'u-3');
    await render('/app/odeme?unitId=baskasinin-dairesi');
    expect(localStorage.getItem(KEY)).toBe('u-3');
    expect(lastQuotedUnit()).toBe('u-3');
    expect(container.textContent).toContain('Kartla güvenli öde');
  });

  it('baglamlar yuklenirken form gosterilmez (eski dairenin borcu odenmesin)', async () => {
    contextsPending = true;
    localStorage.setItem(KEY, 'u-3');
    await render('/app/odeme?unitId=u-9');
    expect(container.querySelector('[aria-label="Ödeme bilgileri yükleniyor"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Kartla güvenli öde');
  });

  it('parametre yoksa davranis degismez', async () => {
    localStorage.setItem(KEY, 'u-3');
    await render('/app/odeme');
    expect(localStorage.getItem(KEY)).toBe('u-3');
    expect(lastQuotedUnit()).toBe('u-3');
    expect(container.textContent).toContain('Kartla güvenli öde');
  });
});
