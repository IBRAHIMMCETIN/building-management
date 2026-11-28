import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderApp } from '@/test/renderApp';
import { FacilityBookingScreen } from './FacilityBookingScreen';
import { availability, facilities, facility, myBooking } from './reservationFixtures';

const mockRouter = { push: jest.fn(), dismissTo: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => jest.clearAllMocks());

const routes = (over: Record<string, unknown> = {}) => ({
  'GET /api/portal/reservations/facilities': facilities([facility('f1', { name: 'Toplantı salonu', capacity: 10, feeKurus: 15000, requiresApproval: true, cancelNoticeHours: 24 })]),
  'GET /api/portal/reservations/facilities/f1/availability': ({ query }: { query: Record<string, string> }) => availability(query.date ?? ''),
  ...over,
});

describe('Rezervasyon: tarih ve saat', () => {
  it('bos dilim -> sure -> kisi sayisi denetimi -> talep; Rezervasyonlarim\'a sonucla donulur', async () => {
    const { calls } = await renderApp(<FacilityBookingScreen facilityId="f1" />, {
      routes: routes({ 'POST /api/portal/reservations/bookings': { status: 201, body: { booking: myBooking('b9', { status: 'pending' }), replayed: false } } }),
    });
    expect(await screen.findByRole('header', { name: 'Toplantı salonu' })).toBeTruthy();
    expect(screen.getByText('En geç 12 Ara 2026 için rezervasyon yapılabilir.')).toBeTruthy();
    expect(await screen.findByRole('header', { name: '28 Kasım Cumartesi' })).toBeTruthy();
    // Gecmis ve dolu dilimler secilemez.
    expect(screen.getByRole('button', { name: '09:00, Geçti' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole('button', { name: '12:00, Dolu' }).props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.press(screen.getByRole('button', { name: '10:00, Boş' }));
    // 10:00'dan bitisik bos dilimler: 1 saat ve 2 saat (12:00 dolu).
    expect(screen.getByRole('button', { name: '1 saat (10:00–11:00)', selected: true })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '2 saat (10:00–12:00)' }));
    expect(screen.getByText('Ücret: ₺150,00 — onaylanınca dairenizin borcuna eklenir. Rezervasyon yönetici onayından sonra kesinleşir. Başlangıçtan en geç 24 saat önce iptal edebilirsiniz.')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Kişi sayısı (isteğe bağlı)'), '25');
    await fireEvent.press(screen.getByRole('button', { name: 'Rezervasyon talebi gönder' }));
    expect(await screen.findByText('1–10 arasında olmalı')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await fireEvent.changeText(screen.getByLabelText('Kişi sayısı (isteğe bağlı)'), '8');
    await fireEvent.changeText(screen.getByLabelText('Not (isteğe bağlı)'), 'Doğum günü');
    await fireEvent.press(screen.getByRole('button', { name: 'Rezervasyon talebi gönder' }));
    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith({ pathname: '/resident/reservations', params: { tab: 'mine', done: 'b9' } }),
    );
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ facilityId: 'f1', unitId: 'u-3', date: '2026-11-28', start: '10:00', minutes: 120, partySize: 8, note: 'Doğum günü' });
    expect(typeof body.idempotencyKey).toBe('string');
  });

  it('dilim dolmussa API mesaji gosterilir ve musaitlik yenilenir', async () => {
    const { calls } = await renderApp(<FacilityBookingScreen facilityId="f1" />, {
      routes: routes({ 'POST /api/portal/reservations/bookings': { status: 409, body: { error: 'slot_taken', message: 'Seçilen saat artık müsait değil.' } } }),
    });
    await fireEvent.press(await screen.findByRole('button', { name: '11:00, Boş' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Rezervasyon talebi gönder' }));
    expect(await screen.findByText('Seçilen saat artık müsait değil.')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/availability')).length).toBeGreaterThanOrEqual(2));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('takvimden baska gun secilir; kapali gun aciklamasi', async () => {
    const { calls } = await renderApp(<FacilityBookingScreen facilityId="f1" />, {
      routes: routes({
        'GET /api/portal/reservations/facilities/f1/availability': ({ query }: { query: Record<string, string> }) =>
          query.date === '2026-11-30' ? availability('2026-11-30', [], { open: false, window: undefined }) : availability(query.date ?? ''),
      }),
    });
    await fireEvent.press(await screen.findByRole('button', { name: /^Tarih: 28 Kasım 2026 Cumartesi/ }));
    // Bugunden onceki gunler secilemez.
    expect(screen.getByRole('button', { name: '27 Kasım 2026 Cuma' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole('button', { name: '30 Kasım 2026 Pazartesi' }));
    expect(await screen.findByText('Ortak alan bu gün kapalı.')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/availability') && c.query.date === '2026-11-30')).toBe(true);
  });

  it('bilinmeyen alan', async () => {
    await renderApp(<FacilityBookingScreen facilityId="yok" />, { routes: routes() });
    expect(await screen.findByText('Ortak alan bulunamadı')).toBeTruthy();
  });
});
