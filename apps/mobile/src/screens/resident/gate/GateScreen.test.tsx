import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { AppState, type AppStateStatus, Share } from 'react-native';
import { PortalForegroundRefresh } from '@/hooks/useAppForeground';
import { renderApp } from '@/test/renderApp';
import { GateScreen } from './GateScreen';

const overview = (units = [{ unitId: 'u-3', label: 'A Blok · Daire 3' }]) => ({ units, limits: { maxVehiclesPerUnit: 4, maxPassDays: 31, maxPassLeadDays: 90, courierResponseMinutes: 60 } });
const courier = (over: Record<string, unknown> = {}) => ({
  courierId: 'c1',
  unitId: 'u-3',
  unitLabel: 'A Blok · Daire 3',
  company: 'Yemeksepeti',
  note: 'Kapıda bekliyor',
  status: 'waiting',
  expired: false,
  createdAt: '2026-11-28T09:00:00.000Z',
  respondBy: '2026-11-28T10:00:00.000Z',
  canRespond: true,
  canEnter: false,
  canExit: false,
  canCancel: false,
  version: 2,
  ...over,
});
const pass = (id: string, over: Record<string, unknown> = {}) => ({
  passId: id,
  unitId: 'u-3',
  unitLabel: 'A Blok · Daire 3',
  guestName: `Misafir ${id}`,
  validFrom: '2026-11-28',
  validUntil: '2026-11-30',
  entryMode: 'multi',
  status: 'active',
  verdict: 'valid',
  entryCount: 0,
  inside: false,
  createdAt: '2026-11-27T09:00:00.000Z',
  mine: true,
  canRevoke: true,
  canRotate: true,
  version: 5,
  ...over,
});
const vehicle = { vehicleId: 'v1', unitId: 'u-3', unitLabel: 'A Blok · Daire 3', plate: '34ABC123', plateDisplay: '34 ABC 123', note: 'Beyaz', status: 'active', createdAt: 'x', updatedAt: 'x', createdByRole: 'resident', version: 1 };
const logEntry = (id: string) => ({ logId: id, at: '2026-11-27T15:00:00.000Z', direction: 'entry', kind: 'guest', unitId: 'u-3', unitLabel: 'A Blok · Daire 3', visitorName: `Ziyaretçi ${id}` });

const base = (over: Record<string, unknown> = {}) => ({
  'GET /api/portal/gate': overview(),
  'GET /api/portal/gate/couriers': { items: [], pollSeconds: 15 },
  'GET /api/portal/gate/passes': { items: [pass('p1')] },
  'GET /api/portal/gate/vehicles': { items: [vehicle], maxPerUnit: 4 },
  'GET /api/portal/gate/log': { items: [logEntry('l1')], from: '2026-11-21', to: '2026-11-28' },
  ...over,
});

beforeEach(() => jest.restoreAllMocks());

