/*
 * Mobil bildirim (push) - platform katmaninin sozlesmesi. Native: notificationsAdapter.ts
 * (expo-notifications + expo-device + app config), web onizlemesi: notificationsAdapter.web.ts
 * (desteklenmez). Testler sahte adapter verir.
 */

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';
export type PermissionState = { status: PermissionStatus; canAskAgain: boolean };

/** Bildirime eklenen veri (API push-templates.ts: `data: { url, apartmentId, type, category }`). */
export type NotificationData = { url?: unknown; apartmentId?: unknown; type?: unknown; category?: unknown };

/** Dokunulan bildirim: ayni bildirim iki kez (soguk acilis + dinleyici) islenmesin diye kimlikli. */
export type NotificationTap = { id: string; data: NotificationData };

export type PushSupport = 'ok' | 'web' | 'simulator';

export type NotificationsAdapter = {
  support: () => PushSupport;
  platform: 'ios' | 'android' | 'web';
  /** EAS proje kimligi (`app.json` -> `extra.eas.projectId`); sahip EAS projesini olusturana kadar yok. */
  projectId: () => string | undefined;
  appVersion: () => string | undefined;
  locale: () => string | undefined;
  getPermission: () => Promise<PermissionState>;
  requestPermission: () => Promise<PermissionState>;
  getExpoToken: (projectId: string) => Promise<string>;
  /** Cihaz (FCM / APNs) token'i degisince; Expo token'i yeniden alinmali. */
  onTokenChange: (listener: () => void) => () => void;
  /** Android kanallari (`default`, `gate`) ve on plan gosterim kurali. Acilista bir kez. */
  configure: () => Promise<void>;
  onTap: (listener: (tap: NotificationTap) => void) => () => void;
  /** Soguk acilista uygulamayi acan bildirim (yoksa null). */
  lastTap: () => Promise<NotificationTap | null>;
  onReceived: (listener: (data: NotificationData) => void) => () => void;
  openSettings: () => Promise<void>;
};
