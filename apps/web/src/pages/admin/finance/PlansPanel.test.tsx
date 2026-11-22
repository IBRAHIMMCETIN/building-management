// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallmentPlan } from '@/lib/api/restructure';
import { DEFAULT_RULE } from '@/lib/restructure/model';
import { PlansPanel } from './PlansPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = 'recv-u1-occupant';
const OWNER = 'recv-u1-owner';
const m = () => ({ isPending: false, isError: false, error: null, mutateAsync: vi.fn().mockResolvedValue({}), reset: () => {} });
let action = m();
let approve = m();
let reject = m();
let plans: InstallmentPlan[] = [];
let requests: unknown[] = [];

vi.mock('@/hooks/useFinance', () => ({
  useFinanceAccounts: () => ({
    data: [
      { accountId: MAIN, name: 'Daire 5 - Sakin', type: 'receivable', status: 'active', balance: 0 },
      { accountId: OWNER, name: 'Daire 5 - Kat Maliki', type: 'receivable', status: 'active', balance: 0 },
    ],
  }),
}));
vi.mock('@/hooks/useRestructure', () => ({
  usePlans: () => ({ isPending: false, isError: false, isSuccess: true, data: plans }),
  useOffsetRequests: () => ({ isError: false, data: requests }),
  usePlanAction: () => action,
  useApproveOffsetRequest: () => approve,
  useRejectOffsetRequest: () => reject,
}));

const inst = (no: number, dueDate: string, remaining: number, overdue: boolean) => ({
  no,
  description: `T${no}`,
  dueDate,
  amount: 53417,
  feeBase: 50000,
  chargeId: `rs_${no}`,
  paid: 53417 - remaining,
  remaining,
  overdue,
  daysOverdue: overdue ? 30 : 0,
  settledByAcceleration: false,
});

const PLAN: InstallmentPlan = {
  planId: 'p1',
  accountId: MAIN,
  unitId: 'u1',
  liableParty: 'occupant',
  date: '2026-11-05',
  frozenLateFee: 13667,
  includeLateFees: true,
  total: 213668,
  feeBaseTotal: 200000,
  installments: [1, 2, 3, 4].map((no) => ({ no, description: `T${no}`, dueDate: '2026-12-10', amount: 53417, feeBase: 50000, chargeId: `rs_${no}` })),
  rule: DEFAULT_RULE,
  status: 'active',
  default: { detectedAt: '2027-01-18', overdueNos: [1, 2] },
  reason: 'Sakin talebi',
  createdAt: '2026-11-05T09:00:00.000Z',
  state: {
    installments: [inst(1, '2026-12-10', 53417, true), inst(2, '2027-01-10', 53417, true), inst(3, '2027-02-10', 53417, false), inst(4, '2027-03-10', 53417, false)],
    paid: 0,
    remaining: 213668,
    overdueNos: [1, 2],
    inDefault: true,
    completed: false,
    displayStatus: 'active',
  },
};

const REQUEST = {
  requestId: 'r1',
  userId: 'own-1',
  unitId: 'u1',
  sourceAccountId: MAIN,
  targetAccountId: OWNER,
  amount: 20000,
  note: 'Avansım aidata sayılsın',
  status: 'pending',
  createdAt: '2026-11-05T09:00:00.000Z',
};

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  action = m();
  approve = m();
  reject = m();
});

function render() {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<PlansPanel canWrite />));
}
const buttons = (text: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes(text)) as HTMLButtonElement[];
const button = (text: string) => buttons(text)[0] as HTMLButtonElement;
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

describe('Taksit planlari paneli', () => {
  it('temerrut uyarisi, cizelge ve yonetici onayiyla muaccel kilma', async () => {
    plans = [PLAN];
    requests = [];
    render();
    expect(container.textContent).toContain('Daire 5 - Sakin');
    expect(container.textContent).toContain('1 planda temerrüt');
    expect(container.textContent).toContain('1, 2. taksit(ler) ek süreye rağmen ödenmedi');
    expect(container.textContent).toContain('Sıradaki');

    await click(button('Taksit çizelgesi'));
    expect(container.querySelectorAll('table[aria-label="Taksit çizelgesi"] tbody tr')).toHaveLength(4);
    expect(container.textContent).toContain('Gecikmede');

    await click(button('Muaccel kıl'));
    expect(container.textContent).toContain('bugün vadeli tek borca');
    await click(button('Muaccel kıl'));
    expect(action.mutateAsync).not.toHaveBeenCalled();
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'Temerrüt - muaccel');
    await click(button('Muaccel kıl'));
    expect(action.mutateAsync).toHaveBeenCalledWith({ planId: 'p1', action: 'accelerate', reason: 'Temerrüt - muaccel' });
  });

  it('muaccel / tamamlanmis planlarda eylemler sinirli', () => {
    plans = [
      { ...PLAN, planId: 'p2', status: 'accelerated', default: undefined, state: { ...PLAN.state, inDefault: false, displayStatus: 'accelerated' } },
      { ...PLAN, planId: 'p3', default: undefined, state: { ...PLAN.state, inDefault: false, remaining: 0, completed: true, displayStatus: 'completed' } },
    ];
    requests = [];
    render();
    expect(buttons('Muaccel kıl')).toHaveLength(0);
    expect(buttons('Planı iptal et')).toHaveLength(1);
    expect(container.textContent).toContain('Tamamlandı');
    expect(container.textContent).not.toContain('planda temerrüt');
  });

  it('bekleyen sakin mahsup talebi: kismi onay ve ret', async () => {
    plans = [];
    requests = [REQUEST];
    render();
    expect(container.textContent).toContain('Bekleyen sakin mahsup talepleri (1)');
    expect(container.textContent).toContain('Daire 5 - Sakin → Daire 5 - Kat Maliki');
    await click(button('Onayla'));
    const amount = container.querySelector('input[aria-label="Onaylanan tutar"]') as HTMLInputElement;
    expect(amount.value).toBe('200,00');
    setValue(amount, '300');
    expect(button('Mahsubu onayla').disabled).toBe(true);
    setValue(amount, '150');
    await click(button('Mahsubu onayla'));
    expect(approve.mutateAsync).toHaveBeenCalledWith({ requestId: 'r1', input: { amount: 15000 } });

    await click(button('Reddet'));
    expect(button('Talebi reddet').disabled).toBe(true);
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'Malik ile görüşülecek');
    await click(button('Talebi reddet'));
    expect(reject.mutateAsync).toHaveBeenCalledWith({ requestId: 'r1', reason: 'Malik ile görüşülecek' });
  });
});
