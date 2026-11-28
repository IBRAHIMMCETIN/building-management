import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { Linking, Pressable } from 'react-native';
import { type Routes, renderApp } from '@/test/renderApp';
import { GateScreen } from './GateScreen';

/*
 * Guvenlik gorevlisi Kapı: kamera modulu sahte (izin durumu ve okunan barkod testten verilir), API sahte.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

let mockPermission: { granted: boolean; canAskAgain: boolean } | null = { granted: true, canAskAgain: true };
const mockRequestPermission = jest.fn();
let mockScan: ((r: { data: string }) => void) | undefined;
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    useCameraPermissions: () => [mockPermission, mockRequestPermission],
    CameraView: (props: { onBarcodeScanned?: (r: { data: string }) => void }) => {
      mockScan = props.onBarcodeScanned;
      return React.createElement(View, { testID: 'camera' });
    },
  };
});

const GUARD = 'security_guard@dev.local';
const TOKEN = 'aB3_dE5-fG7hJ9kL1mN2pQ4r';

const pass = (over: Record<string, unknown> = {}) => ({
  passId: 'p-1',
  unitId: 'u-7',
  unitLabel: 'A Blok · Daire 7',
  guestName: 'Ayşe Yılmaz',
  validFrom: '2026-11-28',
  validUntil: '2026-11-28',
  entryMode: 'single',
  verdict: 'valid',
  entryCount: 0,
  inside: false,
  canEnter: true,
  canExit: false,
  version: 1,
  ...over,
});

const courier = (id: string, over: Record<string, unknown> = {}) => ({
  courierId: id,
  unitId: 'u-2',
  unitLabel: 'A Blok · Daire 2',
  company: 'Trendyol',
  status: 'waiting',
  expired: false,
  respondBy: '2026-11-28T10:10:00.000Z',
  createdAt: '2026-11-28T10:00:00.000Z',
  canRespond: false,
  canEnter: false,
  canExit: false,
  canCancel: true,
  version: 1,
  ...over,
});

const base: Routes = {
  'GET /api/me/contexts': { userId: 'mock-security_guard', isPlatformAdmin: false, active: null, contexts: [] },
  'GET /api/gate/couriers': { items: [], pollSeconds: 15 },
};

const render = (routes: Routes = {}) => renderApp(<GateScreen />, { email: GUARD, withUnit: false, routes: { ...base, ...routes } });

beforeEach(() => {
  mockPermission = { granted: true, canAskAgain: true };
  mockScan = undefined;
  mockPush.mockReset();
  mockRequestPermission.mockReset();
});

describe('Kapı - misafir QR / kisa kod', () => {
  it('QR okutulunca jetonla dogrulanir; ikinci kare yok sayilir; giris kaydedilir', async () => {
    const { calls } = await render({
      'POST /api/gate/passes/verify': { pass: pass() },
      'POST /api/gate/passes/p-1/entry': { pass: pass({ canEnter: false, inside: true, verdict: 'used' }) },
    });
    await fireEvent.press(screen.getByRole('button', { name: 'QR okut' }));
    expect(screen.getByTestId('camera')).toBeTruthy();
    await act(async () => {
      mockScan?.({ data: `https://app.test/gecis/${TOKEN}#K7M2PQ4X` });
      mockScan?.({ data: `https://app.test/gecis/${TOKEN}#K7M2PQ4X` });
    });
    expect(await screen.findByText('Geçiş geçerli')).toBeTruthy();
    const verifies = calls.filter((c) => c.path === '/api/gate/passes/verify');
    expect(verifies).toHaveLength(1);
    expect(verifies[0]?.body).toEqual({ token: TOKEN });
    expect(screen.getByLabelText('Misafir: Ayşe Yılmaz')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Giriş kaydet' }));
    expect(await screen.findByText('Ayşe Yılmaz için giriş kaydedildi.')).toBeTruthy();
    const entry = calls.find((c) => c.path === '/api/gate/passes/p-1/entry');
    expect(typeof (entry?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('kisa kod elle: normalize edilir; tanınmayan metin istek atmadan uyarir; reddedilen gecis kirmizi karar', async () => {
    const { calls } = await render({ 'POST /api/gate/passes/verify': { pass: pass({ verdict: 'expired', message: 'Geçişin süresi dolmuş.', canEnter: false }) } });
    const field = screen.getByLabelText('veya kısa kodu yazın');
    await fireEvent.changeText(field, 'zz');
    await fireEvent.press(screen.getByRole('button', { name: 'Sorgula' }));
    expect(screen.getByText('Kod tanınmadı. 8 karakterlik kısa kodu (örnek: K7M2-PQ4X) yazın.')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/gate/passes/verify')).toBe(false);

    await fireEvent.changeText(field, 'k7m2-pq4x');
    await fireEvent.press(screen.getByRole('button', { name: 'Sorgula' }));
    expect(await screen.findByText('Geçiş reddedildi')).toBeTruthy();
    expect(screen.getByText('Geçişin süresi dolmuş.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/gate/passes/verify')?.body).toEqual({ code: 'K7M2PQ4X' });
    expect(screen.queryByRole('button', { name: 'Giriş kaydet' })).toBeNull();
  });

  it('deneme siniri (429): mesaj + geri sayim, QR ve sorgu sure dolana kadar kapali', async () => {
    await render({
      'POST /api/gate/passes/verify': { status: 429, body: { error: 'rate_limited', message: 'Çok fazla geçiş sorgusu yapıldı. Güvenlik nedeniyle 2 dakika sonra tekrar deneyin.', retryAfterSeconds: 120 } },
    });
    await fireEvent.changeText(screen.getByLabelText('veya kısa kodu yazın'), 'K7M2-PQ4X');
    await fireEvent.press(screen.getByRole('button', { name: 'Sorgula' }));
    expect(await screen.findByText(/Çok fazla geçiş sorgusu yapıldı.*Kalan süre: (2:00|1:59)\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sorgula' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole('button', { name: 'QR okut' }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('kamera izni kalici reddedildiyse aciklama ve Ayarlar baglantisi', async () => {
    mockPermission = { granted: false, canAskAgain: false };
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await render();
    await fireEvent.press(screen.getByRole('button', { name: 'QR okut' }));
    expect(screen.getByText(/^Kamera izni kapalı./)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Ayarları aç' }));
    expect(open).toHaveBeenCalled();
    expect(screen.queryByTestId('camera')).toBeNull();
  });

  it('kamera izni hic sorulmadiysa uygulama ici gerekce ve izin istemi', async () => {
    mockPermission = { granted: false, canAskAgain: true };
    await render();
    await fireEvent.press(screen.getByRole('button', { name: 'QR okut' }));
    expect(screen.getByText(/^Kamera izni gerekli./)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Kameraya izin ver' }));
    expect(mockRequestPermission).toHaveBeenCalled();
  });
});

describe('Kapı - giris siniri ve kamera yasam dongusu', () => {
  it('giris kaydinda 429: geri sayim, giris dugmesi sure dolana kadar kapali', async () => {
    const { calls } = await render({
      'POST /api/gate/passes/verify': { pass: pass() },
      'POST /api/gate/passes/p-1/entry': { status: 429, body: { error: 'rate_limited', message: 'Çok fazla istek. 1 dakika sonra tekrar deneyin.', retryAfterSeconds: 60 } },
    });
    await fireEvent.changeText(screen.getByLabelText('veya kısa kodu yazın'), 'K7M2-PQ4X');
    await fireEvent.press(screen.getByRole('button', { name: 'Sorgula' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Giriş kaydet' }));
    expect(await screen.findByText(/Çok fazla istek.*Kalan süre: (1:00|0:59)\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Giriş kaydet' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Giriş kaydet' }));
    expect(calls.filter((c) => c.path === '/api/gate/passes/p-1/entry')).toHaveLength(1);
  });

  it('sekme gizlenince kamera kapanir, geri gelince yeniden acilir', async () => {
    // Sekme odagi (app/guard/(tabs)/index.tsx -> useIsFocused) testte bir dugmeyle degistirilir.
    function FocusHarness() {
      const [active, setActive] = useState(true);
      return (
        <>
          <Pressable accessibilityRole="button" accessibilityLabel="odak" onPress={() => setActive((a) => !a)} />
          <GateScreen active={active} />
        </>
      );
    }
    await renderApp(<FocusHarness />, { email: GUARD, withUnit: false, routes: base });
    await fireEvent.press(screen.getByRole('button', { name: 'QR okut' }));
    expect(screen.getByTestId('camera')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'odak' }));
    expect(screen.queryByTestId('camera')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'odak' }));
    expect(screen.getByTestId('camera')).toBeTruthy();
  });
});

describe('Kapı - plaka', () => {
  it('yalnizca "Sorgula" ile (yazarken istek yok, en az 3 karakter); kayitsiz plakada elle kayda gecis', async () => {
    const { calls } = await render({ 'GET /api/gate/plates': { query: '34XYZ9', queryDisplay: '34 XYZ 9', items: [] } });
    await fireEvent.press(screen.getByRole('radio', { name: 'Plaka sorgu' }));
    const field = screen.getByLabelText('Plaka (tamamı veya son 3+ karakter)');
    await fireEvent.changeText(field, '34');
    expect(screen.getByText('Sorgu için en az 3 karakter yazın.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sorgula' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(field, '34 xyz 9');
    // Deneme sinirini (120 / 15 dk) yazarken harcamaz.
    await new Promise((r) => setTimeout(r, 900));
    expect(calls.some((c) => c.path === '/api/gate/plates')).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Sorgula' }));
    expect(await screen.findByText('Kayıtlı değil')).toBeTruthy();
    const plates = calls.filter((c) => c.path === '/api/gate/plates');
    expect(plates).toHaveLength(1);
    expect(plates[0]?.query).toEqual({ q: '34XYZ9' });
    await fireEvent.press(screen.getByRole('button', { name: 'Ziyaretçi olarak giriş kaydet' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/guard/manual-entry', params: { plate: '34XYZ9' } });
  });
});

describe('Kapı - kurye', () => {
  it('bolum secilip firmayla daireye bildirilir; onaylanan kurye iceri alinir', async () => {
    const { calls } = await render({
      'GET /api/gate/units': { items: [{ unitId: 'u-7', label: 'A Blok · Daire 7' }] },
      'GET /api/gate/couriers': {
        items: [courier('c-1'), courier('c-2', { status: 'approved', canEnter: true, enterBy: '2026-11-28T10:15:00.000Z', unitLabel: 'B Blok · Daire 5' })],
        pollSeconds: 15,
      },
      'POST /api/gate/couriers': { status: 201, body: { courier: courier('c-3', { unitId: 'u-7', unitLabel: 'A Blok · Daire 7' }) } },
      'POST /api/gate/couriers/c-2/entry': { courier: courier('c-2', { status: 'approved', enteredAt: '2026-11-28T10:05:00.000Z', canExit: true }) },
    });
    // Bolum seciminde acik (bekleyen + iceride) kurye sayisi gorunur (web gibi).
    await fireEvent.press(await screen.findByRole('radio', { name: 'Kurye, 2' }));
    expect(await screen.findByText('Onay bekliyor')).toBeTruthy();
    expect(screen.getByText('Onaylandı')).toBeTruthy();
    expect(screen.getByText(/1 kurye sakin onayı bekliyor/)).toBeTruthy();

    expect(screen.getByRole('button', { name: 'Daireye bildir' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(await screen.findByRole('radio', { name: 'A Blok · Daire 7' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Trendyol' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Daireye bildir' }));
    expect(await screen.findByText('A Blok · Daire 7 için kurye kaydedildi; daire sakininin onayı bekleniyor.')).toBeTruthy();
    const created = calls.find((c) => c.method === 'POST' && c.path === '/api/gate/couriers');
    expect(created?.body).toMatchObject({ unitId: 'u-7', company: 'Trendyol' });
    expect(typeof (created?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');

    await fireEvent.press(screen.getByRole('button', { name: 'B Blok · Daire 5 kuryesini içeri al' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/gate/couriers/c-2/entry')).toBe(true));
  });
});

describe('Kapı - kayitlar', () => {
  it('dun + bugun sorgulanir; tur filtresi istege eklenir', async () => {
    const { calls } = await render({
      'GET /api/gate/log': { items: [{ logId: 'l1', at: '2026-11-28T07:00:00.000Z', direction: 'entry', kind: 'manual', visitorName: 'Su servisi', recordedByName: 'Gece' }], from: '2026-11-27', to: '2026-11-28' },
    });
    await fireEvent.press(screen.getByRole('radio', { name: 'Kapı kayıtları' }));
    expect(await screen.findByText('Su servisi')).toBeTruthy();
    const first = calls.find((c) => c.path === '/api/gate/log');
    expect(Object.keys(first?.query ?? {}).sort()).toEqual(['from', 'to']);
    // Ust bolum secimindeki "Kurye" ile karismasin: kayit turu filtresi sonda.
    const kinds = screen.getAllByRole('radio', { name: 'Kurye' });
    await fireEvent.press(kinds[kinds.length - 1] as never);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/gate/log' && c.query.kind === 'courier')).toBe(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Elle giriş / çıkış' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/guard/manual-entry', params: {} });
  });
});
