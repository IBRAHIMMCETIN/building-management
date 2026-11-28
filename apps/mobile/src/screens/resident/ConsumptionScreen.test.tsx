import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { history, period } from '@/test/consumptionFixtures';
import { summary } from '@/test/fixtures';
import { renderApp } from '@/test/renderApp';
import { ConsumptionScreen } from './ConsumptionScreen';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

const routes = (periods = [period()]) => ({
  'GET /api/portal/my-summary': summary(),
  'GET /api/portal/meters/consumption': ({ query }: { query: Record<string, string> }) => history(periods, query.unitId),
});

describe('Tüketimim', () => {
  it('daire ozetten alinir (API unitId zorunlu); karsilastirma kartlari ve onceki doneme gore degisim', async () => {
    const { calls } = await renderApp(<ConsumptionScreen />, { routes: routes() });
    expect(await screen.findByLabelText('Sizin tüketiminiz, Kasım 2026: 120. Önceki döneme göre +%20')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/portal/meters/consumption')?.query).toEqual({ unitId: 'u-3' });
    // Bina: +%20 (uyari tonu), blok: -%20; sayacli daire sayisi.
    expect(screen.getByLabelText('Bina ortalaması: 100. Siz: +%20. 22 sayaçlı daire')).toBeTruthy();
    expect(screen.getByLabelText('Blok ortalaması: 150. Siz: -%20')).toBeTruthy();
  });

  it('donem karti: tutar, ortak / tuketim payi, sayac tuketimleri, toplam; tek donemde gecmis cubugu yok', async () => {
    await renderApp(<ConsumptionScreen />, { routes: routes() });
    expect(await screen.findByLabelText('Tutar ₺1.000,00')).toBeTruthy();
    expect(screen.getByText('Isınma · 1 Kas 2026 – 30 Kas 2026 · son ödeme 10 Ara 2026')).toBeTruthy();
    expect(screen.getByLabelText('Ortak pay: ₺300,00')).toBeTruthy();
    expect(screen.getByLabelText('Tüketim payı: ₺700,00')).toBeTruthy();
    expect(screen.getByLabelText('Salon: 80,5')).toBeTruthy();
    expect(screen.getByLabelText('Toplam tüketim: 120,5')).toBeTruthy();
    expect(screen.queryByText('Dönem dönem tüketim')).toBeNull();
  });

  it('birden fazla donem: gecmis cubuklari degerleri ekran okuyucuya verir; gider turu secimi', async () => {
    await renderApp(<ConsumptionScreen />, {
      routes: routes([
        period(),
        period({ periodId: 'mp-10', name: 'Ekim 2026', consumption: 100, previous: undefined, estimated: true }),
        period({ periodId: 'mw-11', name: 'Kasım 2026 su', category: 'hot_water', meterKind: 'hot_water', consumption: 3.4, buildingAverage: 3, blockAverage: undefined, previous: undefined }),
      ]),
    });
    expect(await screen.findByLabelText('Kasım 2026: 120, bina ortalaması 100')).toBeTruthy();
    expect(screen.getByLabelText('Ekim 2026: 100, bina ortalaması 100')).toBeTruthy();
    expect(screen.getByText('Bu dönem okuma yapılamadığı için yönetici onaylı tahmini endeks kullanıldı.')).toBeTruthy();

    const water = screen.getByRole('radio', { name: 'Sıcak su' });
    expect(screen.getByRole('radio', { name: 'Isınma' }).props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.press(water);
    expect(await screen.findByLabelText('Sizin tüketiminiz, Kasım 2026 su: 3,4')).toBeTruthy();
    expect(screen.queryByLabelText(/^Ekim 2026:/)).toBeNull();
    expect(screen.queryByText(/Blok ortalaması/)).toBeNull();
  });

  it('sayaci olmayan daire: yalnizca ortak pay', async () => {
    await renderApp(<ConsumptionScreen />, { routes: routes([period({ hasMeter: false, meters: [], consumption: 0 })]) });
    expect(await screen.findByText('Dairenizde sayaç olmadığı için yalnızca ortak pay yansıtıldı.')).toBeTruthy();
    expect(screen.getByLabelText('Sizin tüketiminiz, Kasım 2026: —. Önceki döneme göre +%20')).toBeTruthy();
  });

  it('Sayaç Dağıtım Dökümü: imzali link istenir ve sistem goruntuleyicisinde acilir', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { calls } = await renderApp(<ConsumptionScreen />, {
      routes: {
        ...routes(),
        'GET /api/portal/meters/statement/mp-11': { url: 'https://s3.test/dokum.pdf?sig=1', fileName: 'dokum.pdf', contentType: 'application/pdf', expiresAt: '2026-11-28T09:05:00.000Z' },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Kasım 2026 Sayaç Dağıtım Dökümü (PDF)' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://s3.test/dokum.pdf?sig=1'));
    expect(calls.find((c) => c.path === '/api/portal/meters/statement/mp-11')?.query).toEqual({ unitId: 'u-3' });
  });

  it('secili daire (birden fazla daire): tuketim ve dokum o daire icin istenir', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await AsyncStorage.setItem('bm.portal-unit.mock-resident.apt-dev-1', 'u-9');
    try {
      const { calls } = await renderApp(<ConsumptionScreen />, {
        routes: {
          ...routes(),
          'GET /api/portal/meters/statement/mp-11': { url: 'https://s3.test/dokum.pdf?sig=2', fileName: 'dokum.pdf', contentType: 'application/pdf', expiresAt: '2026-11-28T09:05:00.000Z' },
        },
      });
      await fireEvent.press(await screen.findByRole('button', { name: 'Kasım 2026 Sayaç Dağıtım Dökümü (PDF)' }));
      await waitFor(() => expect(calls.some((c) => c.path === '/api/portal/meters/statement/mp-11')).toBe(true));
      expect(calls.find((c) => c.path === '/api/portal/meters/consumption')?.query).toEqual({ unitId: 'u-9' });
      expect(calls.find((c) => c.path === '/api/portal/meters/statement/mp-11')?.query).toEqual({ unitId: 'u-9' });
      expect(calls.find((c) => c.path === '/api/portal/my-summary')?.query).toEqual({ unitId: 'u-9' });
    } finally {
      await AsyncStorage.clear();
    }
  });

  it('onaylanmis donem yoksa bos durum', async () => {
    await renderApp(<ConsumptionScreen />, { routes: routes([]) });
    expect(await screen.findByText('Henüz onaylanmış bir sayaç dağıtım dönemi yok')).toBeTruthy();
  });

  it('daireye atanmamis sakin: ozetteki uyelik hatasi gosterilir', async () => {
    await renderApp(<ConsumptionScreen />, { routes: { 'GET /api/portal/my-summary': { status: 403, body: { error: 'forbidden' } } } });
    expect(await screen.findByText('Henüz bir daireye atanmadınız')).toBeTruthy();
  });
});
