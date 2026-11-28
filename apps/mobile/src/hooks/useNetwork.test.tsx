import { NetworkError, errorMessage } from '@bm/shared/api/errors';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';
import { OFFLINE_BANNER_TEXT } from '@/components/OfflineBanner';
import { Screen } from '@/components/ui';
import { createApiClient } from '@/lib/api/createApiClient';
import { OFFLINE_MESSAGE, OfflineError } from '@/lib/api/offline';
import { AccountScreen } from '@/screens/account/AccountScreen';
import { renderApp } from '@/test/renderApp';
import { connectOnlineManager, isOnlineState, useOfflineAnnouncement } from './useNetwork';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

afterEach(async () => {
  await act(() => onlineManager.setOnline(true));
});

describe('cevrimdisi farkindaligi', () => {
  it('NetInfo -> onlineManager: yalnizca ag yoksa cevrimdisi; ulasilabilirlik yoklamasi kapali', () => {
    let emit: (s: { isConnected: boolean | null }) => void = () => undefined;
    (NetInfo.addEventListener as jest.Mock).mockImplementationOnce((fn) => {
      emit = fn;
      return () => undefined;
    });
    connectOnlineManager();
    const config = (NetInfo.configure as jest.Mock).mock.calls.at(-1)?.[0] as { reachabilityShouldRun: () => boolean };
    expect(config.reachabilityShouldRun()).toBe(false);
    emit({ isConnected: false });
    expect(onlineManager.isOnline()).toBe(false);
    emit({ isConnected: true });
    expect(onlineManager.isOnline()).toBe(true);
    // Durum henuz bilinmiyor (null): cevrim ici sayilir.
    expect(isOnlineState({ isConnected: null })).toBe(true);
  });

  it('API istemcisi: cevrimdisiyken yazan istek gonderilmez, okuma gider', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
    }) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: 'https://api.test', getToken: async () => 'tok', fetchImpl, isOnline: () => false });
    const err = await api.post('/api/portal/tickets', { title: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfflineError);
    expect(err).toBeInstanceOf(NetworkError);
    expect(errorMessage(err)).toBe(OFFLINE_MESSAGE);
    await expect(api.delete('/api/me/devices/d1')).rejects.toBeInstanceOf(OfflineError);
    await api.get('/api/portal/my-summary');
    expect(calls).toEqual(['GET https://api.test/api/portal/my-summary']);
  });

  it('iOS: cevrimdisina gecis VoiceOver\'a bir kez duyurulur', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    function Announcer() {
      useOfflineAnnouncement(OFFLINE_BANNER_TEXT);
      return null;
    }
    await renderApp(<Announcer />);
    expect(announce).not.toHaveBeenCalled();
    await act(() => onlineManager.setOnline(false));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(OFFLINE_BANNER_TEXT);
    announce.mockRestore();
  });

  it('cevrimdisi notu ekranin ustunde; baglanti gelince kalkar', async () => {
    await renderApp(
      <Screen title="Duyurular">
        <Text>İçerik</Text>
      </Screen>,
    );
    expect(screen.queryByText(OFFLINE_BANNER_TEXT)).toBeNull();
    await act(() => onlineManager.setOnline(false));
    expect(screen.getByText(OFFLINE_BANNER_TEXT)).toBeTruthy();
    await act(() => onlineManager.setOnline(true));
    expect(screen.queryByText(OFFLINE_BANNER_TEXT)).toBeNull();
  });

  it('cevrimdisiyken degisiklik gonderilmez ve acik mesaj gosterilir (Hesabım tercihi)', async () => {
    const { calls } = await renderApp(<AccountScreen />, {
      routes: { 'GET /api/me/notification-preferences': { email: { enabled: true } }, 'PUT /api/me/notification-preferences': { email: { enabled: true, finance: false } } },
    });
    const finance = await screen.findByRole('switch', { name: 'Aidat ve tahsilat' });
    await act(() => onlineManager.setOnline(false));
    await fireEvent(finance, 'valueChange', false);
    expect(await screen.findByText(OFFLINE_MESSAGE)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
    // Baglanti gelince ayni islem gider.
    await act(() => onlineManager.setOnline(true));
    await fireEvent(screen.getByRole('switch', { name: 'Aidat ve tahsilat' }), 'valueChange', false);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
  });
});
