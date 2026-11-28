import { fireEvent, screen } from '@testing-library/react-native';
import { poll } from '@/test/pollFixtures';
import { renderApp } from '@/test/renderApp';
import { PollsScreen } from './PollsScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

beforeEach(() => mockPush.mockClear());

describe('Oylamalar', () => {
  it('durum rozetleri web kuraliyla: oyunuzu bekliyor, oy verdiniz, paydas oyu, oy hakki yok, bitti', async () => {
    await renderApp(<PollsScreen />, {
      routes: {
        'GET /api/portal/polls': {
          unitId: 'u-3',
          items: [
            poll({ pollId: 'p1', title: 'Bekleyen' }),
            poll({ pollId: 'p2', title: 'Verilen', myVote: { castByMe: true, optionId: 'o1' } }),
            poll({ pollId: 'p3', title: 'Paydaş', myVote: { castByMe: false } }),
            poll({ pollId: 'p4', title: 'Hakkı yok', eligible: false, canVote: false }),
            poll({ pollId: 'p5', title: 'Biten', phase: 'closed', canVote: false, resultsAvailable: true, closedAt: '2026-11-12T07:00:00.000Z' }),
          ],
        },
      },
    });
    expect(await screen.findByRole('button', { name: /^Bekleyen, Kat malikleri, Bitiş: .*, Oyunuzu bekliyor$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Verilen, .*Oy verdiniz$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Paydaş, .*Dairenizin oyu kullanıldı$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Hakkı yok, .*Oy hakkınız yok$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Biten, Kat malikleri, Sona erdi: 12 Kas 2026 10:00, Sona erdi, sonuçlar açıklandı$/ })).toBeTruthy();
    expect(screen.getByText('Sonuçlar açıklandı')).toBeTruthy();
  });

  it('dokununca ayrinti ekrani acilir', async () => {
    await renderApp(<PollsScreen />, { routes: { 'GET /api/portal/polls': { unitId: 'u-3', items: [poll()] } } });
    await fireEvent.press(await screen.findByRole('button', { name: /^Asansör yenilensin mi\?/ }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/resident/polls/[id]', params: { id: 'p1' } });
  });

  it('oylama yoksa bos durum', async () => {
    await renderApp(<PollsScreen />, { routes: { 'GET /api/portal/polls': { unitId: 'u-3', items: [] } } });
    expect(await screen.findByText('Açık oylama yok')).toBeTruthy();
  });

  it('birden fazla daire: daire secici (portalin ortak hata durumu)', async () => {
    await renderApp(<PollsScreen />, {
      routes: {
        'GET /api/portal/polls': {
          status: 409,
          body: { error: 'unit_selection_required', message: 'Daire seçin', units: [{ unitId: 'u-3', label: 'A Blok · Daire 3', relationLabel: 'Malik' }, { unitId: 'u-9', label: 'B Blok · Daire 9' }] },
        },
      },
    });
    expect(await screen.findByText('Daire seçin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'A Blok · Daire 3, Malik' })).toBeTruthy();
  });
});
