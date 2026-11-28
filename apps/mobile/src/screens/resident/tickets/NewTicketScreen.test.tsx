import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderApp } from '@/test/renderApp';
import { NewTicketScreen } from './NewTicketScreen';
import { portalTicket, ticketSummary } from './ticketFixtures';

const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///a.jpg', width: 800, height: 600 }] })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));
jest.mock('expo-image-manipulator', () => {
  const ctx: { resize: jest.Mock; renderAsync: jest.Mock } = { resize: jest.fn(() => ctx), renderAsync: jest.fn(async () => ({ saveAsync: jest.fn(async () => ({ uri: 'file:///a-small.jpg', width: 800, height: 600 })) })) };
  return { ImageManipulator: { manipulate: jest.fn(() => ctx) }, SaveFormat: { JPEG: 'jpeg' } };
});

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async (url: string) => (url.startsWith('file:') ? { blob: async () => ({ size: 2048 }) } : { ok: true, status: 200 })) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

const created = { status: 201, body: { ticket: portalTicket('99', 'open', { actions: ['cancel'] }), replayed: false } };

describe('Yeni talep', () => {
  it('daire ici: konum -> kategori -> aciklama + fotograf; gonderilince ayrintiya gecer', async () => {
    const { calls } = await renderApp(<NewTicketScreen />, {
      routes: {
        'GET /api/portal/my-summary': ticketSummary,
        'POST /api/portal/tickets/photos/upload-url': { uploadId: 'u1_jpg', uploadUrl: 'https://s3.test/u1', headers: {} },
        'POST /api/portal/tickets': created,
      },
    });
    expect(screen.getByLabelText('Adım 1 / 3: Konum')).toBeTruthy();
    // Secim yapmadan devam: aciklayici hata.
    await fireEvent.press(await screen.findByRole('button', { name: 'Devam' }));
    expect(screen.getByText('Arızanın yerini seçin.')).toBeTruthy();
    await fireEvent.press(await screen.findByRole('button', { name: /^Daire içi · A Blok · Daire 3,/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));

    // Daire icinde kisitli kategori listesi (asansor yok, "Guvenlik / diyafon").
    expect(screen.getByLabelText('Adım 2 / 3: Kategori')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Asansör' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Güvenlik / diyafon' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));
    expect(screen.getByText('Bir kategori seçin.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Su / tesisat' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));

    // Bos form: alan hatalari, istek yok.
    await fireEvent.press(screen.getByRole('button', { name: 'Talebi gönder' }));
    expect(await screen.findByText('Başlık en az 3 karakter olmalı.')).toBeTruthy();
    expect(screen.getByText('Sorunu kısaca anlatın.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/portal/tickets')).toBe(false);

    await fireEvent.changeText(screen.getByLabelText('Başlık'), ' Lavabo su kaçırıyor ');
    await fireEvent.changeText(screen.getByLabelText('Açıklama'), 'Dün akşamdan beri.');
    await fireEvent.press(screen.getByRole('button', { name: 'Galeriden seç' }));
    await screen.findByLabelText('Eklenen fotoğraf 1');
    await fireEvent.press(screen.getByRole('button', { name: 'Talebi gönder' }));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/resident/tickets/[id]', params: { id: '99' } }));
    const body = calls.find((c) => c.method === 'POST' && c.path === '/api/portal/tickets')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Lavabo su kaçırıyor', description: 'Dün akşamdan beri.', category: 'plumbing', location: { kind: 'unit', unitId: 'u-3' }, photos: ['u1_jpg'] });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty('priority');
  });

  it('ortak alan: alan adi zorunlu; benzer acik talep uyarisi', async () => {
    const { calls } = await renderApp(<NewTicketScreen />, {
      routes: {
        'GET /api/portal/my-summary': ticketSummary,
        'GET /api/portal/tickets/similar': { items: [{ number: 'T-0039', category: 'elevator', area: 'A Blok asansörü', status: 'in_progress', createdAt: '2026-11-26T08:00:00.000Z', mine: false }] },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: /^Ortak alan,/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));
    expect(screen.getByText('Alanı yazın (en az 2 karakter).')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Alan'), 'A Blok asansörü');
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Asansör' }));
    expect(await screen.findByText('Ortak alanda bu kategoride açık talep var')).toBeTruthy();
    expect(screen.getByText('T-0039')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/portal/tickets/similar')?.query).toEqual({ category: 'elevator' });
  });

  it('API hatasi Turkce mesajla gosterilir, ayni islem anahtariyla tekrar denenebilir', async () => {
    let fail = true;
    const { calls } = await renderApp(<NewTicketScreen />, {
      routes: {
        'GET /api/portal/my-summary': ticketSummary,
        'POST /api/portal/tickets': () => (fail ? { status: 422, body: { error: 'unprocessable', message: 'Bu kategori daire içinde seçilemez' } } : created),
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: /^Daire içi/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Elektrik' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Devam' }));
    await fireEvent.changeText(screen.getByLabelText('Başlık'), 'Priz çalışmıyor');
    await fireEvent.changeText(screen.getByLabelText('Açıklama'), 'Mutfaktaki priz.');
    await fireEvent.press(screen.getByRole('button', { name: 'Talebi gönder' }));
    expect(await screen.findByText('Bu kategori daire içinde seçilemez')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Talebi gönder' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    const keys = calls.filter((c) => c.method === 'POST' && c.path === '/api/portal/tickets').map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
