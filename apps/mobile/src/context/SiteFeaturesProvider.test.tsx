import { FEATURE_KEYS, type FeatureKey, featureMapOf } from '@bm/shared/features/catalog';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { FEATURE_KEYS as API_KEYS } from '../../../api/src/modules/features/catalog';
import { FEATURE_KEYS as WEB_KEYS } from '../../../web/src/lib/features/catalog';
import { FeatureGate } from '@/components/FeatureGate';
import { CalendarDays, Gauge } from '@/components/icons';
import { type WebFeature, moreItemForRoute, residentMoreFor } from '@/lib/nav';
import { AccountScreen } from '@/screens/account/AccountScreen';
import { DuesScreen } from '@/screens/resident/DuesScreen';
import { quote, statement, summary } from '@/test/fixtures';
import { renderApp } from '@/test/renderApp';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

/** `GET /api/site-features`: verilen anahtarlar kapali, digerleri acik. */
const siteFeatures = (off: FeatureKey[] = []) => ({
  apartmentId: 'apt-dev-1',
  version: 3,
  profile: 'simple',
  inherited: false,
  overrides: {},
  features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, !off.includes(k)])),
  catalog: [{ key: 'payments.online', label: 'Online aidat ödemesi', description: '' }],
});

const duesRoutes = {
  'GET /api/portal/my-summary': summary(),
  'GET /api/portal/my-statement': statement(3),
  'GET /api/portal/payments/quote': quote(true),
};
const prefsRoute = { 'GET /api/me/notification-preferences': { email: { enabled: true } } };

