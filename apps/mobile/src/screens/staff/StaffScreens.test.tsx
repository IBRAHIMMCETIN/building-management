import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { type Routes, renderApp } from '@/test/renderApp';
import { MeterReadingScreen } from './MeterReadingScreen';
import { MyWorkScreen } from './MyWorkScreen';
import { StaffTaskScreen } from './StaffTaskScreen';
import { StaffTicketScreen } from './StaffTicketScreen';

/* Bina gorevlisi: İşlerim, talep / bakim durum gecisleri (not, fotograf), tahmin notu, sayac okuma. */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockLaunchCamera = jest.fn();
let mockCameraGranted = true;
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: async () => ({ granted: mockCameraGranted, canAskAgain: false }),
  launchCameraAsync: (...args: unknown[]) => mockLaunchCamera(...args),
  launchImageLibraryAsync: async () => ({ canceled: true, assets: null }),
}));
// Ortak foto hatti (lib/photos.ts): kucultme + JPEG; dosya boyutu sahte fetch'ten.
jest.mock('expo-image-manipulator', () => {
  const ctx: { resize: jest.Mock; renderAsync: jest.Mock } = { resize: jest.fn(() => ctx), renderAsync: jest.fn(async () => ({ saveAsync: jest.fn(async () => ({ uri: 'file:///after.jpg', width: 1600, height: 1200 })) })) };
  return { ImageManipulator: { manipulate: jest.fn(() => ctx) }, SaveFormat: { JPEG: 'jpeg' } };
});

const STAFF = 'building_staff@dev.local';

const ticket = (id: string, over: Record<string, unknown> = {}) => ({
  ticketId: id,
  number: `T-${id}`,
  title: `Talep ${id}`,
  description: 'Asansör katlar arasında duruyor.',
  category: 'elevator',
  priority: 'normal',
  location: { kind: 'common', area: 'B Blok asansörü' },
  status: 'assigned',
  source: 'portal',
  createdAt: '2026-11-28T06:00:00.000Z',
  dueAt: '2099-11-29T06:00:00.000Z',
  assigneeId: 'mock-building_staff',
  mine: true,
  actions: ['start'],
  canEstimate: true,
  version: 1,
  ...over,
});

const task = (id: string, over: Record<string, unknown> = {}) => ({
  taskId: id,
  templateId: 'tpl',
  dueDate: '2026-11-01',
  name: 'Hidrofor kontrol',
  kind: 'periodic',
  category: 'water_pump',
  checklist: [
    { id: 'c1', text: 'Basınç normal', required: true },
    { id: 'c2', text: 'Pano temiz', required: false },
  ],
  status: 'scheduled',
  assigneeId: 'mock-building_staff',
  actions: ['start', 'complete', 'skip'],
  version: 4,
  ...over,
});

const render = (ui: React.ReactElement, routes: Routes) => renderApp(ui, { email: STAFF, withUnit: false, routes: { 'GET /api/tickets/assignees': { items: [] }, ...routes } });

beforeEach(() => {
  mockCameraGranted = true;
  mockPush.mockReset();
  mockLaunchCamera.mockReset();
});

describe('İşlerim', () => {
  it('bugun: bana atanan talep + vadesi gelen bakim; havuz ayri; tek dokunusla basla', async () => {
    const { calls } = await render(<MyWorkScreen />, {
      'GET /api/tickets': ({ query }: { query: Record<string, string> }) => ({ items: query.assignee === 'me' ? [ticket('1')] : [ticket('9', { assigneeId: undefined, mine: false, actions: [], canAssign: true })], total: 1 }),
      'GET /api/maintenance/tasks': ({ query }: { query: Record<string, string> }) => ({ items: query.assignee === 'me' ? [task('t-1')] : [] }),
      'POST /api/tickets/1/status': { ticket: ticket('1', { status: 'in_progress', actions: ['hold', 'resolve'], version: 2 }) },
    });
    expect(await screen.findByText('Talep 1')).toBeTruthy();
    expect(screen.getByText('Hidrofor kontrol')).toBeTruthy();
    expect(screen.queryByText('Talep 9')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Havuz, 1' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'T-1 işe başla' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/tickets/1/status')?.body).toEqual({ version: 1, action: 'start' }));
    expect(calls.find((c) => c.path === '/api/tickets' && c.query.assignee === 'me')?.query).toMatchObject({ status: 'active' });

    await fireEvent.press(screen.getByRole('button', { name: /^Bakım, .*Hidrofor kontrol/ }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/staff/task/[id]', params: { id: 't-1' } });
    await fireEvent.press(screen.getByRole('radio', { name: 'Havuz, 1' }));
    expect(await screen.findByText('Talep 9')).toBeTruthy();
  });
});

