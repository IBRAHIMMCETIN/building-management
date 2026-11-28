// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PayableAccount } from '@/lib/api/finance';
import type { SupplierAdvance } from '@/lib/api/supplierAdvances';
import { AdvanceOffsetDialog, SupplierAdvanceDialog, SupplierAdvancesList, SupplierStatementDialog } from './SupplierAdvances';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = () => ({ isPending: false, isError: false, error: null, mutateAsync: vi.fn().mockResolvedValue({}), reset: () => {} });
let create = m();
let offset = m();
let reverseOffset = m();
let advances: SupplierAdvance[] = [];
vi.mock('@/hooks/useFinance', () => ({
  useFinanceAccounts: () => ({ data: [{ accountId: 'cash', name: 'Kasa', type: 'cash', status: 'active', balance: 1500000 }] }),
}));
vi.mock('@/hooks/useSupplierAdvances', () => ({
  useCreateSupplierAdvance: () => create,
  useOffsetSupplierAdvance: () => offset,
  useReverseSupplierAdvance: () => m(),
  useReverseAdvanceOffset: () => reverseOffset,
  useSupplierAdvances: () => ({ isPending: false, isError: false, data: { items: advances, totalOpen: 0 } }),
  useAdvanceOffsetPreview: () => ({
    isPending: false,
    isError: false,
    data: {
      advanceId: 'adv1',
      payableAccountId: 'pay-asansor',
      advanceOpen: 500000,
      openBalance: 700000,
      maxAmount: 500000,
      openItems: [
        { transactionId: 'inv-a', date: '2026-10-01', description: 'Fatura A-1', amount: 300000, open: 300000 },
        { transactionId: 'inv-b', date: '2026-10-15', description: 'Fatura B-1', amount: 400000, open: 400000 },
      ],
    },
  }),
  useSupplierStatement: () => ({
    isPending: false,
    isError: false,
    data: {
      accountId: 'pay-asansor',
      name: 'Asansör Bakım Ltd.',
      opening: { payableBalance: 0, advanceBalance: 0, net: 0 },
      closing: { payableBalance: 200000, advanceBalance: 0, net: 200000 },
      rows: [
        { date: '2026-09-05', transactionId: 't1', category: 'advance', description: 'Avans', payableChange: 0, advanceChange: 500000, payableBalance: 0, advanceBalance: 500000, net: -500000 },
        { date: '2026-10-01', transactionId: 't2', category: 'invoice', description: 'Fatura A-1', payableChange: 700000, advanceChange: 0, payableBalance: 700000, advanceBalance: 500000, net: 200000 },
        { date: '2026-11-01', transactionId: 't3', category: 'advance_offset', description: 'Avans mahsubu', payableChange: -500000, advanceChange: -500000, payableBalance: 200000, advanceBalance: 0, net: 200000 },
      ],
      totals: { invoice: 700000, payment: 0, advanceGiven: 500000, advanceApplied: 500000 },
      summary: { billed: 700000, paid: 0, advanceApplied: 500000, openBalance: 200000, advanceOpen: 0, net: 200000 },
      openItems: [],
      openAdvances: [],
    },
  }),
}));

const PAYABLE: PayableAccount = { accountId: 'pay-asansor', name: 'Asansör Bakım Ltd.', status: 'active', openBalance: 700000, advanceOpen: 500000, version: 3, openItems: [] };
const ADVANCE: SupplierAdvance = {
  advanceId: 'adv1',
  payableAccountId: 'pay-asansor',
  fundsAccountId: 'cash',
  amount: 500000,
  applied: 200000,
  open: 300000,
  date: '2026-09-05',
  description: 'Revizyon avansı',
  transactionId: 'tx-adv',
  status: 'open',
  offsets: [{ offsetId: 'o1', advanceId: 'adv1', amount: 200000, date: '2026-10-20', settles: [{ transactionId: 'inv-b', amount: 200000 }], transactionId: 'tx-o1', status: 'completed', reason: 'B faturası', createdAt: '2026-10-20T09:00:00.000Z' }],
  createdAt: '2026-09-05T09:00:00.000Z',
};

let container: HTMLDivElement;
afterEach(() => container?.remove());
function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(node));
}
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.textContent?.includes(text)) as HTMLButtonElement;
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = async (form: HTMLFormElement) =>
  act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

describe('tedarikci avansi', () => {
  it('avans verme: kasa, tutar, referans gonderilir', async () => {
    create = m();
    render(<SupplierAdvanceDialog payable={PAYABLE} onClose={() => {}} />);
    expect(container.textContent).toContain('açık avans olarak izlenir');
    const [amount] = [...container.querySelectorAll('input')] as HTMLInputElement[];
    setValue(amount as HTMLInputElement, '5000');
    setValue(container.querySelectorAll('input')[2] as HTMLInputElement, 'DEKONT-1');
    await submit(container.querySelector('form') as HTMLFormElement);
    expect(create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ payableAccountId: 'pay-asansor', fundsAccountId: 'cash', amount: 500000, reference: 'DEKONT-1' }));
  });

  it('mahsup: secilen fatura hedefli (settles), secilmezse FIFO tutar; gerekce zorunlu', async () => {
    offset = m();
    render(<AdvanceOffsetDialog advance={ADVANCE} payableName="Asansör Bakım Ltd." onClose={() => {}} />);
    expect(container.textContent).toContain('en fazla ₺5.000,00');
    await submit(container.querySelector('form') as HTMLFormElement);
    expect(offset.mutateAsync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Gerekçe en az 5 karakter');
    act(() => (container.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click());
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'B faturasına mahsup');
    await submit(container.querySelector('form') as HTMLFormElement);
    expect(offset.mutateAsync).toHaveBeenCalledWith({
      advanceId: 'adv1',
      input: expect.objectContaining({ amount: 400000, settles: [{ transactionId: 'inv-b', amount: 400000 }], reason: 'B faturasına mahsup' }),
    });
  });

  it('avans listesi: acik kalan, mahsuplar ve gerekceli geri alma', async () => {
    reverseOffset = m();
    advances = [ADVANCE];
    render(<SupplierAdvancesList payable={PAYABLE} canWrite />);
    expect(container.textContent).toContain('Verilen avanslar');
    expect(container.textContent).toContain('açık ₺3.000,00');
    expect(container.textContent).toContain('B faturası');
    expect(button('İptal et')).toBeUndefined();
    act(() => button('Geri al').click());
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'Yanlış fatura');
    await act(async () => {
      button('Mahsubu geri al').click();
    });
    expect(reverseOffset.mutateAsync).toHaveBeenCalledWith({ offsetId: 'o1', reason: 'Yanlış fatura' });
  });

  it('ekstre: kategoriler, isaretli degisimler ve kapanis bakiyeleri', () => {
    render(<SupplierStatementDialog payable={PAYABLE} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Avans');
    expect(rows[2]?.textContent).toContain('Avans mahsubu');
    expect(rows[2]?.textContent).toContain('−₺5.000,00');
    expect(container.textContent).toContain('Net (borç − avans)');
  });
});