describe('site ozellikleri (Adim 1)', () => {
  it('anahtar listesi API ve web katalogu ile ayni', () => {
    expect([...FEATURE_KEYS]).toEqual([...API_KEYS]);
    expect([...FEATURE_KEYS]).toEqual([...WEB_KEYS]);
  });

  it('yanitta olmayan / true olmayan anahtar kapali; bilinmeyen anahtar yok sayilir', () => {
    const map = featureMapOf({ features: { 'payments.online': true, 'resident.mfa': false, 'future.key': true } });
    expect(map['payments.online']).toBe(true);
    expect(map['resident.mfa']).toBe(false);
    expect(map['resident.restructure']).toBe(false);
    expect(Object.keys(map)).toEqual([...FEATURE_KEYS]);
  });

  it('"Diğer": kapali ozellige bagli oge gizlenir; ekran yolu ogeye eslenir', () => {
    const items: WebFeature[] = [
      { key: 'rezervasyon', label: 'Rezervasyon', icon: CalendarDays, webPath: '/app/rezervasyon', description: '', route: '/resident/reservations' },
      { key: 'tuketim', label: 'Tüketimim', icon: Gauge, webPath: '/app/tuketim', description: '', route: '/resident/consumption', feature: 'resident.expenseChart' },
      { key: 'rapor', label: 'Rapor', icon: Gauge, webPath: '/app/rapor', description: '', feature: 'payments.online' },
    ];
    const off = (k: FeatureKey) => k !== 'resident.expenseChart';
    expect(residentMoreFor(true, items, off).map((i) => i.key)).toEqual(['rezervasyon', 'rapor']);
    expect(residentMoreFor(true, items).map((i) => i.key)).toEqual(['rezervasyon', 'tuketim', 'rapor']);
    expect(moreItemForRoute('consumption', undefined, items)?.key).toBe('tuketim');
    expect(moreItemForRoute('reservations/[facilityId]', { facilityId: 'f1' }, items)?.key).toBe('rezervasyon');
    expect(moreItemForRoute('reservations/index', undefined, items)?.key).toBe('rezervasyon');
    expect(moreItemForRoute('web/[feature]', { feature: 'rapor' }, items)?.key).toBe('rapor');
    expect(moreItemForRoute('tickets/[id]', { id: 't1' }, items)).toBeUndefined();
  });

  it('online odeme kapali: "Online öde" yok, odeme sorgusu hic gonderilmez, elden / havale notu', async () => {
    const { calls } = await renderApp(<DuesScreen />, { siteFeatures: true, routes: { ...duesRoutes, 'GET /api/site-features': siteFeatures(['payments.online']) } });
    expect(await screen.findByText('₺3.000,00')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/site-features')).toBe(true));
    expect(screen.queryByRole('link', { name: 'Online öde' })).toBeNull();
    expect(calls.some((c) => c.path === '/api/portal/payments/quote')).toBe(false);
  });

  it('online odeme acik: dugme gorunur', async () => {
    await renderApp(<DuesScreen />, { siteFeatures: true, routes: { ...duesRoutes, 'GET /api/site-features': siteFeatures() } });
    expect(await screen.findByRole('link', { name: 'Online öde' })).toBeTruthy();
  });

  it('ozellikler okunamazsa kapali sayilir (fail closed)', async () => {
    const { calls } = await renderApp(<DuesScreen />, { siteFeatures: true, routes: { ...duesRoutes, 'GET /api/site-features': { status: 403, body: { error: 'forbidden' } } } });
    expect(await screen.findByText('₺3.000,00')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/site-features')).toBe(true));
    expect(screen.queryByRole('link', { name: 'Online öde' })).toBeNull();
  });

  it('sakin Hesabım: bildirim tercihleri kapaliyken tercih anahtarlari yok, yalnizca telefonun bildirim izni', async () => {
    const { calls } = await renderApp(<AccountScreen />, { siteFeatures: true, routes: { ...prefsRoute, 'GET /api/site-features': siteFeatures(['resident.notificationPrefs']) } });
    expect(await screen.findByRole('header', { name: 'Bildirimler' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'E-posta bildirimleri' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Mobil bildirimler' })).toBeNull();
    expect(screen.getByText(/Bu derlemede mobil bildirim kaydı yapılamıyor/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/me/notification-preferences')).toBe(false);
  });

  it('sakin Hesabım: tercihler aciksa kartlar gorunur', async () => {
    await renderApp(<AccountScreen />, { siteFeatures: true, routes: { ...prefsRoute, 'GET /api/site-features': siteFeatures() } });
    expect(await screen.findByRole('switch', { name: 'E-posta bildirimleri' })).toBeTruthy();
  });

  it('gorevli Hesabım: sakin anahtari kapali olsa da tercihler gorunur', async () => {
    await renderApp(<AccountScreen />, { email: 'building_staff@dev.local', withUnit: false, siteFeatures: true, routes: { ...prefsRoute, 'GET /api/site-features': siteFeatures(['resident.notificationPrefs']) } });
    expect(await screen.findByRole('switch', { name: 'E-posta bildirimleri' })).toBeTruthy();
  });

  it('kapali ozellige bagli ekran: sade not; aciksa ekranin kendisi', async () => {
    await renderApp(
      <FeatureGate feature="resident.expenseChart" title="Tüketimim">
        <Text>Ekran içeriği</Text>
      </FeatureGate>,
      { siteFeatures: true, routes: { 'GET /api/site-features': siteFeatures(['resident.expenseChart']) } },
    );
    expect(await screen.findByText('Bu özellik sitenizde kapalı. Açılmasını isterseniz site yönetiminize söyleyebilirsiniz.')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Tüketimim' })).toBeTruthy();
    expect(screen.queryByText('Ekran içeriği')).toBeNull();
  });

  it('ozellikler okunamazsa ekranda "Tekrar dene"; tekrar okununca acik ekran gelir', async () => {
    let fail = true;
    await renderApp(
      <FeatureGate feature="payments.online">
        <Text>Ekran içeriği</Text>
      </FeatureGate>,
      { siteFeatures: true, routes: { 'GET /api/site-features': () => (fail ? { status: 500, body: { error: 'x' } } : siteFeatures()) } },
    );
    expect(await screen.findByText('Bilgiler şu an yüklenemedi. Biraz sonra tekrar deneyin.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Online aidat ödemesi' })).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(await screen.findByText('Ekran içeriği')).toBeTruthy();
  });
});
