import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Cevrimdisi = cihazin agi yok (ucak modu, Wi-Fi ve hucresel kapali). Internete ulasilabilirlik yoklamasi
 * (ucuncu taraf adrese periyodik istek) kapali: bagli ama internetsiz agda istekler bugunku gibi "Sunucuya
 * ulaşılamadı" ile doner; yanlis "çevrimdışı" yuzunden yazimlar engellenmez.
 */
export const isOnlineState = (state: Pick<NetInfoState, 'isConnected'>): boolean => state.isConnected !== false;

/** NetInfo -> React Query `onlineManager` (kok yerlesimde bir kez). Web'de React Query'nin kendi dinleyicisi. */
export function connectOnlineManager(): void {
  NetInfo.configure({ reachabilityShouldRun: () => false });
  onlineManager.setEventListener((setOnline) => NetInfo.addEventListener((state) => setOnline(isOnlineState(state))));
}

export function useReactQueryNetwork(): void {
  useEffect(() => {
    if (Platform.OS !== 'web') connectOnlineManager();
  }, []);
}

/** Cihaz cevrim ici mi (onlineManager). */
export function useIsOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}
