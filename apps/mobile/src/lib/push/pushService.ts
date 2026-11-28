import { ApiError, errorMessage } from '@bm/shared/api/errors';
import type { AuthSession } from '@bm/shared/auth/session';
import { z } from 'zod';
import type { ApiClient } from '@/lib/api/createApiClient';
import type { KeyValueStorage } from '@/lib/storage/types';
import type { NotificationsAdapter, PermissionStatus } from './types';

/*
 * Mobil bildirim kaydi (README "Mobil bildirim"; API: POST|DELETE /api/me/devices):
 *  - Izin ACILISTA istenmez. Etkilesimli giristen sonra (SessionManager `afterSignIn`) izin daha
 *    once verildiyse sessizce kaydolunur; hic sorulmadiysa uygulama ici aciklama (PushPermissionPrompt)
 *    gosterilir, sistem istemi yalnizca kullanici "izin ver" deyince acilir. "Şimdi değil" kullanici
 *    basina hatirlanir; Hesabım > Mobil bildirim'den sonra acilabilir.
 *  - Kayit: Expo push token'i (`extra.eas.projectId` ile) + platform / surum / dil -> deviceId guvenli
 *    depoda (Keychain / Keystore). EAS projesi yoksa (sahip `eas init` yapana kadar) kayit atlanir ve
 *    bir kez loglanir.
 *  - Token degisimi: acilista saklanan token ile karsilastirilir (her acilista POST yok), uygulama
 *    acikken cihaz token'i degisince yeniden kaydolunur; eski deviceId silinir.
 *  - Cikis: `beforeSignOut` -> DELETE (token hala gecerliyken; hata cikisi engellemez).
 *  - 429 (gunluk kayit siniri) zararsizdir: kayit durur, sonraki giriste yeniden denenir.
 */

export type PushSnapshot = {
  /** `no_project`: EAS proje kimligi yok (gelistirme / sahip henuz olusturmadi). */
  support: 'ok' | 'web' | 'simulator' | 'no_project';
  permission: PermissionStatus | 'unknown';
  canAskAgain: boolean;
  registered: boolean;
  /** Giristen sonra uygulama ici izin aciklamasi gosterilsin. */
  promptVisible: boolean;
  busy: boolean;
  error?: string;
};

type StoredDevice = { userId: string; deviceId: string; token: string };

const DEVICE_KEY = 'bm.push.device';
const dismissedKey = (userId: string) => `bm.push.prompt-dismissed.${userId}`;
const deviceResponse = z.object({ device: z.object({ deviceId: z.string() }).loose() });

export type PushServiceDeps = {
  adapter: NotificationsAdapter;
  api: ApiClient;
  /** deviceId + token (guvenli depo). */
  storage: KeyValueStorage;
  /** "Şimdi değil" hatirlatmasi (gizli olmayan tercih). */
  preferences: { get: (key: string) => Promise<string | null>; set: (key: string, value: string | null) => Promise<void> };
  getSession: () => AuthSession | null;
  log?: (message: string) => void;
};

export class PushService {
  private snapshot: PushSnapshot = { support: 'ok', permission: 'unknown', canAskAgain: true, registered: false, promptVisible: false, busy: false };
  private listeners = new Set<() => void>();
  private loggedNoProject = false;
  private queue: Promise<unknown> = Promise.resolve();
  private tokenSub: (() => void) | null = null;

