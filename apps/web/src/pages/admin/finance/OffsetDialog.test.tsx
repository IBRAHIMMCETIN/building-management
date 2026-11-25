// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OffsetDialog } from './OffsetDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = 'recv-u1-occupant';
const OWNER = 'recv-u1-owner';
const mutateAsync = vi.fn().mockResolvedValue({});
const mutation = { isPending: false, isError: false, error: null, mutateAsync, reset: () => {} };
let preview: unknown;
vi.mock('@/hooks/useFinance', () => ({
  useFinanceAccounts: () => ({
    isError: false,
    isSuccess: true,
    data: [
      { accountId: MAIN, type: 'receivable', name: 'Daire 5 - Sakin', status: 'active', balance: -60000, unitId: 'u1', liableParty: 'occupant' },
      { accountId: OWNER, type: 'receivable', name: 'Daire 5 - Kat Maliki', status: 'active', balance: 100000, unitId: 'u1', liableParty: 'owner' },
    ],
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
  useOffsetPreview: () => ({ isFetching: false, isError: false, data: preview }),
  useCreateOffset: () => mutation,
}));

const PREVIEW = {
  sourceAccountId: MAIN,
  targetAccountId: OWNER,
  sourceAdvance: 60000,
  targetOpenDebt: 100000,
  maxAmount: 60000,
  samePerson: true,
  consentRequired: false,
  targetOpenItems: [
    { chargeId: 'c-sep', description: 'Aidat Eylül', dueDate: '2026-09-10', remaining: 50000, overdue: true },
    { chargeId: 'c-oct', description: 'Aidat Ekim', dueDate: '2026-10-10', remaining: 50000, overdue: true },
  ],
};

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockClear();
});

function render(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<OffsetDialog open onClose={onClose} preset={{ sourceAccountId: MAIN, targetAccountId: OWNER }} />));
  return onClose;
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const checkbox = (text: string) => [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(text))?.querySelector('input') as HTMLInputElement;
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const reason = () => container.querySelector('textarea') as HTMLTextAreaElement;
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

describe('Avans mahsubu diyalogu', () => {
  it('ayni kisi: onizleme, tamamini mahsup et ve kaydet', async () => {
    preview = PREVIEW;
    const onClose = render();
    expect(container.textContent).toContain('Serbest avans');
    expect(container.textContent).toContain('Aynı kişi');
    expect(container.textContent).not.toContain('muvafakat alındı');
    await click(button('Tamamını mahsup et'));
    expect((container.querySelector('input[aria-label="Tutar"]') as HTMLInputElement).value).toBe('600,00');
    setValue(reason(), 'Fazla ödeme aidata sayıldı');
    expect(container.textContent).toContain('Mahsup sonrası');
    await click(button('Mahsubu kaydet'));
    expect(mutateAsync).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      sourceAccountId: MAIN,
      targetAccountId: OWNER,
      amount: 60000,
      reason: 'Fazla ödeme aidata sayıldı',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('tutar siniri ve gerekce: hatalar gosterilir, istek gitmez', async () => {
    preview = PREVIEW;
    render();
    setValue(container.querySelector('input[aria-label="Tutar"]') as HTMLInputElement, '700');
    await click(button('Mahsubu kaydet'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Tutar en fazla');
    expect(container.textContent).toContain('Gerekçe en az 5 karakter');
    expect(button('Mahsubu kaydet').disabled).toBe(true);
  });

  it('farkli kisiler: muvafakat beyani + aciklama olmadan kaydedilmez', async () => {
    preview = { ...PREVIEW, samePerson: false, consentRequired: true };
    render();
    expect(container.textContent).toContain('Farklı kişiler');
    setValue(container.querySelector('input[aria-label="Tutar"]') as HTMLInputElement, '100');
    setValue(reason(), 'Kiracı avansı malik borcuna');
    await click(button('Mahsubu kaydet'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('muvafakat beyanı gerekli');
    await click(checkbox('muvafakat alındı'));
    setValue(container.querySelector('input[maxlength="300"]') as HTMLInputElement, 'Kiracı yazılı onay verdi');
    await click(button('Mahsubu kaydet'));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10000, consent: { thirdParty: true, note: 'Kiracı yazılı onay verdi' } }),
    );
  });

  it('kalem secerek: secilen kalemin kalani hedefli mahsup olarak gider', async () => {
    preview = PREVIEW;
    render();
    await click(checkbox('Kalem seçerek'));
    expect(container.querySelector('input[aria-label="Tutar"]')).toBeNull();
    await click(container.querySelector('input[value="c-oct"]') as HTMLInputElement);
    setValue(reason(), 'Ekim aidatına mahsup');
    await click(button('Mahsubu kaydet'));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50000, settles: [{ chargeId: 'c-oct', amount: 50000 }] }),
    );
  });
});
