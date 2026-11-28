import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { palettes } from '@/theme/tokens';
import type { NotificationData, NotificationTap, NotificationsAdapter, PermissionState } from './types';

/*
 * expo-notifications baglantisi (native). Android kanallari API ile ayni kimliklerle
 * (apps/api/src/modules/notifications/push-templates.ts ANDROID_CHANNELS): olmayan kanaldaki bildirim
 * gosterilmez. On planda gelen bildirim, oturum ve apartman uygunsa afis + listede gosterilir;
 * Android'de ses kapaliyken afis cikmadigi icin ses acik.
 */

const toPermission = (p: Notifications.NotificationPermissionsStatus): PermissionState => ({
  status: p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined',
  canAskAgain: p.canAskAgain,
});

const dataOf = (n: Notifications.Notification): NotificationData => (n.request.content.data ?? {}) as NotificationData;
const toTap = (r: Notifications.NotificationResponse): NotificationTap => ({ id: r.notification.request.identifier, data: dataOf(r.notification) });

function readProjectId(): string | undefined {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  const id = typeof fromConfig === 'string' && fromConfig ? fromConfig : Constants.easConfig?.projectId;
  return typeof id === 'string' && id ? id : undefined;
}

let channels: Promise<void> | null = null;
let showRule: (data: NotificationData) => boolean = () => false;

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
  getTokens: async (projectId) => {
    const device = await Notifications.getDevicePushTokenAsync();
    const expo = await Notifications.getExpoPushTokenAsync({ projectId, devicePushToken: device });
    return { expo: expo.data, device: String(device.data) };
  },
  onTokenChange: (listener) => {
    const sub = Notifications.addPushTokenListener((t) => listener(String(t.data)));
    return () => sub?.remove?.();
  },
  unregisterDevice: () => Notifications.unregisterForNotificationsAsync(),
  configure: (shouldShow) => {
    showRule = shouldShow;
    Notifications.setNotificationHandler({
      handleNotification: async (n) => {
        const show = showRule(dataOf(n));
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
    channels ??= (async () => {
      if (Platform.OS !== 'android') return;
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
    })().catch(() => {
      channels = null;
    });
    return channels;
  },
  onTap: (listener) => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => listener(toTap(r)));
    return () => sub?.remove?.();
  },
  lastTap: async () => {
    const r = await Notifications.getLastNotificationResponseAsync();
    return r ? toTap(r) : null;
  },
  clearLastTap: () => {
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  },
  onReceived: (listener) => {
    const sub = Notifications.addNotificationReceivedListener((n) => listener(dataOf(n)));
    return () => sub?.remove?.();
  },
  openSettings: () => Linking.openSettings(),
};