  constructor(private readonly deps: PushServiceDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PushSnapshot => this.snapshot;

  private update(patch: Partial<PushSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /** Islemler sirayla (giris kaydi ile cikis silmesi birbirini ezmez); hata sonrakini durdurmaz. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Desteklenmiyorsa nedeni; destekleniyorsa proje kimligi. */
  private projectId(): string | null {
    const support = this.deps.adapter.support();
    if (support !== 'ok') {
      this.update({ support });
      return null;
    }
    const id = this.deps.adapter.projectId();
    if (!id) {
      this.update({ support: 'no_project' });
      if (!this.loggedNoProject) {
        this.loggedNoProject = true;
        this.deps.log?.('[push] EAS projectId yok (app.json extra.eas.projectId): cihaz kaydı atlandı.');
      }
      return null;
    }
    this.update({ support: 'ok' });
    return id;
  }

  private async readStored(): Promise<StoredDevice | null> {
    try {
      const raw = await this.deps.storage.getItem(DEVICE_KEY);
      const v = raw ? (JSON.parse(raw) as Partial<StoredDevice>) : null;
      return v && typeof v.userId === 'string' && typeof v.deviceId === 'string' && typeof v.token === 'string' ? (v as StoredDevice) : null;
    } catch {
      return null;
    }
  }

  private async refreshPermission() {
    const p = await this.deps.adapter.getPermission();
    this.update({ permission: p.status, canAskAgain: p.canAskAgain });
    return p;
  }

  /** Token watcher: uygulama acikken cihaz token'i degisirse yeniden kaydolunur. */
  private watchToken() {
    this.tokenSub ??= this.deps.adapter.onTokenChange(() => {
      const session = this.deps.getSession();
      if (session && this.snapshot.permission === 'granted') void this.register(session).catch(() => undefined);
    });
  }

  /** SessionManager `afterSignIn`: izin verilmisse kaydol, hic sorulmadiysa aciklamayi goster. */
  onSignedIn(session: AuthSession): Promise<void> {
    return this.serial(async () => {
      if (!this.projectId()) return;
      const p = await this.refreshPermission();
      if (p.status === 'granted') {
        await this.registerNow(session);
        return;
      }
      if (p.status === 'undetermined' && p.canAskAgain) {
        const dismissed = await this.deps.preferences.get(dismissedKey(session.claims.sub));
        if (!dismissed) this.update({ promptVisible: true });
      }
    }).catch((err: unknown) => this.fail(err));
  }

  /** Acilista geri yuklenen oturum: izin varsa yalnizca token degistiyse (veya kayit yoksa) kaydol. */
  onRestored(session: AuthSession): Promise<void> {
    return this.serial(async () => {
      if (!this.projectId()) return;
      const p = await this.refreshPermission();
      if (p.status !== 'granted') return;
      const stored = await this.readStored();
      const projectId = this.deps.adapter.projectId() as string;
      const token = await this.deps.adapter.getExpoToken(projectId);
      if (stored && stored.userId === session.claims.sub && stored.token === token) {
        this.update({ registered: true });
        this.watchToken();
        return;
      }
      await this.registerNow(session, token);
    }).catch((err: unknown) => this.fail(err));
  }

  /** Aciklamada "Bildirimlere izin ver" veya Hesabım'dan: sistem istemi, izin verilirse kayit. */
  accept(): Promise<void> {
    return this.serial(async () => {
      this.update({ promptVisible: false, busy: true, error: undefined });
      try {
        if (!this.projectId()) return;
        const p = await this.deps.adapter.requestPermission();
        this.update({ permission: p.status, canAskAgain: p.canAskAgain });
        const session = this.deps.getSession();
        if (p.status === 'granted' && session) await this.registerNow(session);
      } finally {
        this.update({ busy: false });
      }
    }).catch((err: unknown) => this.fail(err));
  }

  /** "Şimdi değil": bu kullaniciya giriste yeniden sorulmaz. */
  async dismiss(): Promise<void> {
    this.update({ promptVisible: false });
    const session = this.deps.getSession();
    if (session) await this.deps.preferences.set(dismissedKey(session.claims.sub), '1');
  }

  /** Izin kalici olarak reddedildiyse sistem ayarlari. */
  openSettings(): Promise<void> {
    return this.deps.adapter.openSettings();
  }

  /** Hesabım acilinca / uygulama one gelince izin durumu tazelenir (ayarlardan acilmis olabilir). */
  sync(): Promise<void> {
    return this.serial(async () => {
      if (!this.projectId()) return;
      const p = await this.refreshPermission();
      const session = this.deps.getSession();
      if (p.status === 'granted' && session && !this.snapshot.registered) await this.registerNow(session);
    }).catch((err: unknown) => this.fail(err));
  }

  /** Token degisimi / yeniden deneme (sira disi cagrilabilir). */
  register(session: AuthSession): Promise<void> {
    return this.serial(() => this.registerNow(session));
  }

  private async registerNow(session: AuthSession, knownToken?: string): Promise<void> {
    const projectId = this.deps.adapter.projectId();
    if (!projectId) return;
    const token = knownToken ?? (await this.deps.adapter.getExpoToken(projectId));
    const { adapter, api } = this.deps;
    const appVersion = adapter.appVersion();
    const locale = adapter.locale();
    const platform = adapter.platform === 'ios' ? 'ios' : 'android';
    const stored = await this.readStored();
    let res: z.infer<typeof deviceResponse>;
    try {
      res = await api.post('/api/me/devices', { token, platform, ...(appVersion ? { appVersion } : {}), ...(locale ? { locale } : {}) }, { schema: deviceResponse });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        this.deps.log?.('[push] cihaz kaydı günlük sınırda (429); sonraki girişte yeniden denenecek.');
        return;
      }
      throw err;
    }
    const deviceId = res.device.deviceId;
    // Token degisti: ayni kullanicinin eski kaydi pasife alinir (baska kullanicininki zaten tasindi).
    if (stored && stored.deviceId !== deviceId && stored.userId === session.claims.sub) {
      await api.delete(`/api/me/devices/${encodeURIComponent(stored.deviceId)}`).catch(() => undefined);
    }
    await this.deps.storage.setItem(DEVICE_KEY, JSON.stringify({ userId: session.claims.sub, deviceId, token } satisfies StoredDevice));
    this.update({ registered: true, error: undefined });
    this.watchToken();
  }

  /** SessionManager `beforeSignOut`: cihaz kaydi sunucuda pasife alinir, yerel kayit silinir. */
  unregister(): Promise<void> {
    return this.serial(async () => {
      const stored = await this.readStored();
      this.update({ registered: false, promptVisible: false });
      if (!stored) return;
      try {
        await this.deps.api.delete(`/api/me/devices/${encodeURIComponent(stored.deviceId)}`);
      } catch (err) {
        // 404: zaten pasif / baska kullaniciya tasinmis. Diger hatalar cikisi engellemez.
        if (!(err instanceof ApiError && err.status === 404)) this.deps.log?.(`[push] cihaz kaydı silinemedi: ${errorMessage(err)}`);
      } finally {
        await this.deps.storage.removeItem(DEVICE_KEY).catch(() => undefined);
      }
    });
  }

  private fail(err: unknown) {
    this.update({ error: errorMessage(err) });
    this.deps.log?.(`[push] ${errorMessage(err)}`);
  }
}
