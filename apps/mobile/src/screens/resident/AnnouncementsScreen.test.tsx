import { fireEvent, screen } from '@testing-library/react-native';
import { announcements } from '@/test/fixtures';
import { renderApp } from '@/test/renderApp';
import { AnnouncementDetailScreen } from './AnnouncementDetailScreen';
import { AnnouncementsScreen, excerpt } from './AnnouncementsScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

describe('Duyurular', () => {
  it('liste: baslik, Istanbul saatiyle tarih, onizleme; dokununca ayrinti', async () => {
    await renderApp(<AnnouncementsScreen />, { routes: { 'GET /api/portal/announcements': announcements(2) } });
    expect(await screen.findByText('Duyuru 1')).toBeTruthy();
    expect(screen.getByText('20 Kas 2026 09:00')).toBeTruthy();
    expect(screen.getByText('Duyuru 1 metni. İkinci satır.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Duyuru 2, 19 Kas 2026 09:00' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/resident/announcements/[id]', params: { id: 'an-2' } });
  });

  it('bos liste', async () => {
    await renderApp(<AnnouncementsScreen />, { routes: { 'GET /api/portal/announcements': { items: [] } } });
    expect(await screen.findByText('Güncel duyuru yok')).toBeTruthy();
  });

  it('ayrinti: tam metin; yayindan kalkmis duyuru icin bilgi', async () => {
    const routes = { 'GET /api/portal/announcements': announcements(2) };
    await renderApp(<AnnouncementDetailScreen id="an-2" />, { routes });
    expect(await screen.findByText('Duyuru 2')).toBeTruthy();
    expect(screen.getByText('Duyuru 2 metni.\nİkinci satır.')).toBeTruthy();

    await renderApp(<AnnouncementDetailScreen id="yok" />, { routes });
    expect(await screen.findByText('Duyuru bulunamadı')).toBeTruthy();
  });

  it('onizleme uzun metni kisaltir', () => {
    expect(excerpt('a  b\n\nc')).toBe('a b c');
    expect(excerpt('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