describe('Ziyaretçi', () => {
  it('kapidaki kurye: belirgin kart, yanit icin son saat; onay gonderilir', async () => {
    let answered = false;
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'GET /api/portal/gate/couriers': () => ({ items: [courier(answered ? { status: 'approved', canRespond: false } : {})], pollSeconds: 15 }),
        'POST /api/portal/gate/couriers/c1/respond': () => {
          answered = true;
          return { courier: courier({ status: 'approved', canRespond: false, version: 3 }) };
        },
      }),
    });
    expect(await screen.findByRole('header', { name: 'Kapıda kurye var' })).toBeTruthy();
    expect(screen.getByText('Görevlinin notu: Kapıda bekliyor')).toBeTruthy();
    // Istanbul saati (UTC+3): 10:00Z -> 13:00.
    expect(screen.getByText('13:00')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'İçeri alınsın' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/respond'))?.body).toEqual({ version: 2, decision: 'approve' }));
    await waitFor(() => expect(screen.queryByText('Kapıda kurye var')).toBeNull());
  });

  it('uygulama one gelince kurye listesi hemen yenilenir', async () => {
    const listeners: Array<(s: AppStateStatus) => void> = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
      listeners.push(fn as (s: AppStateStatus) => void);
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    const { calls } = await renderApp(
      <>
        <PortalForegroundRefresh />
        <GateScreen />
      </>,
      { routes: base() },
    );
    await screen.findByText('Misafir p1');
    const before = calls.filter((c) => c.path === '/api/portal/gate/couriers').length;
    await act(async () => {
      for (const fn of listeners) fn('background');
      for (const fn of listeners) fn('active');
    });
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/portal/gate/couriers').length).toBeGreaterThan(before));
  });

  it('misafir gecisi: ad zorunlu; olusturulunca QR + kisa kod, sistem paylasimiyla gonderilir', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'POST /api/portal/gate/passes': { status: 201, body: { pass: pass('p9', { guestName: 'Ayşe Demir', entryMode: 'single', token: 'tok_abcdefghijklmnopqrstu', shortCode: 'K7M2PQ4X' }), replayed: false } },
      }),
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Misafir geçişi oluştur' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Geçiş oluştur' }));
    expect(await screen.findByText('Misafirin adını yazın (en az 2 karakter).')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/portal/gate/passes')).toBe(false);

    await fireEvent.changeText(screen.getByLabelText('Misafirin adı'), ' Ayşe Demir ');
    await fireEvent.changeText(screen.getByLabelText('Araç plakası (isteğe bağlı)'), '06 ab 1234');
    await fireEvent.press(screen.getByRole('button', { name: 'Geçiş oluştur' }));

    expect(await screen.findByText('K7M2-PQ4X')).toBeTruthy();
    expect(screen.getByRole('image', { name: 'Geçiş QR kodu' })).toBeTruthy();
    const body = calls.find((c) => c.method === 'POST' && c.path === '/api/portal/gate/passes')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ unitId: 'u-3', guestName: 'Ayşe Demir', entryMode: 'single', plate: '06AB1234' });
    expect(body.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body).not.toHaveProperty('validUntil');
    expect(typeof body.idempotencyKey).toBe('string');

    await fireEvent.press(screen.getByRole('button', { name: 'Misafirle paylaş' }));
    const sent = share.mock.calls[0]?.[0] as { message?: string; url?: string };
    expect(`${sent.message} ${sent.url ?? ''}`).toContain('K7M2-PQ4X');
    expect(`${sent.message} ${sent.url ?? ''}`).toContain('https://web.test/gecis/tok_abcdefghijklmnopqrstu#K7M2PQ4X');
  });

  it('yeni QR ve iptal ikinci dokunusla onaylanir', async () => {
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'POST /api/portal/gate/passes/p1/rotate': { pass: pass('p1', { version: 6, token: 'tok_zzzzzzzzzzzzzzzzzzzzzz', shortCode: 'AAAA2222' }) },
        'POST /api/portal/gate/passes/p1/revoke': { pass: pass('p1', { status: 'revoked', verdict: 'revoked', canRevoke: false, canRotate: false, version: 6 }) },
      }),
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Misafir p1 için yeni QR oluştur' }));
    expect(screen.getByText(/daha önce paylaştığınız QR ve kod çalışmaz/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Evet, yeni QR oluştur' }));
    expect(await screen.findByText('AAAA-2222')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/rotate'))?.body).toEqual({ version: 5 });
    await fireEvent.press(screen.getAllByRole('button', { name: 'Kapat' }).at(-1)!);

    await fireEvent.press(screen.getByRole('button', { name: 'Misafir p1 geçişini iptal et' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Evet, iptal et' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/revoke'))?.body).toEqual({ version: 5 }));
  });

  it('yeni QR istegi surerken bolum degisse de yeni jeton kaybolmaz (pencere acilir)', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'POST /api/portal/gate/passes/p1/rotate': () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      }),
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Misafir p1 için yeni QR oluştur' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Evet, yeni QR oluştur' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/rotate'))).toBe(true));
    // Istek surerken Araçlarım'a gecilir: misafir listesi ekrandan kalkar.
    await fireEvent.press(screen.getByRole('radio', { name: 'Araçlarım' }));
    expect(screen.queryByText('Misafir p1')).toBeNull();
    await act(async () => release({ pass: pass('p1', { version: 6, token: 'tok_yyyyyyyyyyyyyyyyyyyyyy', shortCode: 'BBBB3333' }) }));
    expect(await screen.findByText('BBBB-3333')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Misafir geçişi' })).toBeTruthy();
  });

  it('gecis formu: ayni acilista tekrar ayni anahtar; pencere kapanip acilinca yeni anahtar', async () => {
    let fail = true;
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'POST /api/portal/gate/passes': () =>
          fail ? { status: 503, body: { error: 'unavailable' } } : { status: 201, body: { pass: pass('p9', { token: 'tok_abcdefghijklmnopqrstu', shortCode: 'K7M2PQ4X' }), replayed: false } },
      }),
    });
    const fillAndSubmit = async () => {
      await fireEvent.changeText(screen.getByLabelText('Misafirin adı'), 'Ayşe');
      await fireEvent.press(screen.getByRole('button', { name: 'Geçiş oluştur' }));
    };
    await fireEvent.press(await screen.findByRole('button', { name: 'Misafir geçişi oluştur' }));
    await fillAndSubmit();
    expect(await screen.findByText('Sunucuda beklenmeyen bir hata oluştu.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Geçiş oluştur' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/portal/gate/passes')).toHaveLength(2));
    await fireEvent.press(screen.getByRole('button', { name: 'Vazgeç' }));
    // Yeniden acilan formda onceki hata yok, yeni anahtar.
    await fireEvent.press(screen.getByRole('button', { name: 'Misafir geçişi oluştur' }));
    expect(screen.queryByText('Sunucuda beklenmeyen bir hata oluştu.')).toBeNull();
    fail = false;
    await fillAndSubmit();
    expect(await screen.findByText('K7M2-PQ4X')).toBeTruthy();
    const keys = calls.filter((c) => c.method === 'POST' && c.path === '/api/portal/gate/passes').map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('yanit suresi gecen kuryede dugmeler kapanir; yenileme sunucunun pollSeconds degeriyle', async () => {
    const { queryClient } = await renderApp(<GateScreen />, {
      routes: base({ 'GET /api/portal/gate/couriers': { items: [courier({ respondBy: '2020-01-01T10:00:00.000Z' })], pollSeconds: 30 } }),
    });
    expect(await screen.findByText(/^Yanıt süresi doldu/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'İçeri alınsın' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole('button', { name: 'Reddet' }).props.accessibilityState).toMatchObject({ disabled: true });
    const query = queryClient.getQueryCache().findAll({ predicate: (q) => q.queryKey.includes('couriers') })[0];
    const interval = query?.observers[0]?.options.refetchInterval as (q: unknown) => number;
    expect(interval(query)).toBe(30_000);
  });

  it('araclarim: plaka bicimi denetlenir, kaydedilir, pasife alinir', async () => {
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'POST /api/portal/gate/vehicles': { status: 201, body: { vehicle: { ...vehicle, vehicleId: 'v2', plate: '34KY987', plateDisplay: '34 KY 987' } } },
        'PATCH /api/portal/gate/vehicles/v1': { vehicle: { ...vehicle, status: 'inactive', version: 2 } },
      }),
    });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Araçlarım' }));
    await fireEvent.changeText(screen.getByLabelText('Plaka'), '99 Q 1');
    await fireEvent.press(screen.getByRole('button', { name: 'Aracı kaydet' }));
    expect(await screen.findByText('Plaka Türkiye plaka biçiminde olmalıdır (örnek: 34 ABC 123)')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Plaka'), '34 ky 987');
    await fireEvent.press(screen.getByRole('button', { name: 'Aracı kaydet' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/portal/gate/vehicles')?.body).toEqual({ unitId: 'u-3', plate: '34KY987' }));

    await fireEvent.press(await screen.findByRole('button', { name: '34 ABC 123 pasife al' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ version: 1, status: 'inactive' }));
  });

  it('kapi kayitlari: daha fazla yukle sonraki sayfayi ister', async () => {
    const { calls } = await renderApp(<GateScreen />, {
      routes: base({
        'GET /api/portal/gate/log': ({ query }: { query: Record<string, string> }) =>
          query.cursor ? { items: [logEntry('l2')], from: '2026-11-21', to: '2026-11-28' } : { items: [logEntry('l1')], from: '2026-11-21', to: '2026-11-28', nextCursor: 'c-2' },
      }),
    });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Kapı kayıtları' }));
    expect(await screen.findByText('Ziyaretçi l1')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    expect(await screen.findByText('Ziyaretçi l2')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/portal/gate/log' && c.query.cursor)?.query).toEqual({ unitId: 'u-3', cursor: 'c-2' });
    expect(within(screen.getByLabelText(/^Ziyaretçi l1, Giriş, Misafir/)).getByText('Giriş')).toBeTruthy();
  });

  it('dairede oturmayan sakin: aciklama; sunucu hatasi tekrar denenebilir', async () => {
    await renderApp(<GateScreen />, { routes: base({ 'GET /api/portal/gate': overview([]) }) });
    expect(await screen.findByText(/yalnızca dairede oturan sakinler içindir/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Misafirler' })).toBeNull();
  });

  it('genel bilgi alinamazsa hata ve tekrar dene', async () => {
    let fail = true;
    await renderApp(<GateScreen />, { routes: base({ 'GET /api/portal/gate': () => (fail ? { status: 503, body: { error: 'unavailable' } } : overview()) }) });
    expect(await screen.findByText('Sunucuda beklenmeyen bir hata oluştu.')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(await screen.findByText('Misafir p1')).toBeTruthy();
  });
});
