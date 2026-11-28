import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { renderApp } from '@/test/renderApp';
import { facilities, facility, myBooking } from './reservationFixtures';
import { ReservationsScreen } from './ReservationsScreen';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => jest.clearAllMocks());

describe('Rezervasyon', () => {
  it('ortak alanlar: ucret / onay rozetleri ve acilis saatleri; dokununca tarih-saat secimi', async () => {
    await renderApp(<ReservationsScreen />, {
      routes: { 'GET /api/portal/reservations/facilities': facilities([facility('f1', { name: 'Toplantı salonu', requiresApproval: true }), facility('f2', { name: 'Tenis kortu', feeKurus: 15000 })]) },
    });
    const salon = await screen.findByRole('button', { name: 'Toplantı salonu, Ücretsiz, yönetici onaylı, Pzt–Paz 09:00–13:00' });
    expect(within(salon).getByText('Yönetici onaylı')).toBeTruthy();
    expect(screen.getByText('₺150,00')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /^Tenis kortu,/ }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/resident/reservations/[facilityId]', params: { facilityId: 'f2' } });
  });

  it('daire uyeligi yoksa veya alan yoksa bos durum', async () => {
    await renderApp(<ReservationsScreen />, { routes: { 'GET /api/portal/reservations/facilities': facilities([], { units: [] }) } });
    expect(await screen.findByText('Rezervasyon için bir daireye üye olmanız gerekir')).toBeTruthy();
  });

  it('rezervasyonlarim: yaklasan + gecmis; iptal ikinci dokunusla, uyari gosterilir', async () => {
    const { calls } = await renderApp(<ReservationsScreen tab="mine" />, {
      routes: {
        'GET /api/portal/reservations/bookings': {
          upcoming: [myBooking('b1', { fee: { amount: 15000, status: 'charged' } })],
          history: [myBooking('b0', { date: '2026-11-10', status: 'rejected', canCancel: false, past: true, decisionNote: 'Bakım var' })],
        },
        'POST /api/portal/reservations/bookings/b1/cancel': { booking: myBooking('b1', { status: 'cancelled', canCancel: false }), warning: 'İade ters kaydı yönetimce tamamlanacak.' },
      },
    });
    expect(await screen.findByText('2 Aralık Çarşamba · 10:00–12:00', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('₺150,00 · Borcunuza eklendi')).toBeTruthy();
    expect(screen.getByText('Ret gerekçesi: Bakım var')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Geçmiş ve iptal edilenler' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Toplantı salonu rezervasyonunu iptal et' }));
    expect(screen.getByText('Rezervasyon iptal edilsin mi? Ücret ters kayıtla borcunuzdan düşülür.')).toBeTruthy();
    const [confirm] = screen.getAllByRole('button', { name: 'Toplantı salonu rezervasyonunu iptal et' });
    await fireEvent.press(confirm!);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/cancel'))?.body).toEqual({ version: 2 }));
    expect(await screen.findByText('İade ters kaydı yönetimce tamamlanacak.')).toBeTruthy();
  });

  it('iptal reddi (iptal suresi) Turkce mesajla', async () => {
    await renderApp(<ReservationsScreen tab="mine" />, {
      routes: {
        'GET /api/portal/reservations/bookings': { upcoming: [myBooking('b1')], history: [] },
        'POST /api/portal/reservations/bookings/b1/cancel': { status: 422, body: { error: 'cancel_window', message: 'İptal süresi geçti.' } },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Toplantı salonu rezervasyonunu iptal et' }));
    await fireEvent.press(screen.getByText('İptal et', { exact: true }));
    expect(await screen.findByText('İptal süresi geçti.')).toBeTruthy();
  });

  it('yeni rezervasyondan donus: sonuc karti (onay bekliyor)', async () => {
    await renderApp(<ReservationsScreen tab="mine" doneId="b1" />, {
      routes: { 'GET /api/portal/reservations/bookings': { upcoming: [myBooking('b1', { status: 'pending' })], history: [] } },
    });
    expect(await screen.findByRole('header', { name: 'Talebiniz alındı, yönetici onayı bekleniyor' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Yeni rezervasyon' }));
    expect(screen.queryByText('Talebiniz alındı, yönetici onayı bekleniyor')).toBeNull();
  });
});
