// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanRequestsSection, approvalInput } from './PlanRequestsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = 'recv-u1-occupant';
const m = () => ({ isPending: false, isError: false, error: null, mutateAsync: vi.fn().mockResolvedValue({}), reset: () => {} });
let approve = m();
let reject = m();
let save = m();
let items: unknown[] = [];
const SETTINGS = { isPending: false, isError: false, data: { version: 3, settings: { enabled: true, maxInstallments: 6, minInstallmentAmount: 50000, includeLateFees: true } } };
const ASIS = { accountId: MAIN, chargeIds: ['c1', 'c2'], installments: 4, firstDueDate: '2026-12-10', includeLateFees: true };
vi.mock('@/hooks/useRestructure', () => ({
  usePlanRequests: () => ({ isPending: false, isError: false, isSuccess: true, data: { items, pendingCount: items.length } }),
  usePlanRequestDetail: () => ({ isPending: false, isError: false, data: { request: items[0], settings: {}, asIs: ASIS } }),
  usePlanPreview: () => ({ isError: false, data: { total: 301200, frozenLateFee: 1200, installments: [{ amount: 75300 }] } }),
  useApprovePlanRequest: () => approve,
  useRejectPlanRequest: () => reject,
  usePlanRequestSettings: () => SETTINGS,
  useSavePlanRequestSettings: () => save,
}));

let container: HTMLDivElement;
afterEach(() => container?.remove());

function render() {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<PlanRequestsSection canWrite nameOf={() => 'A · 5 Sakin'} />));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const REQ = {
  requestId: 'r1',
  userId: 'tenant-a',
  unitId: 'u1',
  accountId: MAIN,
  liableParty: 'occupant',
  installments: 4,
  note: 'Maaşım gecikti',
  estimate: { overdue: 300000, accruedLateFee: 1200, total: 301200, installmentAmount: 75300 },
  status: 'pending',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

describe('approvalInput', () => {
  it('degisiklik yoksa bos (olduğu gibi), varsa yalnizca degisen alanlar', () => {
    expect(approvalInput(ASIS, { installments: 4, firstDueDate: '2026-12-10', includeLateFees: true, reason: ' ' })).toEqual({});
    expect(approvalInput(ASIS, { installments: 3, firstDueDate: '2026-12-10', includeLateFees: false, reason: 'Üç taksit' })).toEqual({ installments: 3, includeLateFees: false, reason: 'Üç taksit' });
  });
});

describe('Sakin taksit talepleri kuyrugu', () => {
  it('bekleyen talep: istenen taksit, tahmin ve not; olduğu gibi onay bos govdeyle plan olusturur', async () => {
    approve = m();
    items = [REQ];
    render();
    expect(container.textContent).toContain('Sakin taksit talepleri (1 bekliyor)');
    expect(container.textContent).toContain('4 taksit istendi');
    expect(container.textContent).toContain('3.012,00');
    expect(container.textContent).toContain('Maaşım gecikti');
    act(() => button('Olduğu gibi onayla').click());
    expect(container.textContent).toContain('ilk taksit 10 Ara 2026');
    expect(container.textContent).toContain('Plan toplamı');
    await act(async () => {
      button('Planı oluştur').click();
    });
    expect(approve.mutateAsync).toHaveBeenCalledWith({ requestId: 'r1', input: {} });
  });

  it('degistirerek onay: taksit sayisi ve tazminat secimi gonderilir', async () => {
    approve = m();
    items = [REQ];
    render();
    act(() => button('Değiştir').click());
    setValue(container.querySelector('input[type="number"]') as HTMLInputElement, '3');
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => {
      button('Değiştirerek onayla').click();
    });
    expect(approve.mutateAsync).toHaveBeenCalledWith({ requestId: 'r1', input: { installments: 3, includeLateFees: false } });
  });

  it('ret: gerekce en az 5 karakter; sonuclanan talepler durumlariyla', async () => {
    reject = m();
    items = [REQ, { ...REQ, requestId: 'r0', status: 'rejected', decision: { at: '2026-10-01T09:00:00.000Z', by: 'mgr', mode: 'rejected', reason: 'Belge eksik' } }];
    render();
    expect(container.textContent).toContain('Reddedildi');
    expect(container.textContent).toContain('Belge eksik');
    act(() => button('Reddet').click());
    expect(button('Talebi reddet').disabled).toBe(true);
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'Önce ödeme yapılmalı');
    await act(async () => {
      button('Talebi reddet').click();
    });
    expect(reject.mutateAsync).toHaveBeenCalledWith({ requestId: 'r1', reason: 'Önce ödeme yapılmalı' });
  });

  it('talep sinirlari: okunan surumle kaydedilir', async () => {
    save = m();
    items = [];
    render();
    expect(container.textContent).toContain('Bekleyen taksit talebi yok');
    act(() => button('Talep sınırları').click());
    setValue(container.querySelector('input[type="number"]') as HTMLInputElement, '12');
    await act(async () => {
      button('Kaydet').click();
    });
    expect(save.mutateAsync).toHaveBeenCalledWith({ version: 3, enabled: true, maxInstallments: 12, minInstallmentAmount: 50000, includeLateFees: true });
  });
});
