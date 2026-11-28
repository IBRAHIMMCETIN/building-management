import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { assembly, heldAssembly, residentContexts } from '@/test/assemblyFixtures';
import { renderApp } from '@/test/renderApp';
import { AssembliesScreen } from './AssembliesScreen';
import { AssemblyDetailScreen } from './AssemblyDetailScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

// Baglam listesi API'den (demo modu): malik / kiraci iliskisi testte secilir.
const asOwner = { env: { apiMode: 'demo' as const } };
const contexts = (relation: 'owner' | 'tenant') => ({ 'GET /api/me/contexts': residentContexts(relation) });

beforeEach(() => mockPush.mockClear());

describe('Genel Kurul: yalnizca kat maliki', () => {
  it('kiraci: liste istegi gonderilmez, "kat maliklerine açıktır" gosterilir', async () => {
    const { calls } = await renderApp(<AssembliesScreen />, { ...asOwner, routes: { ...contexts('tenant'), 'GET /api/portal/assemblies': { items: [assembly()] } } });
    expect(await screen.findByText('Genel kurul bilgileri kat maliklerine açıktır')).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith('/api/portal/assemblies'))).toBe(false);
  });

  it('kiraci: bildirimden gelinen ayrinti da kapali (istek yok)', async () => {
    const { calls } = await renderApp(<AssemblyDetailScreen id="as-1" />, { ...asOwner, routes: { ...contexts('tenant'), 'GET /api/portal/assemblies/as-1': assembly() } });
    expect(await screen.findByText('Genel kurul bilgileri kat maliklerine açıktır')).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith('/api/portal/assemblies'))).toBe(false);
  });

  it('API 403 (malik uyeligi bugun yok): ayni bilgi, tekrar dene degil', async () => {
    await renderApp(<AssembliesScreen />, {
      ...asOwner,
      routes: { ...contexts('owner'), 'GET /api/portal/assemblies': { status: 403, body: { error: 'forbidden', message: 'Yalnızca kat malikleri' } } },
    });
    expect(await screen.findByText('Genel kurul bilgileri kat maliklerine açıktır')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tekrar dene' })).toBeNull();
  });

  it('malik: yaklasan ve gecmis toplantilar; dokununca ayrinti', async () => {
    await renderApp(<AssembliesScreen />, { ...asOwner, routes: { ...contexts('owner'), 'GET /api/portal/assemblies': { items: [assembly(), heldAssembly()] } } });
    const upcoming = await screen.findByRole('button', { name: /^Olağan toplantı, 20 Ara 2026 14:00 · Toplantı salonu · 2 gündem maddesi, Yaklaşan$/ });
    expect(screen.getByRole('button', { name: /3 gündem maddesi, Toplantı yapıldı, tutanak hazır$/ })).toBeTruthy();
    await fireEvent.press(upcoming);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/resident/assemblies/[id]', params: { id: 'as-1' } });
  });

  it('malik: toplanti yoksa bos durum', async () => {
    await renderApp(<AssembliesScreen />, { ...asOwner, routes: { ...contexts('owner'), 'GET /api/portal/assemblies': { items: [] } } });
    expect(await screen.findByText('Henüz toplantı yok')).toBeTruthy();
  });

  it('baglam listesi alinamazsa karar API\'nin (malikse liste gelir)', async () => {
    await renderApp(<AssembliesScreen />, {
      ...asOwner,
      routes: { 'GET /api/me/contexts': { status: 500, body: { error: 'internal' } }, 'GET /api/portal/assemblies': { items: [assembly()] } },
    });
    expect(await screen.findByRole('button', { name: /^Olağan toplantı,/ })).toBeTruthy();
  });
});

