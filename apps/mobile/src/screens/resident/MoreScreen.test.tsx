import { fireEvent, screen } from '@testing-library/react-native';
import { TabButton } from '@/navigation/TabButton';
import { renderApp } from '@/test/renderApp';
import { Text } from 'react-native';
import { createDemoFetch } from '@/dev/demoApi';
import { issueMockToken } from '@bm/shared/auth/mockScenarios';
import { MoreScreen } from './MoreScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const contexts = (relation: 'owner' | 'tenant') => ({
  userId: 'mock-resident',
  email: 'resident@dev.local',
  isPlatformAdmin: false,
  active: { role: 'resident', apartmentId: 'apt-dev-1' },
  contexts: [{ apartmentId: 'apt-dev-1', apartmentName: 'Geliştirme Sitesi', role: 'resident', units: [{ unitId: 'u-7', unitNumber: '7', relation }] }],
});

describe('Diğer', () => {
  it('malik: Genel Kurul gorunur (web residentNavFor ile ayni)', async () => {
    await renderApp(<MoreScreen />, { env: { apiMode: 'demo' }, routes: { 'GET /api/me/contexts': contexts('owner') } });
    expect(await screen.findByRole('button', { name: /^Genel Kurul,/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ziyaretçi,/ })).toBeTruthy();
  });

  it('kiraci: Genel Kurul gizli', async () => {
    await renderApp(<MoreScreen />, { env: { apiMode: 'demo' }, routes: { 'GET /api/me/contexts': contexts('tenant') } });
    expect(await screen.findByRole('button', { name: /^Tüketimim,/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Genel Kurul,/ })).toBeNull();
  });

  it('yerel ekrani olanlar uygulama icinde, digerleri yer tutucuda acilir', async () => {
    await renderApp(<MoreScreen />, { env: { apiMode: 'demo' }, routes: { 'GET /api/me/contexts': contexts('owner') } });
    await fireEvent.press(await screen.findByRole('button', { name: /^Oylamalar,/ }));
    await fireEvent.press(screen.getByRole('button', { name: /^Genel Kurul,/ }));
    await fireEvent.press(screen.getByRole('button', { name: /^Tüketimim,/ }));
    await fireEvent.press(screen.getByRole('button', { name: /^İhaleler,/ }));
    expect(mockPush.mock.calls.map((c) => c[0])).toEqual(['/resident/polls', '/resident/assemblies', '/resident/consumption', '/resident/tenders']);
  });

  it('demo veri: sakin baglami ozetteki dairenin maliki (Ana Sayfa "Malik" ile tutarli)', async () => {
    const demo = createDemoFetch();
    const res = await demo('/api/me/contexts', { headers: { authorization: `Bearer ${issueMockToken('resident@dev.local')}` } });
    const body = JSON.parse(await res.text()) as ReturnType<typeof contexts>;
    expect(body.contexts[0]?.units).toEqual([{ unitId: 'u-demo-7', unitNumber: '7', relation: 'owner' }]);
  });
});

describe('alt sekme dugmesi', () => {
  it('sekme rolu (iOS: dugme) ve secili durum ekran okuyucuya verilir', async () => {
    await renderApp(
      <TabButton aria-label="Diğer" aria-selected onPress={() => undefined}>
        <Text>Diğer</Text>
      </TabButton>,
      { email: null, withUnit: false },
    );
    const tab = screen.getByLabelText('Diğer');
    expect(tab.props.accessibilityState).toEqual({ selected: true });
    expect(['tab', 'button']).toContain(tab.props.accessibilityRole);
  });
});
