import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderApp } from '@/test/renderApp';
import { portalTicket, ticketEvents } from './ticketFixtures';
import { TicketDetailScreen } from './TicketDetailScreen';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///picked.heic', width: 4032, height: 3024 }] })),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false })),
}));
jest.mock('expo-image-manipulator', () => {
  const ctx: { resize: jest.Mock; renderAsync: jest.Mock } = { resize: jest.fn(() => ctx), renderAsync: jest.fn(async () => ({ saveAsync: jest.fn(async () => ({ uri: 'file:///small.jpg', width: 1920, height: 1440 })) })) };
  return { ImageManipulator: { manipulate: jest.fn(() => ctx) }, SaveFormat: { JPEG: 'jpeg' } };
});

const realFetch = global.fetch;
const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => (url.startsWith('file:') ? { blob: async () => ({ size: 345_678 }) } : { ok: true, status: 200 }));
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

const detail = (status: string, actions: string[], over: Record<string, unknown> = {}) => ({ ticket: portalTicket('7', status, { actions, ...over }), events: ticketEvents });

describe('Talep ayrintisi', () => {
  it('bilgiler ve zaman cizelgesi; cozulen talep puan + notla onaylanir', async () => {
    const { calls } = await renderApp(<TicketDetailScreen id="7" />, {
      routes: {
        'GET /api/portal/tickets/7': detail('resolved', ['confirm', 'reopen']),
        'POST /api/portal/tickets/7/confirm': { ticket: portalTicket('7', 'closed', { version: 4 }) },
      },
    });
    expect(await screen.findByRole('header', { name: 'Talep 7' })).toBeTruthy();
    expect(screen.getByText('Daire içi · Görevli atandı')).toBeTruthy();
    expect(screen.getByText('İşlemde → Çözüldü')).toBeTruthy();
    expect(screen.getByText('Conta değiştirildi.')).toBeTruthy();
    expect(screen.getByText(/^Bina Görevlisi · /)).toBeTruthy();

    await fireEvent.press(screen.getByRole('radio', { name: '4 - İyi' }));
    expect(screen.getByRole('radio', { name: '4 - İyi', checked: true })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Not (isteğe bağlı)'), ' Teşekkürler ');
    await fireEvent.press(screen.getByRole('button', { name: 'Onayla ve kapat' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/portal/tickets/7/confirm')?.body).toEqual({ version: 3, rating: 4, note: 'Teşekkürler' }));
  });

  it('"Hâlâ sorun var": gerekce zorunlu (3+), sonra yeniden acilir', async () => {
    const { calls } = await renderApp(<TicketDetailScreen id="7" />, {
      routes: { 'GET /api/portal/tickets/7': detail('resolved', ['confirm', 'reopen']), 'POST /api/portal/tickets/7/reopen': { ticket: portalTicket('7', 'assigned', { version: 4 }) } },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Hâlâ sorun var' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Yeniden aç' }));
    expect(await screen.findByText('Sorunun neden devam ettiğini yazın (en az 3 karakter).')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/reopen'))).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Sorun neden devam ediyor?'), 'Hâlâ damlıyor');
    await fireEvent.press(screen.getByRole('button', { name: 'Yeniden aç' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/reopen'))?.body).toEqual({ version: 3, note: 'Hâlâ damlıyor' }));
  });

  it('cakisma (409) API mesajiyla gosterilir', async () => {
    await renderApp(<TicketDetailScreen id="7" />, {
      routes: {
        'GET /api/portal/tickets/7': detail('resolved', ['confirm']),
        'POST /api/portal/tickets/7/confirm': { status: 409, body: { error: 'conflict', message: 'Talep başka bir işlemle güncellendi.' } },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Onayla ve kapat' }));
    expect(await screen.findByText('Talep başka bir işlemle güncellendi.')).toBeTruthy();
  });

  it('atanmamis talep iki adimda geri cekilir', async () => {
    const { calls } = await renderApp(<TicketDetailScreen id="7" />, {
      routes: { 'GET /api/portal/tickets/7': detail('open', ['cancel']), 'POST /api/portal/tickets/7/cancel': { ticket: portalTicket('7', 'cancelled', { version: 4 }) } },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Talebi geri çek' }));
    expect(screen.getByText('Talebi geri çekmek istediğinize emin misiniz?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Evet, geri çek' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/cancel'))?.body).toEqual({ version: 3 }));
  });

  it('mesaj + galeriden fotograf: kucultulen JPEG imzali linke yuklenir, olaya uploadId verilir', async () => {
    const { calls } = await renderApp(<TicketDetailScreen id="7" />, {
      routes: {
        'GET /api/portal/tickets/7': detail('in_progress', []),
        'POST /api/portal/tickets/photos/upload-url': { uploadId: 'up1_jpg', uploadUrl: 'https://s3.test/put?sig=1', headers: { 'Content-Type': 'image/jpeg' } },
        'POST /api/portal/tickets/7/comments': { status: 201, body: { event: { eventId: 'e9', kind: 'comment', visibility: 'public', at: '2026-11-28T09:00:00.000Z', mine: true } } },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('Mesajınızı yazın.')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Mesaj'), 'Fotoğraf ekledim');
    await fireEvent.press(screen.getByRole('button', { name: 'Galeriden seç' }));
    expect(await screen.findByLabelText('Eklenen fotoğraf 1')).toBeTruthy();
    expect(screen.getByText('(1/6)')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/comments'))?.body).toEqual({ body: 'Fotoğraf ekledim', photos: ['up1_jpg'] }));
    expect(calls.find((c) => c.path.endsWith('/upload-url'))?.body).toEqual({ contentType: 'image/jpeg', size: 345_678 });
    const put = fetchMock.mock.calls.find(([url]) => url === 'https://s3.test/put?sig=1');
    expect(put?.[1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    const manipulator = jest.requireMock('expo-image-manipulator') as { ImageManipulator: { manipulate: jest.Mock } };
    expect(manipulator.ImageManipulator.manipulate).toHaveBeenCalledWith('file:///picked.heic');
  });

  it('kamera izni yoksa aciklama gosterilir; yukleme hatasi mesaji', async () => {
    const { calls } = await renderApp(<TicketDetailScreen id="7" />, {
      routes: {
        'GET /api/portal/tickets/7': detail('in_progress', []),
        'POST /api/portal/tickets/photos/upload-url': { uploadId: 'up1_jpg', uploadUrl: 'https://s3.test/put?sig=1', headers: {} },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Fotoğraf çek' }));
    expect(await screen.findByText('Kamera izni verilmedi. Ayarlar’dan izin verebilir veya galeriden seçebilirsiniz.')).toBeTruthy();

    fetchMock.mockImplementation(async (url: string) => (url.startsWith('file:') ? { blob: async () => ({ size: 1000 }) } : { ok: false, status: 403 }));
    await fireEvent.press(screen.getByRole('button', { name: 'Galeriden seç' }));
    await screen.findByLabelText('Eklenen fotoğraf 1');
    await fireEvent.changeText(screen.getByLabelText('Mesaj'), 'Bakar mısınız');
    await fireEvent.press(screen.getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('Fotoğraf yüklenemedi (403).')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/comments'))).toBe(false);
  });

  it('zaman cizelgesindeki fotograf imzali linkle acilir', async () => {
    const { calls } = await renderApp(<TicketDetailScreen id="7" />, {
      routes: {
        'GET /api/portal/tickets/7': detail('closed', []),
        'GET /api/portal/tickets/7/photos/abc_jpg': { url: 'https://s3.test/abc.jpg?sig=1', fileName: 'abc.jpg', contentType: 'image/jpeg', expiresAt: '2026-11-28T09:05:00.000Z' },
      },
    });
    await act(async () => {
      await fireEvent.press(await screen.findByRole('button', { name: 'Fotoğraf 1' }));
    });
    await waitFor(() => expect(calls.some((c) => c.path === '/api/portal/tickets/7/photos/abc_jpg')).toBe(true));
    // Kapali talepte mesaj formu yoktur.
    expect(screen.queryByRole('button', { name: 'Gönder' })).toBeNull();
  });

  it('fotograf penceresi kapatildiktan sonra gelen imzali link pencereyi yeniden acmaz', async () => {
    let release: (v: unknown) => void = () => undefined;
    await renderApp(<TicketDetailScreen id="7" />, {
      routes: {
        'GET /api/portal/tickets/7': detail('closed', []),
        'GET /api/portal/tickets/7/photos/abc_jpg': () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Fotoğraf 1' }));
    expect(await screen.findByRole('header', { name: 'Fotoğraf 1' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Kapat' }));
    expect(screen.queryByRole('header', { name: 'Fotoğraf 1' })).toBeNull();
    await act(async () => release({ url: 'https://s3.test/abc.jpg?sig=1', fileName: 'abc.jpg', contentType: 'image/jpeg', expiresAt: '2026-11-28T09:05:00.000Z' }));
    expect(screen.queryByRole('header', { name: 'Fotoğraf 1' })).toBeNull();
  });

  it('bulunamayan talep', async () => {
    await renderApp(<TicketDetailScreen id="yok" />, { routes: {} });
    expect(await screen.findByText('Talep bulunamadı')).toBeTruthy();
  });
});
