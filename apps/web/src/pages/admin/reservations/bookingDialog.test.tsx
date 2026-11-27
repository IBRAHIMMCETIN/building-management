// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type Booking, bookingSchema } from '@/lib/api/reservations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom <dialog> showModal destegi sinirli: acik kabul et.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const mutation = () => ({ isPending: false, isError: false, error: null, reset: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}) });
const actions = { approve: mutation(), reject: mutation(), cancel: mutation(), resolveFee: mutation() };
vi.mock('@/hooks/useReservations', () => ({ useBookingActions: () => actions }));

const { BookingDialog } = await import('./BookingDialog');

const booking = (over: Partial<Booking> = {}): Booking =>
  bookingSchema.parse({
    bookingId: 'b1',
    facilityId: 'f1',
    facilityName: 'Havuz',
    unitId: 'u1',
    date: '2026-11-29',
    start: '2026-11-29T07:00:00.000Z',
    end: '2026-11-29T08:00:00.000Z',
    startTime: '10:00',
    endTime: '11:00',
    minutes: 60,
    status: 'pending',
    fee: { amount: 20000, status: 'pending' },
    createdBy: 'res-a',
    createdByRole: 'resident',
    expired: false,
    past: false,
    canApprove: true,
    canCancel: true,
    canRetryReversal: false,
    createdAt: '2026-11-27T07:00:00.000Z',
    version: 1,
    ...over,
  });

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render(b: Booking, canWrite = true) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<BookingDialog booking={b} unitLabel={() => 'Daire 5'} canWrite={canWrite} onClose={vi.fn()} />));
}
const byText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};
const type = async (el: Element | null, value: string) => {
  const input = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('rezervasyon ayrintisi (yonetim)', () => {
  it('onay ucretli tutari gosterir; ret gerekcesiz gonderilemez', async () => {
    await render(booking());
    expect(container.textContent).toContain('Daire 5');
    await click(byText('Onayla'));
    await click(byText('Onayla ve ₺200,00 tahakkuk et'));
    expect(actions.approve.mutateAsync).toHaveBeenCalledWith({ id: 'b1', version: 1 });
  });

  it('ret: en az 3 karakter gerekce; gerekce API ye gider', async () => {
    await render(booking());
    await click(byText('Reddet'));
    const submit = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Reddet').at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await type(container.querySelector('textarea'), 'Havuz bakımda');
    await click(submit);
    expect(actions.reject.mutateAsync).toHaveBeenCalledWith({ id: 'b1', version: 1, reason: 'Havuz bakımda' });
  });

  it('denetci islem dugmesi gormez; yarim iade yeniden denenebilir', async () => {
    await render(booking({ status: 'cancelled', canApprove: false, canCancel: false }), false);
    expect(byText('Onayla')).toBeUndefined();
    expect(byText('İptal et')).toBeUndefined();
    container.remove();
    await render(booking({ status: 'cancelled', canApprove: false, canCancel: false, canRetryReversal: true, cancelReason: 'Arıza', fee: { amount: 20000, status: 'reversal_pending', error: 'Ücret iadesi (ters kayıt) yapılamadı' } }));
    expect(container.textContent).toContain('Ücret iadesi (ters kayıt) yapılamadı');
    await click(byText('Ücret iadesini yeniden dene'));
    expect(actions.cancel.mutateAsync).toHaveBeenCalledWith({ id: 'b1', version: 1, reason: 'Arıza' });
  });

  it('iade yine yapilamazsa uyari gosterilir; Finans engelinde gerekceli elle cozum', async () => {
    const stuck = booking({ status: 'cancelled', canApprove: false, canCancel: false, canRetryReversal: true, cancelReason: 'Arıza', fee: { amount: 20000, status: 'reversal_pending', error: 'Plan bağlı' } });
    actions.cancel.mutateAsync.mockResolvedValueOnce({ booking: stuck, warning: 'Rezervasyon iptal edildi; ücret iadesi (ters kayıt) yapılamadı ve yönetimin iade kuyruğuna alındı.' });
    await render(stuck);
    await click(byText('Ücret iadesini yeniden dene'));
    expect(container.textContent).toContain('iade kuyruğuna alındı');
    expect(byText('Elle çözüldü olarak işaretle')).toBeUndefined();
    container.remove();
    await render(stuck);
    await click(byText('Elle çözüldü olarak işaretle'));
    const submit = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Elle çözüldü olarak işaretle').at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await type(container.querySelector('textarea'), 'Plan iptal edildi, elle mahsup');
    await click(submit);
    expect(actions.resolveFee.mutateAsync).toHaveBeenCalledWith({ id: 'b1', version: 1, reason: 'Plan iptal edildi, elle mahsup' });
  });
});
