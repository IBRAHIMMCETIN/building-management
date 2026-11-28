import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { accessibleAncestors } from '@/test/a11y';
import { renderApp } from '@/test/renderApp';
import { Button, TextField } from '@/components/ui';
import { DateField } from './DateField';
import { Sheet } from './Sheet';
import { UnitPicker } from './UnitPicker';

function Harness() {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('');
  return (
    <>
      <Button label="Aç" onPress={() => setOpen(true)} />
      <Sheet open={open} title="Deneme penceresi" onClose={() => setOpen(false)}>
        <TextField label="Ad" value={name} onChangeText={setName} />
        <DateField label="Tarih" value="2026-11-28" min="2026-11-28" max="2026-12-31" onChange={() => undefined} />
        <Button label="Kaydet" onPress={() => undefined} />
      </Sheet>
    </>
  );
}

describe('Sheet / daire secici erisilebilirligi', () => {
  it('pencere icindeki kontroller ekran okuyucuyla tek tek ulasilabilir (karartma tum pencereyi tek oge yapmaz)', async () => {
    await renderApp(<Harness />, { email: null, withUnit: false });
    for (const el of [
      screen.getByRole('header', { name: 'Deneme penceresi' }),
      screen.getByRole('button', { name: 'Kapat' }),
      screen.getByLabelText('Ad'),
      screen.getByRole('button', { name: /^Tarih: / }),
      screen.getByRole('button', { name: 'Kaydet' }),
    ]) {
      expect(accessibleAncestors(el)).toEqual([]);
    }
    // Tek "Kapat" ogesi: basliktaki dugme (karartma ekran okuyucudan gizli).
    expect(screen.getAllByRole('button', { name: 'Kapat' })).toHaveLength(1);

    // Ic ice pencere (takvim) icindeki gunler de ulasilabilir.
    await fireEvent.press(screen.getByRole('button', { name: /^Tarih: / }));
    const day = screen.getByRole('button', { name: '30 Kasım 2026 Pazartesi' });
    expect(accessibleAncestors(day)).toEqual([]);

    await fireEvent.press(screen.getAllByRole('button', { name: 'Kapat' })[0]!);
    expect(screen.queryByRole('header', { name: 'Deneme penceresi' })).toBeNull();
  });

  it('daire secici penceresindeki daireler ulasilabilir', async () => {
    await renderApp(<UnitPicker />, {
      env: { authMode: 'cognito' },
      routes: {
        'GET /api/me/contexts': {
          userId: 'mock-resident',
          email: 'resident@dev.local',
          isPlatformAdmin: false,
          active: { role: 'resident', apartmentId: 'apt-dev-1' },
          contexts: [
            {
              apartmentId: 'apt-dev-1',
              apartmentName: 'Geliştirme Sitesi',
              role: 'resident',
              units: [
                { unitId: 'u-3', unitNumber: '3', relation: 'owner' },
                { unitId: 'u-12', unitNumber: '12', relation: 'tenant' },
              ],
            },
          ],
        },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Daire seçin' }));
    for (const el of [screen.getByRole('button', { name: 'Daire 12, Kiracı' }), screen.getByRole('button', { name: 'Vazgeç' })]) {
      expect(accessibleAncestors(el)).toEqual([]);
    }
    expect(screen.queryByRole('button', { name: 'Kapat' })).toBeNull();
  });
});
