// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BankLine } from '@/lib/api/bank';
import { SettlePayableDialog } from './SettlePayableDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mutateAsync = vi.fn().mockResolvedValue({});
const mutation = { isPending: false, isError: false, error: null, mutateAsync, reset: () => {} };
let data: unknown;
vi.mock('@/hooks/useBank', () => ({
  usePayableSuggestions: () => ({ isPending: false, isError: false, data }),
  useSettlePayable: () => mutation,
}));

const LINE = {
  lineId: '20261110_bbbbbbbbbbbbbbbbbbbbbbbb',
  bankAccountId: 'bank',
  statementId: 's',
  sourceRow: 4,
  date: '2026-11-10',
  direction: 'out',
  amount: 245075,
  description: 'ENERJISA FATURA EA2026000123',
  counterpartyName: 'ENERJISA BASKENT',
  status: 'unmatched',
  version: 2,
} as BankLine;

const PAYABLES = [
  { accountId: 'pay-asansor', name: 'Asansör Bakım Ltd.', openBalance: 900000, openItems: [{ amount: 900000, description: 'Yıllık bakım' }] },
  { accountId: 'pay-enerjisa', name: 'Enerjisa Başkent', openBalance: 245075, openItems: [{ amount: 245075, description: 'Ekim faturası', reference: 'EA2026000123' }] },
];

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockClear();
});

function render(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<SettlePayableDialog open line={LINE} bankAccountId="bank" onClose={onClose} />));
  return onClose;
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

describe('Tedarikci odemesi diyalogu', () => {
  it('oneri onceden secilir, kalan borc gosterilir; kaydet istegi satir surumuyle gider', async () => {
    data = {
      suggestions: [{ kind: 'payable', payableAccountId: 'pay-enerjisa', name: 'Enerjisa Başkent', openBalance: 245075, confidence: 0.95, reasons: ['Tutar açık borca eşit'] }],
      payables: PAYABLES,
    };
    const onClose = render();
    const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['pay-enerjisa', 'pay-asansor']);
    expect(radios[0]?.checked).toBe(true);
    expect(container.textContent).toContain('Ödeme sonrası kalan borç');
    expect(container.textContent).toContain('Tutar açık borca eşit');
    await act(async () => {
      button('Ödemeyi kaydet').click();
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      lineId: LINE.lineId,
      input: { bankAccountId: 'bank', expectedVersion: 2, payableAccountId: 'pay-enerjisa', source: 'suggestion', confidence: 0.95 },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('acik borcu asan secim kaydedilemez', () => {
    data = { suggestions: [], payables: [{ ...PAYABLES[1], openBalance: 100000 }] };
    render();
    expect(button('Ödemeyi kaydet').disabled).toBe(true);
    act(() => {
      (container.querySelector('input[type="radio"]') as HTMLInputElement).click();
    });
    expect(container.textContent).toContain('açık borcunu aşıyor');
    expect(button('Ödemeyi kaydet').disabled).toBe(true);
  });

  it('acik borclu tedarikci yoksa yonlendirme', () => {
    data = { suggestions: [], payables: [] };
    render();
    expect(container.textContent).toContain('Açık borcu olan tedarikçi yok');
  });
});
