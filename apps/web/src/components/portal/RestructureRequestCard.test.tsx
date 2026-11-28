// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestructureRequestCard } from './RestructureRequestCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = 'recv-u1-occupant';
const mutateAsync = vi.fn().mockResolvedValue({});
const withdraw = vi.fn();
let options: unknown;
let requests: unknown[] = [];
vi.mock('@/hooks/useRestructure', () => ({
  usePlanRequestOptions: () => (options === 'forbidden' ? { isPending: false, isError: true, data: undefined } : { isPending: false, isError: false, data: options }),
  useMyPlanRequests: () => ({ data: requests }),
  useCreatePlanRequest: () => ({ isPending: false, isError: false, error: null, mutateAsync }),
  useWithdrawPlanRequest: () => ({ isPending: false, isError: false, error: null, mutate: withdraw }),
}));

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockClear();
  withdraw.mockClear();
});

function render() {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<RestructureRequestCard />));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

const OPTIONS = {
  unitId: 'u1',
  settings: { enabled: true, maxInstallments: 6, minInstallmentAmount: 50000, includeLateFees: true },
  minInstallments: 2,
  accounts: [{ accountId: MAIN, liableParty: 'occupant', overdue: 300000, accruedLateFee: 1200, total: 301200, maxInstallments: 4, eligible: true }],
};
const request = (over: Record<string, unknown>) => ({
  requestId: 'r1',
  unitId: 'u1',
  accountId: MAIN,
  liableParty: 'occupant',
  installments: 4,
  estimate: { overdue: 300000, accruedLateFee: 1200, total: 301200, installmentAmount: 75300 },
  status: 'pending',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
  ...over,
});

describe('Taksit (yapilandirma) talebi karti', () => {
  it('gecikmis borc, tazminat ve toplam; taksit secenekleri sinirla; talep gonderilir', async () => {
    options = OPTIONS;
    requests = [];
    render();
    expect(container.textContent).toContain('Taksit (yapılandırma) talebi');
    expect(container.textContent).toContain('₺3.000,00');
    expect(container.textContent).toContain('İşleyen tazminat');
    expect(container.textContent).toContain('3.012,00');
    const select = container.querySelector('select[aria-label="Taksit sayısı"]') as HTMLSelectElement;
    // 2..4 taksit; aylik tutar kurus kaybi olmadan (ilk taksit en buyuk).
    expect([...select.options].map((o) => o.value)).toEqual(['2', '3', '4']);
    expect(select.options[1]?.textContent).toContain('1.004,00');
    expect(select.value).toBe('3');
    await act(async () => {
      button('Talep gönder').click();
    });
    expect(mutateAsync).toHaveBeenCalledWith({ idempotencyKey: expect.any(String), liableParty: 'occupant', installments: 3 });
    expect(container.textContent).toContain('Talebiniz yönetime iletildi');
  });

  it('talepler durumlariyla: bekleyen geri cekilebilir, onaylanan karar ozeti, reddedilen gerekce', () => {
    options = { ...OPTIONS, accounts: [{ ...OPTIONS.accounts[0], eligible: false, reason: 'pending_request', pendingRequest: 'mine', pendingRequestId: 'r1' }] };
    requests = [
      request({}),
      request({ requestId: 'r0', status: 'approved', decision: { at: '2026-10-02T09:00:00.000Z', mode: 'changed', reason: 'ok', planId: 'p1', installments: 3, firstDueDate: '2026-11-10', total: 301200 } }),
      request({ requestId: 'rx', status: 'rejected', decision: { at: '2026-09-02T09:00:00.000Z', mode: 'rejected', reason: 'Önce ödeme yapın' } }),
    ];
    render();
    // Bekleyen kendi talebi varken form yok, liste var.
    expect(container.querySelector('select[aria-label="Taksit sayısı"]')).toBeNull();
    expect(container.textContent).toContain('Onay bekliyor');
    expect(container.textContent).toContain('3 taksit, ilk taksit 10 Kas 2026 (yönetim değiştirerek onayladı)');
    expect(container.textContent).toContain('Gerekçe: Önce ödeme yapın');
    act(() => button('Geri çek').click());
    expect(withdraw).toHaveBeenCalledWith('r1');
  });

  it('yonetim talep almiyor (secenekler 403, varsayilan): form yok; gecmis talepler varsa yalnizca liste', () => {
    options = 'forbidden';
    requests = [];
    render();
    expect(container.textContent).toBe('');
    container.remove();
    requests = [request({ requestId: 'rx', status: 'rejected', decision: { at: '2026-09-02T09:00:00.000Z', mode: 'rejected', reason: 'Talepler kapandı' } })];
    render();
    expect(container.querySelector('select[aria-label="Taksit sayısı"]')).toBeNull();
    expect(container.textContent).toContain('Gerekçe: Talepler kapandı');
  });

  it('ayni cariyi goren baska uyenin talebi: yalnizca bilgi (KVKK); talep edilecek bir sey yoksa kart gizli', () => {
    options = { ...OPTIONS, accounts: [{ ...OPTIONS.accounts[0], eligible: false, reason: 'pending_request', pendingRequest: 'other' }] };
    requests = [];
    render();
    expect(container.textContent).toContain('yönetimin değerlendirdiği bir talep var');
    container.remove();
    options = { ...OPTIONS, accounts: [{ ...OPTIONS.accounts[0], eligible: false, reason: 'no_overdue', overdue: 0 }] };
    render();
    expect(container.textContent).toBe('');
  });
});
