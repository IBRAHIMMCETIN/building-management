import type { NotificationData, NotificationTap, NotificationsAdapter, PermissionState } from '@/lib/push/types';

/*
 * Test icin bildirim katmani: expo-notifications'a gidilmez. Varsayilan (jest.setup.ts) "simulator":
 * kayit ve izin istemi hic calismaz. Push testleri `fakeNotifications()` ile izin, proje kimligi,
 * token ve dokunmalari kendisi surer.
 */

export const inertNotifications: NotificationsAdapter = {
  support: () => 'simulator',
  platform: 'ios',
  projectId: () => undefined,
  appVersion: () => undefined,
  locale: () => undefined,
  getPermission: async () => ({ status: 'undetermined', canAskAgain: true }),
  requestPermission: async () => ({ status: 'denied', canAskAgain: false }),
  getExpoToken: async () => {
    throw new Error('test: token yok');
  },
  onTokenChange: () => () => undefined,
  configure: async () => undefined,
  onTap: () => () => undefined,
  lastTap: async () => null,
  onReceived: () => () => undefined,
  openSettings: async () => undefined,
};

export type FakeNotifications = NotificationsAdapter & {
  state: { permission: PermissionState; afterRequest: PermissionState; projectId?: string; token: string; requests: number; settingsOpened: number };
  /** Cihaz token'inin degistigini bildirir (addPushTokenListener). */
  changeToken: (token: string) => void;
  tap: (tap: NotificationTap) => void;
  receive: (data: NotificationData) => void;
  setLastTap: (tap: NotificationTap | null) => void;
};

export function fakeNotifications(init: Partial<FakeNotifications['state']> = {}): FakeNotifications {
  const state: FakeNotifications['state'] = {
    permission: { status: 'undetermined', canAskAgain: true },
    afterRequest: { status: 'granted', canAskAgain: true },
    projectId: 'proj-test',
    token: 'ExponentPushToken[aaaaaaaaaaaa]',
    requests: 0,
    settingsOpened: 0,
    ...init,
  };
  const tokenListeners = new Set<() => void>();
  const tapListeners = new Set<(t: NotificationTap) => void>();
  const receiveListeners = new Set<(d: NotificationData) => void>();
  let last: NotificationTap | null = null;
  const sub = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => void set.delete(l);
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
    getExpoToken: async () => state.token,
    onTokenChange: (l) => sub(tokenListeners, l),
    configure: async () => undefined,
    onTap: (l) => sub(tapListeners, l),
    lastTap: async () => last,
    onReceived: (l) => sub(receiveListeners, l),
    openSettings: async () => {
      state.settingsOpened += 1;
    },
    changeToken: (token) => {
      state.token = token;
      for (const l of tokenListeners) l();
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
  };
}