describe('Talep ayrintisi', () => {
  const detail = (over: Record<string, unknown> = {}) => ({ ticket: ticket('1', { status: 'in_progress', actions: ['hold', 'resolve'], ...over }), events: [] });

  it('cozuldu: aciklama zorunlu; not ve kamera fotografi ile gonderilir', async () => {
    mockLaunchCamera.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///raw.heic', width: 4032, height: 3024 }] });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => ({ size: 2048 }) } as unknown as Response);
    const { calls } = await render(<StaffTicketScreen id="1" />, {
      'GET /api/tickets/1': detail(),
      'POST /api/tickets/photos/upload-url': { uploadId: 'up1_jpg', uploadUrl: 'https://s3.test/up1', headers: { 'Content-Type': 'image/jpeg' } },
      'PUT https://s3.test/up1': { status: 200 },
      'POST /api/tickets/1/status': { ticket: ticket('1', { status: 'resolved', actions: [], version: 2 }) },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Çözüldü' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Çözüldü' }));
    expect(screen.getByText('Bu işlem için açıklama gerekli (en az 3 karakter).')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/tickets/1/status')).toBe(false);

    await fireEvent.changeText(screen.getByLabelText('Açıklama'), 'Conta değişti');
    // Ilk secici durum formunda (yorum kutusununki altta).
    await fireEvent.press(screen.getAllByRole('button', { name: 'Fotoğraf çek' })[0] as never);
    expect(await screen.findByLabelText('Eklenen fotoğraf 1: kaldır')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Çözüldü' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/tickets/1/status')?.body).toEqual({ version: 1, action: 'resolve', note: 'Conta değişti', photos: ['up1_jpg'] }));
    expect(calls.find((c) => c.path === '/api/tickets/photos/upload-url')?.body).toEqual({ contentType: 'image/jpeg', size: 2048 });
    expect(calls.some((c) => c.method === 'PUT' && c.path === 'https://s3.test/up1')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('kamera izni reddedildiyse aciklama gosterilir, gonderim yapilmaz', async () => {
    mockCameraGranted = false;
    await render(<StaffTicketScreen id="1" />, { 'GET /api/tickets/1': detail() });
    await fireEvent.press(await screen.findByRole('button', { name: 'Beklet' }));
    await fireEvent.press(screen.getAllByRole('button', { name: 'Fotoğraf çek' })[0] as never);
    expect(await screen.findByText(/^Kamera izni verilmedi/)).toBeTruthy();
    expect(screen.queryByLabelText('Eklenen fotoğraf 1: kaldır')).toBeNull();
  });

  it('havuzdaki talep ustlenilir; ic not gonderilir; tahmin kurus olarak kaydedilir', async () => {
    const { calls } = await render(<StaffTicketScreen id="1" />, {
      'GET /api/tickets/1': detail({ assigneeId: undefined, mine: false, canAssign: true, actions: [] }),
      'POST /api/tickets/1/assign': { ticket: ticket('1') },
      'POST /api/tickets/1/comments': { event: { eventId: 'e1', kind: 'comment', visibility: 'internal', at: '2026-11-28T08:00:00.000Z' } },
      'PUT /api/tickets/1/estimate': { ticket: ticket('1', { version: 2 }) },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Üstlen' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/tickets/1/assign')?.body).toEqual({ version: 1, assigneeId: 'mock-building_staff' }));

    await fireEvent.changeText(screen.getByLabelText('Yorum metni'), 'Parça sipariş edildi');
    await fireEvent.press(screen.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/tickets/1/comments')?.body).toEqual({ body: 'Parça sipariş edildi', visibility: 'internal' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Tutar gir' }));
    await fireEvent.changeText(screen.getByLabelText('Tutar (TL)'), '1.250,50');
    await fireEvent.press(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/tickets/1/estimate')?.body).toEqual({ version: 1, amount: 125050 }));
  });
});

