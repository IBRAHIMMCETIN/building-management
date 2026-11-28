/** Rezervasyon ekrani testleri icin API yanit ornekleri (sozlesme @bm/shared/api/reservations ile ayni). */

const everyDay = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, open: '09:00', close: '13:00' }));

export const facility = (id: string, over: Record<string, unknown> = {}) => ({
  facilityId: id,
  name: `Alan ${id}`,
  description: 'Açıklama',
  capacity: 10,
  openingHours: everyDay,
  slotMinutes: 60,
  maxBookingMinutes: 120,
  advanceDays: 14,
  maxActivePerUnit: 2,
  requiresApproval: false,
  cancelNoticeHours: 6,
  feeKurus: 0,
  status: 'active',
  version: 1,
  unitIds: ['u-3'],
  ...over,
});

export const facilities = (items: unknown[], over: Record<string, unknown> = {}) => ({
  units: [{ unitId: 'u-3', blockId: 'b1', number: '3', label: 'A Blok · Daire 3' }],
  today: '2026-11-28',
  items,
  ...over,
});

export const availability = (date: string, states: string[] = ['past', 'free', 'free', 'busy'], over: Record<string, unknown> = {}) => ({
  facilityId: 'f1',
  date,
  open: true,
  window: { open: '09:00', close: '13:00' },
  bookable: true,
  lastBookableDate: '2026-12-12',
  slotMinutes: 60,
  maxBookingMinutes: 120,
  slots: states.map((state, i) => ({ start: `${String(9 + i).padStart(2, '0')}:00`, end: `${String(10 + i).padStart(2, '0')}:00`, startAt: `${date}T0${6 + i}:00:00.000Z`, state })),
  ...over,
});

export const myBooking = (id: string, over: Record<string, unknown> = {}) => ({
  bookingId: id,
  facilityId: 'f1',
  facilityName: 'Toplantı salonu',
  unitId: 'u-3',
  date: '2026-12-02',
  start: '2026-12-02T07:00:00.000Z',
  end: '2026-12-02T09:00:00.000Z',
  startTime: '10:00',
  endTime: '12:00',
  minutes: 120,
  status: 'confirmed',
  expired: false,
  past: false,
  canCancel: true,
  createdAt: '2026-11-27T09:00:00.000Z',
  version: 2,
  fee: { amount: 0, status: 'none' },
  mine: true,
  cancelDeadline: '2026-12-01T07:00:00.000Z',
  ...over,
});
