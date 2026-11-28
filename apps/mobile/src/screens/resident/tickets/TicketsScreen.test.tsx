import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { renderApp } from '@/test/renderApp';
import { portalTicket } from './ticketFixtures';
import { TicketsScreen } from './TicketsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => jest.clearAllMocks());

const list = (items: unknown[]) => ({ items, total: items.length });

describe('Talepler', () => {
  it('acik talepler: onayimi bekleyen en ustte ve rozetli; dokununca ayrinti', async () => {
    const { calls } = await renderApp(<TicketsScreen />, {
      routes: {
        'GET /api/portal/tickets': ({ query }: { query: Record<string, string> }) =>
          query.status?.includes('open')
            ? list([portalTicket('1', 'assigned'), portalTicket('2', 'resolved', { actions: ['confirm', 'reopen'], location: { kind: 'common', area: 'B blok asansörü' } })])
            : list([]),
      },
    });
    const rows = await screen.findAllByRole('button', { name: /^Talep \d/ });
    // Onay bekleyen (2) once listelenir.
    expect(rows[0]?.props.accessibilityLabel).toMatch(/^Talep 2, T-2 · Su \/ tesisat · 25 Kas 2026, onayınızı bekliyor$/);
    expect(within(rows[0]!).getByText('Onayınızı bekliyor')).toBeTruthy();
    expect(within(rows[0]!).getByText('Ortak alan · B blok asansörü')).toBeTruthy();
    expect(within(rows[1]!).getByText('Atandı')).toBeTruthy();
    expect(calls[calls.length - 1]?.query).toMatchObject({ status: 'open,assigned,in_progress,on_hold,resolved', limit: '100' });

    await fireEvent.press(rows[1]!);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/resident/tickets/[id]', params: { id: '1' } });
  });

  it('Kapanan: kapali + iptal durumlari istenir; bos durum', async () => {
    const { calls } = await renderApp(<TicketsScreen />, { routes: { 'GET /api/portal/tickets': list([]) } });
    expect(await screen.findByText('Açık talebiniz yok')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Kapanan' }));
    expect(await screen.findByText('Kapanmış talep yok')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kapanan', selected: true })).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/portal/tickets' && c.query.status === 'closed,cancelled')).toBe(true);
  });

  it('"Yeni talep" sihirbazi acar', async () => {
    await renderApp(<TicketsScreen />, { routes: { 'GET /api/portal/tickets': list([]) } });
    await fireEvent.press(await screen.findByRole('button', { name: 'Yeni talep' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/resident/tickets/new');
  });

  it('sunucu hatasi Turkce gosterilir; tekrar dene listeyi getirir', async () => {
    let fail = true;
    await renderApp(<TicketsScreen />, {
      routes: { 'GET /api/portal/tickets': () => (fail ? { status: 500, body: { error: 'internal' } } : list([portalTicket('1', 'open')])) },
    });
    expect(await screen.findByText('Sunucuda beklenmeyen bir hata oluştu.')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(screen.getByText('Talep 1')).toBeTruthy());
  });
});