describe('Bakim gorevi', () => {
  it('tamamla: zorunlu madde cevaplanmadan gonderilmez; sorunlu madde ariza onerisi getirir', async () => {
    const { calls } = await render(<StaffTaskScreen id="t-1" />, {
      'GET /api/maintenance/tasks/t-1': { task: task('t-1', { status: 'in_progress', actions: ['complete', 'skip'] }) },
      'POST /api/maintenance/tasks/t-1/complete': { task: task('t-1', { status: 'done', actions: ['ticket'], version: 5 }), failedItems: 1, suggestTicket: true },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Tamamla' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Tamamla' }));
    expect(screen.getByText('Zorunlu madde cevaplanmadı: Basınç normal')).toBeTruthy();

    const options = screen.getAllByRole('radio', { name: 'Sorunlu' });
    await fireEvent.press(options[0] as never);
    await fireEvent.press(screen.getByRole('button', { name: 'Tamamla' }));
    expect(screen.getByText('Başarısız madde için açıklama gerekli: Basınç normal')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Basınç normal açıklaması'), 'Basınç 1 bar');
    await fireEvent.press(screen.getByRole('button', { name: 'Tamamla' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/maintenance/tasks/t-1/complete')?.body).toEqual({ version: 4, checklistResults: [{ id: 'c1', ok: false, note: 'Basınç 1 bar' }] }),
    );
  });

  it('atla gerekceyle gonderilir', async () => {
    const { calls } = await render(<StaffTaskScreen id="t-1" />, {
      'GET /api/maintenance/tasks/t-1': { task: task('t-1') },
      'POST /api/maintenance/tasks/t-1/skip': { task: task('t-1', { status: 'skipped', version: 5 }) },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Atla' }));
    expect(screen.getByRole('button', { name: 'Atla' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText('Atlama gerekçesi'), 'Firma gelemedi');
    await fireEvent.press(screen.getByRole('button', { name: 'Atla' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/maintenance/tasks/t-1/skip')?.body).toEqual({ version: 4, reason: 'Firma gelemedi' }));
  });
});

describe('surum degisince ekran durumu korunur', () => {
  it('bakim: tamamlama sonrasi yenilenen gorevde ariza onerisi kalir', async () => {
    let done = false;
    await render(<StaffTaskScreen id="t-1" />, {
      'GET /api/maintenance/tasks/t-1': () => ({ task: done ? task('t-1', { status: 'done', actions: ['ticket'], version: 5 }) : task('t-1', { status: 'in_progress', actions: ['complete'] }) }),
      'POST /api/maintenance/tasks/t-1/complete': () => {
        done = true;
        return { task: task('t-1', { status: 'done', actions: ['ticket'], version: 5 }), failedItems: 1, suggestTicket: true };
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Tamamla' }));
    await fireEvent.press(screen.getAllByRole('radio', { name: 'Sorunlu' })[0] as never);
    await fireEvent.changeText(screen.getByLabelText('Basınç normal açıklaması'), 'Basınç 1 bar');
    await fireEvent.press(screen.getByRole('button', { name: 'Tamamla' }));
    // Yenileme (surum 5) geldikten sonra da oneri gorunur.
    expect(await screen.findByText('Tamamlandı')).toBeTruthy();
    expect(screen.getByText('Başarısız madde var. Sorunu takip etmek için arıza talebi açın.')).toBeTruthy();
  });

  it('talep: 409 sonrasi yenilenen talepte aciklama, fotograf ve hata korunur', async () => {
    let version = 1;
    await render(<StaffTicketScreen id="1" />, {
      'GET /api/tickets/1': () => ({ ticket: ticket('1', { status: 'in_progress', actions: ['hold', 'resolve'], version }), events: [] }),
      'POST /api/tickets/1/status': () => {
        version = 2;
        return { status: 409, body: { error: 'conflict', message: 'Talep bu arada değişti; ekranı yenileyin.' } };
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Çözüldü' }));
    await fireEvent.changeText(screen.getByLabelText('Açıklama'), 'Conta değişti');
    await fireEvent.press(screen.getByRole('button', { name: 'Çözüldü' }));
    expect(await screen.findByText('Talep bu arada değişti; ekranı yenileyin.')).toBeTruthy();
    // Yeniden yuklenen surum 2 geldikten sonra form ve taslak yerinde.
    await waitFor(() => expect(screen.getByLabelText('Açıklama').props.value).toBe('Conta değişti'));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText('Açıklama').props.value).toBe('Conta değişti');
    expect(screen.getByText('Talep bu arada değişti; ekranı yenileyin.')).toBeTruthy();
  });
});

describe('Sayac okuma', () => {
  it('endeks gecersizse Turkce hata; gecerli endeks tuketimle kaydedilir', async () => {
    const row = { meterId: 'm1', unitId: 'u-7', unitNumber: '7', label: 'Salon', kind: 'heat_allocator', scale: 0, inScope: true, status: 'missing', startIndex: 1500, flags: [] };
    const { calls } = await render(<MeterReadingScreen />, {
      'GET /api/meter-readings/periods': { items: [{ periodId: 'p1', name: 'Kasım ısınma', meterKind: 'heat_allocator', startDate: '2026-11-01', endDate: '2026-11-28', status: 'draft', version: 1 }] },
      'GET /api/meter-readings/periods/p1': { period: { periodId: 'p1', name: 'Kasım ısınma', startDate: '2026-11-01', endDate: '2026-11-28' }, rows: [row], summary: { meters: 1, ok: 0, auto: 0, missing: 1, errors: 0 } },
      'PUT /api/meter-readings/periods/p1': { items: [{ meterId: 'm1', unitId: 'u-7', endIndex: 1620, delta: 120, flags: [] }] },
    });
    const field = await screen.findByLabelText('Yeni endeks');
    await fireEvent.changeText(field, '1620,5');
    await fireEvent.press(screen.getByRole('button', { name: 'Daire 7 Salon endeksini kaydet' }));
    expect(screen.getByText('Bu sayaç ondalık kabul etmez')).toBeTruthy();
    await fireEvent.changeText(field, '1620');
    expect(screen.getByText('Tüketim: 120')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Daire 7 Salon endeksini kaydet' }));
    expect(await screen.findByText('Kaydedildi.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ items: [{ meterId: 'm1', endIndex: 1620 }] });
  });
});
