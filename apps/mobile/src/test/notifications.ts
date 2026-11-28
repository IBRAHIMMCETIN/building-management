import type { NotificationData, NotificationTap, NotificationsAdapter, PermissionState } from '@/lib/push/types';

/*
 * Test icin bildirim katmani: expo-notifications'a gidilmez. Varsayilan (jest.setup.ts) "simulator":
 * kayit ve izin istemi hic calismaz. Push testleri `fakeNotifications()` ile izin, proje kimligi,
 * token ve dokunmalari kendisi surer. Native modul gibi her token alisinda token olayi da yayilir.
 */

export const inertNotifications: NotificationsAdapter = {
  support: () => 'simulator',
  platform: 'ios',
  projectId: () => undefined,
  appVersion: () => undefined,
  locale: () => undefined,
  getPermission: async () => ({ status: 'undetermined', canAskAgain: true }),
  requestPermission: async () => ({ status: 'denied', canAskAgain: false }),
  getTokens: async () => {
    throw new Error('test: token yok');
  },
  onTokenChange: () => () => undefined,
  unregisterDevice: async () => undefined,
  configure: async () => undefined,
  onTap: () => () => undefined,
  lastTap: async () => null,
  clearLastTap: () => undefined,
  onReceived: () => () => undefined,
  openSettings: async () => undefined,
};

export type FakeNotifications = NotificationsAdapter & {
  state: {
    permission: PermissionState;
    afterRequest: PermissionState;
    projectId?: string;
    /** Cihaz token'i; Expo token'i bundan uretilir (`ExponentPushToken[<cihaz>]`). */
    device: string;
    requests: number;
    tokenFetches: number;
    settingsOpened: number;
    unregistered: number;
    lastTapCleared: number;
  };
  /** Cihaz token'i degisti (FCM / APNs yeniledi): olay yayilir. */
  changeToken: (device: string) => void;
  tap: (tap: NotificationTap) => void;
  receive: (data: NotificationData) => void;
  setLastTap: (tap: NotificationTap | null) => void;
  /** configure ile verilen on plan kurali. */
  shouldShow: (data: NotificationData) => boolean;
};

export const expoTokenOf = (device: string) => `ExponentPushToken[${device}]`;

export function fakeNotifications(init: Partial<FakeNotifications['state']> = {}): FakeNotifications {
  const state: FakeNotifications['state'] = {
    permission: { status: 'undetermined', canAskAgain: true },
    afterRequest: { status: 'granted', canAskAgain: true },
    projectId: 'proj-test',
    device: 'aaaaaaaaaaaa',
    requests: 0,
    tokenFetches: 0,
    settingsOpened: 0,
    unregistered: 0,
    lastTapCleared: 0,
    ...init,
  };
  const tokenListeners = new Set<(device: string) => void>();
  const tapListeners = new Set<(t: NotificationTap) => void>();
  const receiveListeners = new Set<(d: NotificationData) => void>();
  let last: NotificationTap | null = null;
  let rule: (data: NotificationData) => boolean = () => true;
  const sub = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => void set.delete(l);
  };
  const emitToken = () => {
    for (const l of tokenListeners) l(state.device);
  };
  return {
    state,
    support: () => 'ok',
    platform: 'android',
    projectId: () => state.projectId,
    appVersion: () => '0.1.0',
    locale: () => 'tr-TR',
    getPermission: async () => state.permission,
    requestPermission: async () => {
      state.requests += 1;
      state.permission = state.afterRequest;
      return state.permission;
    },
    getTokens: async () => {
      state.tokenFetches += 1;
      // Native modul (iOS didRegister / Android onNewToken) her alista olayi yayar.
      emitToken();
      await Promise.resolve();
      return { expo: expoTokenOf(state.device), device: state.device };
    },
    onTokenChange: (l) => sub(tokenListeners, l),
    unregisterDevice: async () => {
      state.unregistered += 1;
    },
    configure: async (shouldShow) => {
      rule = shouldShow;
    },
    onTap: (l) => sub(tapListeners, l),
    lastTap: async () => last,
    clearLastTap: () => {
      state.lastTapCleared += 1;
      last = null;
    },
    onReceived: (l) => sub(receiveListeners, l),
    openSettings: async () => {
      state.settingsOpened += 1;
    },
    changeToken: (device) => {
      state.device = device;
      emitToken();
    },
    tap: (t) => {
      for (const l of tapListeners) l(t);
    },
    receive: (d) => {
      for (const l of receiveListeners) l(d);
    },
    setLastTap: (t) => {
      last = t;
    },
    shouldShow: (data) => rule(data),
  };
}
