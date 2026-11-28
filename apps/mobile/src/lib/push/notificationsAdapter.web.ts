import type { NotificationsAdapter } from './types';

/*
 * Web onizlemesi: Expo push token'i (ExponentPushToken) yalnizca iOS / Android derlemesinde alinir.
 * Kayit, izin istemi ve bildirime dokunma burada calismaz; Hesabım bunu acikca soyler.
 */
const none = () => () => undefined;

export const notificationsAdapter: NotificationsAdapter = {
  support: () => 'web',
  platform: 'web',
  projectId: () => undefined,
  appVersion: () => undefined,
  locale: () => undefined,
  getPermission: async () => ({ status: 'denied', canAskAgain: false }),
  requestPermission: async () => ({ status: 'denied', canAskAgain: false }),
  getExpoToken: async () => {
    throw new Error('Web önizlemesinde mobil bildirim yok');
  },
  onTokenChange: none,
  configure: async () => undefined,
  onTap: none,
  lastTap: async () => null,
  onReceived: none,
  openSettings: async () => undefined,
};
