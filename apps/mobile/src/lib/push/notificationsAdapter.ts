import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { palettes } from '@/theme/tokens';
import type { NotificationTap, NotificationsAdapter, PermissionState } from './types';

/*
 * expo-notifications baglantisi (native). Android kanallari API ile ayni kimliklerle
 * (apps/api/src/modules/notifications/push-templates.ts ANDROID_CHANNELS): olmayan kanaldaki bildirim
 * gosterilmez. On planda gelen bildirim de afis + listede gosterilir; Android'de ses kapaliyken afis
 * cikmadigi icin ses acik.
 */

const toPermission = (p: Notifications.NotificationPermissionsStatus): PermissionState => ({
  status: p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined',
  canAskAgain: p.canAskAgain,
});

const toTap = (r: Notifications.NotificationResponse): NotificationTap => ({
  id: r.notification.request.identifier,
  data: (r.notification.request.content.data ?? {}) as NotificationTap['data'],
});

function readProjectId(): string | undefined {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  const id = typeof fromConfig === 'string' && fromConfig ? fromConfig : Constants.easConfig?.projectId;
  return typeof id === 'string' && id ? id : undefined;
}

let configured: Promise<void> | null = null;

export const notificationsAdapter: NotificationsAdapter = {
  support: () => (Device.isDevice ? 'ok' : 'simulator'),
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  projectId: readProjectId,
  appVersion: () => Constants.expoConfig?.version ?? undefined,
  locale: () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
    } catch {
      return undefined;
    }
  },
  getPermission: async () => toPermission(await Notifications.getPermissionsAsync()),
  requestPermission: async () => toPermission(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } })),
  getExpoToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  onTokenChange: (listener) => {
    const sub = Notifications.addPushTokenListener(() => listener());
    return () => sub?.remove?.();
  },
  configure: () => {
    configured ??= (async () => {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
      });
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Genel bildirimler',
          importance: Notifications.AndroidImportance.DEFAULT,
          lightColor: palettes.light.accent,
        });
        await Notifications.setNotificationChannelAsync('gate', {
          name: 'Kapı ve kurye',
          description: 'Kapıdaki kurye onayı ve misafir girişi',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 150, 250],
          lightColor: palettes.light.brandOrange,
        });
      }
    })().catch(() => {
      configured = null;
    });
    return configured;
  },
  onTap: (listener) => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => listener(toTap(r)));
    return () => sub?.remove?.();
  },
  lastTap: async () => {
    const r = await Notifications.getLastNotificationResponseAsync();
    // Islenen yanit temizlenir: sonraki acilista ayni bildirim yeniden acilmaz.
    if (r) void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    return r ? toTap(r) : null;
  },
  onReceived: (listener) => {
    const sub = Notifications.addNotificationReceivedListener((n) => listener((n.request.content.data ?? {}) as NotificationTap['data']));
    return () => sub?.remove?.();
  },
  openSettings: () => Linking.openSettings(),
};
