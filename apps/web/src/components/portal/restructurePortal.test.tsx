// @vitest-environment happy-dom
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallmentPlanCard } from './InstallmentPlanCard';
import { OffsetRequestCard } from './OffsetRequestCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = 'recv-u1-occupant';
const OWNER = 'recv-u1-owner';
const mutateAsync = vi.fn().mockResolvedValue({});
let plans: unknown[] | undefined;
let options: unknown;
let requests: unknown[] = [];
vi.mock('@/hooks/useRestructure', () => ({
  useMyPlans: () => ({ isPending: false, isError: false, data: plans }),
  useOffsetOptions: () => ({ isPending: false, isError: false, data: options }),
  useMyOffsetRequests: () => ({ data: requests }),
  useCreateOffsetRequest: () => ({ isPending: false, isError: false, error: null, mutateAsync }),
}));

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockClear();
});

function render(node: ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(node));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const PLAN = {
  planId: 'p1',
  liableParty: 'occupant',
  date: '2026-11-05',
  total: 213667,
  frozenLateFee: 13667,
  status: 'active',
  paid: 53417,
  remaining: 160250,
  inDefault: true,
  rule: { consecutive: 2, total: 3, graceDays: 7 },
  installments: [
    { no: 1, dueDate: '2026-12-10', amount: 53417, paid: 53417, remaining: 0, overdue: false },
    { no: 2, dueDate: '2027-01-10', amount: 53417, paid: 0, remaining: 53417, overdue: true },
    { no: 3, dueDate: '2027-02-10', amount: 53417, paid: 0, remaining: 53417, overdue: true },
    { no: 4, dueDate: '2027-03-10', amount: 53416, paid: 0, remaining: 53416, overdue: false },
  ],
};

describe('Taksit Planim karti', () => {
  it('kalan borc, siradaki taksit, kalan taksitler ve muacceliyet uyarisi', () => {
    plans = [PLAN];
    render(<InstallmentPlanCard />);
    expect(container.textContent).toContain('Taksit Planım');
    expect(container.textContent).toContain('1.602,50');
    expect(container.textContent).toContain('Geciken taksitleriniz var');
    expect(container.textContent).toContain('2 ardışık veya toplam 3 taksit, 7');
    expect(container.textContent).toContain('Sıradaki taksit');
    expect(container.querySelectorAll('ul[aria-label="Kalan taksitler"] li')).toHaveLength(3);
  });

  it('muaccel plan: tek seferde odenecek tutar', () => {
    plans = [{ ...PLAN, status: 'accelerated', inDefault: false, accelerated: { dueDate: '2027-01-18', amount: 160250, paid: 0, remaining: 160250, overdue: false } }];
    render(<InstallmentPlanCard />);
    expect(container.textContent).toContain('Muaccel');
    expect(container.textContent).toContain('tek seferde ödenecek');
    expect(container.querySelector('ul[aria-label="Kalan taksitler"]')).toBeNull();
  });

  it('plan yoksa kart gosterilmez', () => {
    plans = [];
    render(<InstallmentPlanCard />);
    expect(container.textContent).toBe('');
  });
});

describe('Avans mahsubu talebi karti', () => {
  const OPTIONS = {
    unitId: 'u1',
    sources: [{ accountId: MAIN, name: 'Daire 5 - Sakin', advance: 60000 }],
    targets: [{ accountId: OWNER, name: 'Daire 5 - Kat Maliki', openDebt: 100000 }],
  };

  it('tutar siniri; talep gonderilir ve onceki talepler durumlariyla listelenir', async () => {
    options = OPTIONS;
    requests = [
      { requestId: 'r0', userId: 'own-1', unitId: 'u1', sourceAccountId: MAIN, targetAccountId: OWNER, amount: 10000, status: 'approved', createdAt: '2026-11-01T09:00:00.000Z', decision: { at: '2026-11-02T09:00:00.000Z', by: 'mgr', reason: 'ok', amount: 10000 } },
    ];
    render(<OffsetRequestCard />);
    expect(container.textContent).toContain('Avans mahsubu talebi');
    expect(container.textContent).toContain('Onaylandı');
    const amount = container.querySelector('input[aria-label="Tutar"]') as HTMLInputElement;
    setValue(amount, '700');
    expect(container.textContent).toContain('En fazla');
    expect(button('Talep gönder').disabled).toBe(true);
    setValue(amount, '200');
    await act(async () => {
      button('Talep gönder').click();
    });
    expect(mutateAsync).toHaveBeenCalledWith({ idempotencyKey: expect.any(String), sourceAccountId: MAIN, targetAccountId: OWNER, amount: 20000 });
    expect(container.textContent).toContain('Talebiniz yönetime iletildi');
  });

  it('avans veya borc yoksa ve talep de yoksa kart gosterilmez', () => {
    options = { ...OPTIONS, sources: [] };
    requests = [];
    render(<OffsetRequestCard />);
    expect(container.textContent).toBe('');
  });
});
