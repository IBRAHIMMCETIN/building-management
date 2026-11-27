// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type Availability, type MyBooking, availabilitySchema, myBookingSchema, portalFacilitiesSchema } from '@/lib/api/reservations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const booking = (over: Partial<MyBooking> = {}): MyBooking =>
  myBookingSchema.parse({
    bookingId: 'b1',
    facilityId: 'f1',
    facilityName: 'Toplantı Salonu',
    unitId: 'u1',
    date: '2026-11-29',
    start: '2026-11-29T07:00:00.000Z',
    end: '2026-11-29T09:00:00.000Z',
    startTime: '10:00',
    endTime: '12:00',
    minutes: 120,
    status: 'confirmed',
    fee: { amount: 15000, status: 'charged' },
    mine: true,
    expired: false,
    past: false,
    canCancel: true,
    cancelDeadline: '2026-11-28T07:00:00.000Z',
    createdAt: '2026-11-27T07:00:00.000Z',
    version: 2,
    ...over,
  });

const facilities = portalFacilitiesSchema.parse({
  today: '2026-11-29',
  units: [{ unitId: 'u1', blockId: 'b1', number: '5', label: 'A Blok · 5' }],
  items: [
    {
      facilityId: 'f1',
      name: 'Toplantı Salonu',
      capacity: 10,
      openingHours: [{ day: 7, open: '09:00', close: '13:00' }],
      slotMinutes: 60,
      maxBookingMinutes: 180,
      advanceDays: 14,
      maxActivePerUnit: 1,
      requiresApproval: false,
      cancelNoticeHours: 24,
      feeKurus: 15000,
      status: 'active',
      version: 1,
      unitIds: ['u1'],
    },
  ],
});
const slot = (start: string, end: string, state: string) => ({ start, end, startAt: `2026-11-29T${start}:00+03:00`, state });
const day: Availability = availabilitySchema.parse({
  facilityId: 'f1',
  date: '2026-11-29',
  open: true,
  window: { open: '09:00', close: '13:00' },
  bookable: true,
  lastBookableDate: '2026-12-13',
  slotMinutes: 60,
  maxBookingMinutes: 180,
  slots: [slot('09:00', '10:00', 'busy'), slot('10:00', '11:00', 'free'), slot('11:00', '12:00', 'free'), slot('12:00', '13:00', 'mine')],
});

const mutation = (resolved: unknown = {}) => ({ isPending: false, isError: false, error: null, reset: vi.fn(), mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(resolved) });
const create = mutation({ booking: booking(), replayed: false });
const cancel = mutation();
let mine = { upcoming: [booking()], history: [booking({ bookingId: 'b0', status: 'rejected', decisionNote: 'Bakım var', canCancel: false, past: true, fee: { amount: 0, status: 'none' } })] };

vi.mock('@/hooks/useReservations', () => ({
  usePortalFacilities: () => ({ isPending: false, isError: false, data: facilities }),
  useAvailability: () => ({ isPending: false, isError: false, data: day, refetch: vi.fn() }),
  useMyBookings: () => ({ isPending: false, isError: false, data: mine }),
  useCreateBooking: () => create,
  useCancelMyBooking: () => cancel,
}));
vi.mock('@/context/PortalUnitContext', () => ({ usePortalUnit: () => ({ unitId: undefined, selectUnit: vi.fn() }) }));

const { MyReservationsPage } = await import('./MyReservationsPage');

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render() {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<MyReservationsPage />));
}
const buttons = () => [...container.querySelectorAll('button')];
const byText = (text: string) => buttons().find((b) => b.textContent?.includes(text));
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};

describe('sakin rezervasyon ekrani', () => {
  it('alan -> bos dilim -> sure -> onay: dolu ve kendi dilimi secilemez, istek dogru gider', async () => {
    await render();
    await click(byText('Toplantı Salonu'));
    const slotButtons = buttons().filter((b) => /^\d{2}:\d{2}/.test(b.textContent ?? ''));
    expect(slotButtons.map((b) => [b.textContent, b.disabled])).toEqual([
      ['09:00Dolu', true],
      ['10:00Boş', false],
      ['11:00Boş', false],
      ['12:00Sizin', true],
    ]);
    // Baska dairenin kim oldugu hicbir yerde yok.
    expect(container.textContent).not.toMatch(/Daire 7|res-/);
    await click(slotButtons[1]);
    const duration = container.querySelector('select') as HTMLSelectElement;
    expect([...duration.options].map((o) => o.textContent)).toEqual(['1 saat (10:00–11:00)', '2 saat (10:00–12:00)']);
    expect(container.textContent).toContain('₺150,00');
    await click(byText('Rezervasyonu onayla'));
    expect(create.mutateAsync).toHaveBeenCalledWith({ idempotencyKey: expect.any(String), facilityId: 'f1', unitId: 'u1', date: '2026-11-29', start: '10:00', minutes: 60 });
    expect(container.textContent).toContain('Rezervasyonunuz onaylandı');
  });

  it('idempotency anahtari: ayni secimin tekrari ayni anahtar; secim degisince yeni anahtar', async () => {
    await render();
    await click(byText('Toplantı Salonu'));
    const slotAt = (t: string) => buttons().find((b) => b.textContent?.startsWith(t));
    await click(slotAt('10:00'));
    create.mutateAsync.mockRejectedValueOnce(new Error('ağ hatası')).mockRejectedValueOnce(new Error('ağ hatası')).mockRejectedValueOnce(new Error('ağ hatası'));
    await click(byText('Rezervasyonu onayla'));
    await click(byText('Rezervasyonu onayla'));
    await click(slotAt('11:00'));
    await click(byText('Rezervasyonu onayla'));
    const keys = create.mutateAsync.mock.calls.map((c) => (c[0] as { idempotencyKey: string; start: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect((create.mutateAsync.mock.calls[2]?.[0] as { start: string }).start).toBe('11:00');
  });

  it('rezervasyonlarim: iptal onayi, ret gerekcesi ve ucret durumu', async () => {
    await render();
    await click(byText('Rezervasyonlarım'));
    expect(container.textContent).toContain('Borcunuza eklendi');
    expect(container.textContent).toContain('Ret gerekçesi: Bakım var');
    await click(byText('İptal et'));
    expect(container.textContent).toContain('Ücret ters kayıtla borcunuzdan düşülür');
    const confirm = buttons().filter((b) => b.textContent === 'İptal et').at(-1);
    await click(confirm);
    expect(cancel.mutate).toHaveBeenCalledWith({ id: 'b1', version: 2 }, expect.anything());
    mine = { upcoming: [], history: [] };
  });
});
