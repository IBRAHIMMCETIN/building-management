import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { quote, statement, summary } from '@/test/fixtures';
import { renderApp } from '@/test/renderApp';
import { DuesScreen, PAGE_SIZE } from './DuesScreen';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

const routes = (rows: number) => ({
  'GET /api/portal/my-summary': summary(),
  'GET /api/portal/my-statement': statement(rows),
  'GET /api/portal/payments/quote': quote(true),
  'GET /api/documents/my-receipts/pay-23': { url: 'https://s3.test/makbuz.pdf?sig=1', fileName: 'makbuz.pdf', contentType: 'application/pdf', expiresAt: '2026-11-28T09:05:00.000Z' },
});

describe('Borçlarım', () => {
  it('ozet: bakiye, gecikme, toplamlar, siradaki son odeme, online ode', async () => {
    await renderApp(<DuesScreen />, { routes: routes(3) });
    expect(await screen.findByText('₺3.000,00')).toBeTruthy();
    expect(screen.getByText('₺1.500,00 gecikmede (en eski vade 10 Eki 2026, 49 gün).')).toBeTruthy();
    expect(screen.getByLabelText('Toplam tahakkuk: ₺21.000,00')).toBeTruthy();
    expect(screen.getByLabelText('Toplam ödenen: ₺18.000,00')).toBeTruthy();
    expect(screen.getByLabelText('Sıradaki son ödeme: 10 Ara 2026')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Online öde' })).toBeTruthy();
  });

  it('hareketler en yeni once; 20 satirlik sayfalar ("Daha fazla göster")', async () => {
    await renderApp(<DuesScreen />, { routes: routes(25) });
    expect(await screen.findByText('25 hareket, en yeni önce')).toBeTruthy();
    // En yeni (tx-024) once; 20 satir sonra liste kesilir.
    expect(screen.getByText('Aidat 24')).toBeTruthy();
    expect(screen.getByText(`Ödeme ${25 - PAGE_SIZE}`)).toBeTruthy();
    expect(screen.queryByText('Aidat 4')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Daha fazla göster (5 kaldı)' }));
    // Kalan 5 satir listeye eklendi (FlatList pencereleme yaptigi icin satir yerine dugme kontrol edilir).
    await waitFor(() => expect(screen.queryByRole('button', { name: /Daha fazla göster/ })).toBeNull());
  });

  it('makbuz: imzali link istenir ve sistem goruntuleyicisinde acilir', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { calls } = await renderApp(<DuesScreen />, { routes: routes(25) });
    await fireEvent.press(await screen.findByRole('button', { name: 'MKB-23 numaralı makbuzu aç' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://s3.test/makbuz.pdf?sig=1'));
    expect(calls.some((c) => c.path === '/api/documents/my-receipts/pay-23')).toBe(true);
  });

  it('makbuz alinamazsa Turkce hata gosterilir', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await renderApp(<DuesScreen />, { routes: routes(25) });
    await fireEvent.press(await screen.findByRole('button', { name: 'MKB-21 numaralı makbuzu aç' }));
    expect(await screen.findByText('Kayıt bulunamadı.')).toBeTruthy();
  });

  it('asagi cekince ozet ve hareketler yeniden istenir', async () => {
    const { calls, container } = await renderApp(<DuesScreen />, { routes: routes(3) });
    await screen.findByText('3 hareket, en yeni önce');
    const before = calls.filter((c) => c.path === '/api/portal/my-statement').length;
    // Asagi cekme hareketi: listenin RefreshControl'unun onRefresh'i (yerel kaydirma gorunumunun ozelligi).
    const [list] = container.queryAll((n) => n.type === 'RCTScrollView' && !!(n.props as { refreshControl?: unknown }).refreshControl);
    const control = (list?.props as { refreshControl: { props: { onRefresh: () => void } } }).refreshControl;
    await act(async () => {
      control.props.onRefresh();
    });
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/portal/my-statement').length).toBe(before + 1));
    expect(calls.filter((c) => c.path === '/api/portal/my-summary').length).toBeGreaterThanOrEqual(2);
  });

  it('hareket yoksa bos durum', async () => {
    await renderApp(<DuesScreen />, { routes: routes(0) });
    expect(await screen.findByText('Henüz hesap hareketi yok')).toBeTruthy();
  });
});
