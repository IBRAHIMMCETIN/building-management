import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { announcements, quote, summary, ticket } from '@/test/fixtures';
import { renderApp } from '@/test/renderApp';
import { HomeScreen } from './HomeScreen';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

const routes = (over: Record<string, unknown> = {}) => ({
  'GET /api/portal/my-summary': summary(),
  'GET /api/portal/tickets': { items: [ticket('1', 'resolved', ['confirm']), ticket('2', 'assigned')], total: 2 },
  'GET /api/portal/announcements': announcements(4),
  'GET /api/portal/payments/quote': quote(true),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('Ana Sayfa', () => {
  it('borc karti: tutar, durum, gecikme uyarisi, siradaki ve son odeme', async () => {
    await renderApp(<HomeScreen />, { routes: routes() });
    expect(await screen.findByText('₺3.000,00')).toBeTruthy();
    expect(screen.getByText('Gecikmede')).toBeTruthy();
    expect(screen.getByText('A Blok · Daire 3 · Malik')).toBeTruthy();
    expect(screen.getByText(/₺1\.500,00 tutarın son ödeme tarihi 49 gün önce geçti\. Bugüne kadar işleyen gecikme tazminatı ₺73,50/)).toBeTruthy();
    expect(screen.getByText(/Sıradaki: Aralık aidatı · son ödeme 10 Ara 2026/)).toBeTruthy();
    expect(screen.getByText('Son ödeme: 7 Eyl 2026 · ₺1.500,00 (MKB-2026-0138)')).toBeTruthy();
  });

  it('talep ozeti ve son 3 duyuru', async () => {
    await renderApp(<HomeScreen />, { routes: routes() });
    expect(await screen.findByText(/2 açık talep/)).toBeTruthy();
    expect(screen.getByText(/1 talep onayınızı bekliyor/)).toBeTruthy();
    expect(await screen.findByText('Duyuru 1')).toBeTruthy();
    expect(screen.getByText('Duyuru 3')).toBeTruthy();
    expect(screen.queryByText('Duyuru 4')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /^Duyuru 2,/ }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/resident/announcements/[id]', params: { id: 'an-2' } });
  });

  it('online odeme acikken "Online öde" web odeme sayfasini uygulama ici tarayicida acar; kapaninca borc yenilenir', async () => {
    const { calls } = await renderApp(<HomeScreen />, { routes: routes() });
    await fireEvent.press(await screen.findByRole('link', { name: 'Online öde' }));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://web.test/app/odeme', expect.anything());
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/portal/my-summary').length).toBe(2));
  });

  it('online odeme kapaliysa elden / havale notu', async () => {
    await renderApp(<HomeScreen />, { routes: routes({ 'GET /api/portal/payments/quote': quote(false) }) });
    expect(await screen.findByText('Ödemelerinizi apartman yöneticinize elden veya banka havalesiyle yapabilirsiniz.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Online öde' })).toBeNull();
  });

  it('borcu olmayan sakin', async () => {
    await renderApp(<HomeScreen />, {
      routes: routes({ 'GET /api/portal/my-summary': summary({ status: 'no_debt', debt: 0, balance: -50000, advance: 50000, overdueAmount: 0, accruedLateFee: 0, daysOverdue: 0, oldestOverdueDueDate: undefined }) }),
    });
    expect(await screen.findByText('Borcunuz bulunmamaktadır')).toBeTruthy();
    expect(screen.getByText('₺500,00 avansınız var; sonraki aidatlarınızdan düşülecek.')).toBeTruthy();
  });

  it('birden fazla daire: secici gosterilir, secilen daire unitId ile istenir', async () => {
    const { calls } = await renderApp(<HomeScreen />, {
      routes: routes({
        'GET /api/portal/my-summary': ({ query }: { query: Record<string, string> }) =>
          query.unitId
            ? summary({ unitId: query.unitId, unitLabel: 'B Blok · Daire 9' })
            : { status: 400, body: { error: 'unit_selection_required', message: 'Daire seçin', units: [{ unitId: 'u-3', label: 'A Blok · Daire 3', relationLabel: 'Malik' }, { unitId: 'u-9', label: 'B Blok · Daire 9', relationLabel: 'Kiracı' }] } },
      }),
    });
    expect(await screen.findByText('Daire seçin')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'B Blok · Daire 9, Kiracı' }));
    expect(await screen.findByText('B Blok · Daire 9 · Malik')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/portal/my-summary' && c.query.unitId === 'u-9')).toBe(true);
  });

  it('daireye atanmamis sakin: bilgilendirici bos durum', async () => {
    await renderApp(<HomeScreen />, { routes: routes({ 'GET /api/portal/my-summary': { status: 403, body: { error: 'forbidden', message: 'Aktif üyelik yok' } } }) });
    expect(await screen.findByText('Henüz bir daireye atanmadınız')).toBeTruthy();
  });

  it('sunucu hatasi: Turkce mesaj ve tekrar dene', async () => {
    let fail = true;
    await renderApp(<HomeScreen />, {
      routes: routes({ 'GET /api/portal/my-summary': () => (fail ? { status: 500, body: { error: 'internal' } } : summary()) }),
    });
    expect(await screen.findByText('Sunucuda beklenmeyen bir hata oluştu.')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(screen.getByText('₺3.000,00')).toBeTruthy());
  });
});
