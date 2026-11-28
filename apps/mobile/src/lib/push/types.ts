/*
 * Mobil bildirim (push) - platform katmaninin sozlesmesi. Native: notificationsAdapter.ts
 * (expo-notifications + expo-device + app config), web onizlemesi: notificationsAdapter.web.ts
 * (desteklenmez). Testler sahte adapter verir (src/test/notifications.ts).
 */

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';
export type PermissionState = { status: PermissionStatus; canAskAgain: boolean };

/** Bildirime eklenen veri (API push-templates.ts: `data: { url, apartmentId, type, category }`). */
export type NotificationData = { url?: unknown; apartmentId?: unknown; type?: unknown; category?: unknown };

/** Dokunulan bildirim: ayni bildirim iki kez (soguk acilis + dinleyici) islenmesin diye kimlikli. */
export type NotificationTap = { id: string; data: NotificationData };

export type PushSupport = 'ok' | 'web' | 'simulator';

/** Cihaz (APNs / FCM) token'i ve ondan uretilen Expo token'i. */
export type PushTokens = { expo: string; device: string };

export type NotificationsAdapter = {
  support: () => PushSupport;
  platform: 'ios' | 'android' | 'web';
  /** EAS proje kimligi (`app.json` -> `extra.eas.projectId`); sahip EAS projesini olusturana kadar yok. */
  projectId: () => string | undefined;
  appVersion: () => string | undefined;
  locale: () => string | undefined;
  getPermission: () => Promise<PermissionState>;
  requestPermission: () => Promise<PermissionState>;
  /**
   * Cihaz token'i + Expo token'i. Dikkat: native modul her token alisinda token olayini da yayar
   * (iOS didRegister, Android onNewToken); dinleyici bu sirada gelen olaylari yok saymalidir.
   */
  getTokens: (projectId: string) => Promise<PushTokens>;
  /** Cihaz token'i olayi (yeni token degeriyle). */
  onTokenChange: (listener: (deviceToken: string) => void) => () => void;
  /** Cikista sunucu silmesi basarisizsa: cihazin push kaydi iptal edilir (eski token gecersizlesir). */
  unregisterDevice: () => Promise<void>;
  /**
   * Android kanallari (`default`, `gate`) ve on plan gosterim kurali. `shouldShow(data)` false ise
   * on plandaki bildirim gosterilmez (oturum yok / bildirim bu kullanicinin apartmanina ait degil).
   */
  configure: (shouldShow: (data: NotificationData) => boolean) => Promise<void>;
  onTap: (listener: (tap: NotificationTap) => void) => () => void;
  /** Soguk acilista uygulamayi acan bildirim (yoksa null). */
  lastTap: () => Promise<NotificationTap | null>;
  /** Islenen dokunma saklanan "son yanit"tan silinir (kok yeniden kurulunca eski hedef acilmasin). */
  clearLastTap: () => void;
  onReceived: (listener: (data: NotificationData) => void) => () => void;
  openSettings: () => Promise<void>;
};
