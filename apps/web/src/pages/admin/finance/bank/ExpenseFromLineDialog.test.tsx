// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BankLine } from '@/lib/api/bank';
import { ApiError } from '@/lib/api/errors';
import { ExpenseFromLineDialog } from './ExpenseFromLineDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mutateAsync = vi.fn().mockResolvedValue({});
let mutation: { isPending: boolean; isError: boolean; error: unknown; mutateAsync: typeof mutateAsync; reset: () => void } = {
  isPending: false,
  isError: false,
  error: null,
  mutateAsync,
  reset: () => {},
};
vi.mock('@/hooks/useBank', () => ({ useCreateBankExpense: () => mutation }));

const ACCOUNTS = [
  { accountId: 'exp-cleaning', type: 'expense', name: 'Temizlik', status: 'active', balance: 0 },
  { accountId: 'exp-electricity', type: 'expense', name: 'Ortak Elektrik', status: 'active', balance: 0 },
];
vi.mock('@/hooks/useFinance', () => ({ useFinanceAccounts: () => ({ isPending: false, isError: false, data: ACCOUNTS }) }));

const LINE = {
  lineId: '20261104_aaaaaaaaaaaaaaaaaaaaaaaa',
  bankAccountId: 'bank',
  statementId: 's',
  sourceRow: 3,
  date: '2026-11-04',
  direction: 'out',
  amount: 245075,
  description: 'ENERJISA FATURA 2026/10',
  counterpartyName: 'ENERJISA BASKENT',
  status: 'unmatched',
  version: 4,
} as BankLine;

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockClear();
});

function render(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<ExpenseFromLineDialog open line={LINE} bankAccountId="bank" onClose={onClose} />));
  return onClose;
}

describe('Gider olustur diyalogu', () => {
  it('banka satirindan varsayilanlar: tutar, aciklama, tedarikci ve tahmin edilen kalem', () => {
    render();
    expect(container.textContent).toContain('2.450,75');
    expect((container.querySelector('select[aria-label="Gider kalemi"]') as HTMLSelectElement).value).toBe('exp-electricity');
    expect((container.querySelector('input[aria-label="Açıklama"]') as HTMLInputElement).value).toBe('ENERJISA FATURA 2026/10');
    expect((container.querySelector('input[aria-label="Tedarikçi"]') as HTMLInputElement).value).toBe('ENERJISA BASKENT');
  });

  it('kaydet: satir surumu ve banka hesabiyla gider istegi gonderilir, diyalog kapanir', async () => {
    const onClose = render();
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      lineId: LINE.lineId,
      input: {
        bankAccountId: 'bank',
        expectedVersion: 4,
        expenseAccountId: 'exp-electricity',
        description: 'ENERJISA FATURA 2026/10',
        supplier: 'ENERJISA BASKENT',
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('API hatasi diyalogda gosterilir', () => {
    mutation = { ...mutation, isError: true, error: new ApiError(409, { error: 'version_conflict', message: 'Satır başka bir işlemle değişti' }) };
    render();
    expect(container.textContent).toContain('Satır başka bir işlemle değişti');
    mutation = { ...mutation, isError: false, error: null };
  });
});
