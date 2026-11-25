// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanInput } from '@/lib/api/restructure';
import { DEFAULT_RULE } from '@/lib/restructure/model';
import { RestructureWizard } from './RestructureWizard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = 'recv-u1-occupant';
const mutateAsync = vi.fn().mockResolvedValue({});
const mutation = { isPending: false, isError: false, error: null, mutateAsync, reset: () => {} };
let openItems: unknown;
let lastInput: PlanInput | null = null;

const PREVIEW = {
  accountId: MAIN,
  date: '2026-11-05',
  lateFeeMonthlyBasisPoints: 500,
  frozenLateFee: 13667,
  includeLateFees: true,
  selected: [],
  total: 213667,
  feeBaseTotal: 200000,
  installments: [
    { no: 1, description: 'T1', dueDate: '2026-12-10', amount: 53417, feeBase: 50000 },
    { no: 2, description: 'T2', dueDate: '2027-01-10', amount: 53417, feeBase: 50000 },
    { no: 3, description: 'T3', dueDate: '2027-02-10', amount: 53417, feeBase: 50000 },
    { no: 4, description: 'T4', dueDate: '2027-03-10', amount: 53416, feeBase: 50000 },
  ],
  rule: DEFAULT_RULE,
};

vi.mock('@/hooks/useFinance', () => ({
  useFinanceAccounts: () => ({
    isError: false,
    isSuccess: true,
    data: [{ accountId: MAIN, type: 'receivable', name: 'Daire 5 - Sakin', status: 'active', balance: 200000, unitId: 'u1', liableParty: 'occupant' }],
  }),
}));
vi.mock('@/hooks/useAccountLabels', async () => {
  const { formatLedgerAccountLabel, sanitizeLedgerText } = await import('@/lib/finance/accountLabel');
  const ctx = { unitLabel: (id: string) => (id === 'u1' ? 'A · 5' : undefined), personName: () => undefined };
  return {
    useAccountLabels: () => ({
      ctx,
      label: (a: Parameters<typeof formatLedgerAccountLabel>[0]) => formatLedgerAccountLabel(a, ctx),
      labelOf: () => 'Cari',
      unitLabel: (id?: string, fb?: string) => (id === 'u1' ? 'A · 5' : (fb ?? 'Daire')),
      text: (t: string) => sanitizeLedgerText(t, ctx),
      accountById: new Map(),
    }),
  };
});
vi.mock('@/hooks/useRestructure', () => ({
  usePlanOpenItems: () => ({ isPending: false, isError: false, data: openItems }),
  usePlanPreview: (input: PlanInput | null) => {
    lastInput = input;
    return { isFetching: false, isError: false, data: input ? PREVIEW : undefined };
  },
  useCreatePlan: () => mutation,
}));

const OPEN = {
  accountId: MAIN,
  date: '2026-11-05',
  lateFeeMonthlyBasisPoints: 500,
  accruedLateFee: 13667,
  items: [
    { chargeId: 'c-sep', description: 'Aidat Eylül', dueDate: '2026-09-10', amount: 100000, remaining: 100000, overdue: true, lateFee: false },
    { chargeId: 'c-oct', description: 'Aidat Ekim', dueDate: '2026-10-10', amount: 100000, remaining: 100000, overdue: true, lateFee: false },
    { chargeId: 'old_1', description: 'Eski plan taksiti', dueDate: '2026-12-01', amount: 5000, remaining: 5000, overdue: false, lateFee: false, planId: 'p0' },
  ],
};

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockClear();
  lastInput = null;
});

function render(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<RestructureWizard open onClose={onClose} preset={{ accountId: MAIN }} />));
  return onClose;
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
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

describe('Borc yapilandirma sihirbazi', () => {
  it('kalemler -> taksitler -> onizleme -> olustur', async () => {
    openItems = OPEN;
    const onClose = render();
    // Plana ait kalem listelenmez; dondurulacak tazminat gosterilir.
    expect(container.textContent).toContain('Aidat Eylül');
    expect(container.textContent).not.toContain('Eski plan taksiti');
    expect(container.textContent).toContain('136,67');
    expect(button('Devam').disabled).toBe(true);
    await click(button('Tümünü seç'));
    expect(container.textContent).toContain('2.000,00');
    await click(button('Devam'));

    setValue(input('Taksit sayısı'), '4');
    setValue(input('İlk taksit vadesi'), '2026-12-10');
    expect(container.textContent).toContain('534,17');
    // Esik hatasi: ardisik > toplam.
    setValue(input('Ardışık geciken taksit'), '5');
    expect(container.textContent).toContain('Toplam eşikten büyük olamaz');
    expect(button('Önizle').disabled).toBe(true);
    setValue(input('Ardışık geciken taksit'), '2');
    await click(button('Önizle'));

    expect(lastInput).toEqual({ accountId: MAIN, chargeIds: ['c-sep', 'c-oct'], installments: 4, firstDueDate: '2026-12-10', includeLateFees: true, rule: DEFAULT_RULE });
    const rows = container.querySelectorAll('table[aria-label="Taksit tablosu"] tbody tr');
    expect(rows).toHaveLength(4);
    expect(rows[3]?.textContent).toContain('534,16');
    await click(button('Planı oluştur'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Gerekçe en az 5 karakter');
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'Sakin 4 taksit talep etti');
    await click(button('Planı oluştur'));
    expect(mutateAsync).toHaveBeenCalledWith({ ...lastInput, idempotencyKey: expect.any(String), reason: 'Sakin 4 taksit talep etti' });
    expect(onClose).toHaveBeenCalled();
  });

  it('tazminat plana alinmayabilir; geri ile onceki adima donulur', async () => {
    openItems = OPEN;
    render();
    await click(container.querySelector('input[value="c-oct"]') as HTMLInputElement);
    const lf = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('Dondurulan tazminatı'))?.querySelector('input') as HTMLInputElement;
    await click(lf);
    await click(button('Devam'));
    setValue(input('İlk taksit vadesi'), '2026-12-10');
    await click(button('Önizle'));
    expect(lastInput).toMatchObject({ chargeIds: ['c-oct'], includeLateFees: false, installments: 6 });
    await click(button('Geri'));
    expect(container.textContent).toContain('Taksit sayısı');
  });

  it('aktif plani olan cari yapilandirilamaz', () => {
    openItems = { ...OPEN, activePlanId: 'p1' };
    render();
    expect(container.textContent).toContain('zaten aktif bir yapılandırma planı var');
    expect(button('Devam').disabled).toBe(true);
  });
});
