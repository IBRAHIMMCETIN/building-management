import { focusManager, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { useAuth } from '@/context/AuthProvider';
import { portalKeys } from './usePortal';

/**
 * React Query odak durumu uygulamanin on planda olmasina baglanir (native'de pencere odagi yok; web
 * onizlemesinde React Query kendi gorunurluk dinleyicisini kullanir). Kok yerlesimde bir kez.
 */
export function useReactQueryAppState(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    focusManager.setEventListener((setFocused) => {
      const sub = AppState.addEventListener('change', (state) => setFocused(state === 'active'));
      return () => sub.remove();
    });
  }, []);
}

/** Uygulama arka plandan (veya tarayici sekmesinden) one gelince `onForeground` cagrilir. */
export function useOnForeground(onForeground: () => void): void {
  const callback = useRef(onForeground);
  callback.current = onForeground;
  useEffect(() => {
    let last: AppStateStatus | null | undefined = AppState.currentState as AppStateStatus | null | undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (last !== 'active' && next === 'active') callback.current();
      last = next;
    });
    return () => sub.remove();
  }, []);
}

/**
 * Sakin alani: uygulama one gelince borc / hareket / duyuru verisi yenilenir. Ozellikle Android'de web
 * odeme sayfasi (Custom Tabs) uygulamayi arka plana alir; odemeden donunce bakiye guncellenir.
 */
export function PortalForegroundRefresh(): null {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  useOnForeground(() => {
    if (user?.apartmentId) void queryClient.invalidateQueries({ queryKey: portalKeys.all(user.apartmentId, user.sub) });
  });
  return null;
}