describe('Genel Kurul ayrintisi', () => {
  it('yaklasan toplanti: bilgiler, cevrim ici baglanti, ikinci toplanti, gundem ve gerekli cogunluk; tutanak yok', async () => {
    await renderApp(<AssemblyDetailScreen id="as-1" />, {
      ...asOwner,
      routes: {
        ...contexts('owner'),
        'GET /api/portal/assemblies/as-1': assembly({
          onlineUrl: 'https://meet.test/genel-kurul',
          secondMeetingPlan: { scheduledAt: '2026-12-27T11:00:00.000Z', location: 'Bahçe' },
        }),
      },
    });
    expect(await screen.findByRole('header', { name: 'Olağan toplantı' })).toBeTruthy();
    expect(screen.getByLabelText('Tarih ve saat: 20 Ara 2026 14:00 (Türkiye saati)')).toBeTruthy();
    expect(screen.getByLabelText('Yeter sayı sağlanamazsa ikinci toplantı: 27 Ara 2026 14:00 · Bahçe')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Çevrim içi bağlantı: bağlantıyı aç' })).toBeTruthy();
    expect(screen.getByText('1. İşletme projesi')).toBeTruthy();
    expect(screen.getByText('Gerekli çoğunluk: Bütün kat maliklerinin sayı (kişi) ve arsa payı çoğunluğu')).toBeTruthy();
    expect(screen.getByText('Tutanak, toplantıdan sonra yönetim tarafından kesinleştirildiğinde burada görünür.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tutanağı görüntüle (PDF)' })).toBeNull();
  });

  it('kesinlesmis toplanti: yeter sayi, kararlar yalnizca toplam sayilarla; kayitsiz madde', async () => {
    await renderApp(<AssemblyDetailScreen id="as-0" />, { ...asOwner, routes: { ...contexts('owner'), 'GET /api/portal/assemblies/as-0': heldAssembly() } });
    expect(await screen.findByText('Toplantı yeter sayısı sağlandı (18/24 kat maliki).')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Gündem ve kararlar' })).toBeTruthy();
    expect(screen.getByText('Kabul edildi')).toBeTruthy();
    expect(screen.getByText('Reddedildi')).toBeTruthy();
    expect(screen.getByText('Kabul 14 oy — Ret 3 oy — Çekimser 1 oy')).toBeTruthy();
    expect(
      screen.getByText(
        'Kabul 9 oy · 9 kat maliki · 9 bölüm · arsa payı %37,50 — Ret 8 oy · 8 kat maliki · 8 bölüm · arsa payı %33,33 — Çekimser 1 oy · 1 kat maliki · 1 bölüm · arsa payı %4,17 · karar kaydı düzeltildi',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Bu madde için karar kaydı yok.')).toBeTruthy();
  });

  it('tutanak PDF: 5 dk imzali link istenir ve sistem goruntuleyicisinde acilir', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { calls } = await renderApp(<AssemblyDetailScreen id="as-0" />, {
      ...asOwner,
      routes: {
        ...contexts('owner'),
        'GET /api/portal/assemblies/as-0': heldAssembly(),
        'GET /api/portal/assemblies/as-0/minutes': { url: 'https://s3.test/tutanak.pdf?sig=1', fileName: 'tutanak.pdf', contentType: 'application/pdf', expiresAt: '2026-11-28T09:05:00.000Z' },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Tutanağı görüntüle (PDF)' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://s3.test/tutanak.pdf?sig=1'));
    expect(calls.filter((c) => c.path === '/api/portal/assemblies/as-0/minutes')).toHaveLength(1);
  });

  it('tutanak alinamazsa Turkce hata', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await renderApp(<AssemblyDetailScreen id="as-0" />, { ...asOwner, routes: { ...contexts('owner'), 'GET /api/portal/assemblies/as-0': heldAssembly() } });
    await fireEvent.press(await screen.findByRole('button', { name: 'Tutanağı görüntüle (PDF)' }));
    expect(await screen.findByText('Kayıt bulunamadı.')).toBeTruthy();
  });

  it('iptal edilen toplanti: gerekce, tutanak yok', async () => {
    await renderApp(<AssemblyDetailScreen id="as-1" />, {
      ...asOwner,
      routes: { ...contexts('owner'), 'GET /api/portal/assemblies/as-1': assembly({ status: 'cancelled', phase: 'cancelled', cancelReason: 'Salon kullanılamıyor' }) },
    });
    expect(await screen.findByText('Toplantı iptal edildi: Salon kullanılamıyor')).toBeTruthy();
    expect(screen.getByText('Toplantı iptal edildi.')).toBeTruthy();
  });
});
