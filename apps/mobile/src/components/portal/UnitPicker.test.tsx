import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { renderApp } from '@/test/renderApp';
import { UnitPicker } from './UnitPicker';

function Selected() {
  const { unitId } = usePortalUnit();
  return <Text>{`secili: ${unitId ?? 'yok'}`}</Text>;
}

const contexts = (units: Array<{ unitId: string; unitNumber: string; relation: 'owner' | 'tenant' }>) => ({
  userId: 'mock-resident',
  email: 'resident@dev.local',
  isPlatformAdmin: false,
  active: { role: 'resident', apartmentId: 'apt-dev-1' },
  contexts: [{ apartmentId: 'apt-dev-1', apartmentName: 'Geliştirme Sitesi', role: 'resident', units }],
});

describe('Daire secici (ust cubuk)', () => {
  it('birden fazla dairede gorunur; secim saklanir', async () => {
    await renderApp(
      <>
        <UnitPicker />
        <Selected />
      </>,
      {
        // cognito modunda baglamlar API'den gelir (/api/me/contexts)
        env: { authMode: 'cognito' },
        routes: { 'GET /api/me/contexts': contexts([{ unitId: 'u-3', unitNumber: '3', relation: 'owner' }, { unitId: 'u-12', unitNumber: '12', relation: 'tenant' }]) },
      },
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Daire seçin' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Daire 12, Kiracı' }));
    expect(screen.getByText('secili: u-12')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Seçili daire: Daire 12. Daire değiştir' })).toBeTruthy();
  });

  it('tek dairede gizlidir', async () => {
    await renderApp(<UnitPicker />, {
      env: { authMode: 'cognito' },
      routes: { 'GET /api/me/contexts': contexts([{ unitId: 'u-3', unitNumber: '3', relation: 'owner' }]) },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Daire/ })).toBeNull();
  });
});
