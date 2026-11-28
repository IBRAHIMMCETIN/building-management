import { ApiError, errorMessage } from '@bm/shared/api/errors';
import type { AuthSession } from '@bm/shared/auth/session';
import { z } from 'zod';
import type { ApiClient } from '@/lib/api/createApiClient';
import type { KeyValueStorage } from '@/lib/storage/types';
import type { NotificationData, NotificationsAdapter, PermissionStatus, PushTokens } from './types';

/*
 * Mobil bildirim kaydi (README "Mobil bildirim"; API: POST|DELETE /api/me/devices):
 *  - Izin ACILISTA istenmez. Etkilesimli giristen sonra (SessionManager `afterSignIn`) izin daha
 *    once verildiyse sessizce kaydolunur; hic sorulmadiysa uygulama ici aciklama (PushPermissionPrompt)
 *    gosterilir, sistem istemi yalnizca kullanici "izin ver" deyince acilir. "Şimdi değil" kullanici
 *    basina hatirlanir; Hesabım > Mobil bildirim'den sonra acilabilir. Oturum / kullanici degisince
 *    aciklama kapanir (bir sonraki kullanicinin kendi tercihi gecerli).
 *  - Kayit: cihaz + Expo token'i (`extra.eas.projectId`) -> deviceId guvenli depoda (Keychain /
 *    Keystore). Saklanan kullanici + token aynıysa POST yok. EAS projesi yoksa kayit atlanir, bir kez
 *    loglanir. Basarisiz / 429 kayit 6 saat (veya sonraki girise kadar) yeniden denenmez.
 *  - Token degisimi: native modul HER token alisinda token olayini da yayar; alis sirasindaki ve ayni
 *    degerdeki olaylar yok sayilir (aksi halde kayit -> olay -> kayit dongusu), yalnizca yeni cihaz
 *    token'i yeniden kayit baslatir; eski deviceId silinir.
 *  - Cikis (`beforeSignOut` -> beginSignOut): nesil sayaci artar (suren kayit sonucu saklanir ama
 *    oturum acik sayilmaz), giden oturumun token'i o anda alinir; sira gelince DELETE bu token'la
 *    gider (SessionManager oturumu en fazla 3 sn sonra kapatsa da). DELETE basarisizsa cihazin push
 *    kaydi iptal edilir (eski token gecersiz) ve "bekleyen silme" kaydi ayni kullanicinin sonraki
 *    girisinde / acilisinda yeniden denenir.
 *  - On plan gosterimi: oturum yoksa veya bildirimin apartmani kullanicinin bilinen apartmanlarindan
 *    degilse gosterilmez (shouldShow).
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
type PendingRevoke = { userId: string; deviceId: string };

const DEVICE_KEY = 'bm.push.device';
const REVOKE_KEY = 'bm.push.revoke';
const BACKOFF_KEY = 'bm.push.backoff-until';
/** Basarisiz kayittan sonra otomatik (acilis / one gelme) deneme araligi. */
export const RETRY_BACKOFF_MS = 6 * 3600_000;
const dismissedKey = (userId: string) => `bm.push.prompt-dismissed.${userId}`;
const deviceResponse = z.object({ device: z.object({ deviceId: z.string() }).loose() });

export type PushServiceDeps = {
  adapter: NotificationsAdapter;
  api: ApiClient;
  /** deviceId + token (guvenli depo). */
  storage: KeyValueStorage;
  /** "Şimdi değil" ve geri cekilme zamani (gizli olmayan tercih). */
  preferences: { get: (key: string) => Promise<string | null>; set: (key: string, value: string | null) => Promise<void> };
  getSession: () => AuthSession | null;
  /** API'ye giden bearer token (SessionManager ile ayni secim: id / access). */
  tokenFor: (session: AuthSession) => string;
  now?: () => number;
  log?: (message: string) => void;
};

export class PushService {
  private snapshot: PushSnapshot = { support: 'ok', permission: 'unknown', canAskAgain: true, registered: false, promptVisible: false, busy: false };
  private listeners = new Set<() => void>();
  private loggedNoProject = false;
  private queue: Promise<unknown> = Promise.resolve();
  private tokenSub: (() => void) | null = null;
  /** Cikista artar: oncesinde baslamis kayit "oturum acik" sonucu yazmaz. */
  private generation = 0;
  /** Oturum acik (giris / geri yukleme) ve cikis baslamamis. */
  private active = false;
  /** Token alinirken native modulun yaydigi olaylar yok sayilir. */
  private fetchingTokens = false;
  private lastDeviceToken: string | null = null;
  private knownApartments = new Set<string>();

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

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Islemler sirayla (giris kaydi ile cikis silmesi birbirini ezmez); hata sonrakini durdurmaz. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Desteklenmiyorsa null; destekleniyorsa proje kimligi. */
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

  private async readJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.deps.storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private async readStored(): Promise<StoredDevice | null> {
    const v = await this.readJson<Partial<StoredDevice>>(DEVICE_KEY);
    return v && typeof v.userId === 'string' && typeof v.deviceId === 'string' && typeof v.token === 'string' ? (v as StoredDevice) : null;
  }

  private async refreshPermission() {
    const p = await this.deps.adapter.getPermission();
    this.update({ permission: p.status, canAskAgain: p.canAskAgain });
    return p;
  }

  private async inBackoff(): Promise<boolean> {
    const until = Number(await this.deps.preferences.get(BACKOFF_KEY));
    return Number.isFinite(until) && until > this.now();
  }

  private setBackoff(message: string) {
    this.update({ error: message });
    void this.deps.preferences.set(BACKOFF_KEY, String(this.now() + RETRY_BACKOFF_MS));
  }

  /** Token alisi: bu sirada native modulun yaydigi olaylar dongu yaratmasin diye yok sayilir. */
  private async fetchTokens(projectId: string): Promise<PushTokens> {
    this.fetchingTokens = true;
    try {
      const tokens = await this.deps.adapter.getTokens(projectId);
      this.lastDeviceToken = tokens.device;
      return tokens;
    } finally {
      this.fetchingTokens = false;
    }
  }

  /** Uygulama acikken YENI cihaz token'i: yeniden kayit. Alis sirasindaki / ayni degerdeki olay yok sayilir. */
  private watchToken() {
    this.tokenSub ??= this.deps.adapter.onTokenChange((deviceToken) => {
      if (this.fetchingTokens || deviceToken === this.lastDeviceToken) return;
      this.lastDeviceToken = deviceToken;
      const session = this.deps.getSession();
      if (this.active && session && this.snapshot.permission === 'granted') void this.register(session).catch(() => undefined);
    });
  }

  /** On planda gelen bildirim gosterilsin mi (notificationsAdapter.configure). */
  shouldShow = (data: NotificationData): boolean => {
    const session = this.deps.getSession();
    if (!session || !this.active) return false;
    const apt = typeof data.apartmentId === 'string' ? data.apartmentId : '';
    return !apt || apt === session.claims.apartmentId || this.knownApartments.has(apt);
  };

  /** Kullanicinin baglamlarindaki apartmanlar (on plan gosterim kurali icin). */
  setKnownApartments(ids: readonly string[]) {
    this.knownApartments = new Set(ids);
  }

  /** SessionManager kapsam degisimi: kullanici degisti / oturum kapandi (401 dahil). */
  onSessionChange(prev: AuthSession | null, next: AuthSession | null) {
    if (prev?.claims.sub === next?.claims.sub) return;
    this.knownApartments = new Set();
    if (!next) this.active = false;
    this.update({ promptVisible: false, registered: false, error: undefined });
  }

  /** SessionManager `afterSignIn`: izin verilmisse kaydol, hic sorulmadiysa aciklamayi goster. */
  onSignedIn(session: AuthSession): Promise<void> {
    this.active = true;
    const gen = this.generation;
    return this.serial(async () => {
      await this.retryPendingRevoke(session);
      if (!this.projectId()) return;
      const p = await this.refreshPermission();
      if (p.status === 'granted') {
        await this.registerNow(session, gen);
        return;
      }
      if (p.status === 'undetermined' && p.canAskAgain && gen === this.generation) {
        const dismissed = await this.deps.preferences.get(dismissedKey(session.claims.sub));
        if (!dismissed && this.deps.getSession()?.claims.sub === session.claims.sub) this.update({ promptVisible: true });
      }
    }).catch((err: unknown) => this.fail(err));
  }

  /** Acilista geri yuklenen oturum: izin varsa yalnizca token degistiyse (veya kayit yoksa) kaydol. */
  onRestored(session: AuthSession): Promise<void> {
    this.active = true;
    const gen = this.generation;
    return this.serial(async () => {
      await this.retryPendingRevoke(session);
      if (!this.projectId()) return;
      const p = await this.refreshPermission();
      if (p.status !== 'granted') return;
      const stored = await this.readStored();
      if (!stored && (await this.inBackoff())) return;
      await this.registerNow(session, gen);
    }).catch((err: unknown) => this.fail(err));
  }

  /** Aciklamada "Bildirimlere izin ver" veya Hesabım'dan: sistem istemi, izin verilirse kayit. */
  accept(): Promise<void> {
    const gen = this.generation;
    return this.serial(async () => {
      this.update({ promptVisible: false, busy: true, error: undefined });
      try {
        if (!this.projectId()) return;
        const p = await this.deps.adapter.requestPermission();
        this.update({ permission: p.status, canAskAgain: p.canAskAgain });
        const session = this.deps.getSession();
        if (p.status === 'granted' && session && this.active) await this.registerNow(session, gen);
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

  /**
   * Hesabım acilinca / uygulama one gelince: izin durumu tazelenir (ayarlardan acilmis olabilir);
   * izin varsa ve kayit yoksa, geri cekilme suresi dolmussa kaydolunur.
   */
  sync(): Promise<void> {
    const gen = this.generation;
    return this.serial(async () => {
      if (!this.projectId()) return;
      const p = await this.refreshPermission();
      const session = this.deps.getSession();
      if (p.status !== 'granted' || !session || !this.active || this.snapshot.registered) return;
      if (await this.inBackoff()) return;
      await this.registerNow(session, gen);
    }).catch((err: unknown) => this.fail(err));
  }

  /** Token degisimi / yeniden deneme. */
  register(session: AuthSession): Promise<void> {
    const gen = this.generation;
    return this.serial(() => this.registerNow(session, gen));
  }

  private async registerNow(session: AuthSession, gen: number): Promise<void> {
    const projectId = this.deps.adapter.projectId();
    // Kuyrukta beklerken cikis basladiysa kayit hic yapilmaz.
    if (!projectId || gen !== this.generation || !this.active) return;
    const tokens = await this.fetchTokens(projectId);
    const { adapter, api } = this.deps;
    const userId = session.claims.sub;
    const stored = await this.readStored();
    if (stored && stored.userId === userId && stored.token === tokens.expo) {
      // Ayni kullanici + ayni token: sunucuda kayit zaten aktif, POST yok.
      if (gen === this.generation) this.update({ registered: true, error: undefined });
      this.watchToken();
      return;
    }
    if (gen !== this.generation) return;
    const appVersion = adapter.appVersion();
    const locale = adapter.locale();
    const platform = adapter.platform === 'ios' ? 'ios' : 'android';
    let res: z.infer<typeof deviceResponse>;
    try {
      res = await api.post('/api/me/devices', { token: tokens.expo, platform, ...(appVersion ? { appVersion } : {}), ...(locale ? { locale } : {}) }, { schema: deviceResponse });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        this.deps.log?.('[push] cihaz kaydı günlük sınırda (429); sonraki girişte yeniden denenecek.');
        this.setBackoff('Bu telefon şu an kaydedilemedi (günlük sınır). Bir sonraki girişte yeniden denenecek.');
        return;
      }
      this.setBackoff(`Bu telefon kaydedilemedi: ${errorMessage(err)}`);
      throw err;
    }
    const deviceId = res.device.deviceId;
    // Token degisti: ayni kullanicinin eski kaydi pasife alinir (baska kullanicininki zaten tasindi).
    if (stored && stored.deviceId !== deviceId && stored.userId === userId) {
      await api.delete(`/api/me/devices/${encodeURIComponent(stored.deviceId)}`).catch(() => undefined);
    }
    // Arada cikis basladiysa da yazilir: kuyruktaki silme bu kaydi giden oturumun token'iyla siler.
    await this.deps.storage.setItem(DEVICE_KEY, JSON.stringify({ userId, deviceId, token: tokens.expo } satisfies StoredDevice));
    await this.deps.preferences.set(BACKOFF_KEY, null);
    if (gen === this.generation) this.update({ registered: true, error: undefined });
    this.watchToken();
  }

  /**
   * SessionManager `beforeSignOut`: oturum hala gecerliyken cagrilir. Nesil artar, giden oturumun
   * token'i alinir; silme kuyrukta (suren kayit bittikten sonra) bu token'la yapilir.
   */
  beginSignOut(session: AuthSession): Promise<void> {
    this.generation += 1;
    this.active = false;
    const bearer = this.deps.tokenFor(session);
    this.update({ registered: false, promptVisible: false, error: undefined });
    return this.serial(() => this.revokeNow(session.claims.sub, bearer));
  }

  private async revokeNow(userId: string, bearer: string): Promise<void> {
    const stored = await this.readStored();
    if (!stored) return;
    try {
      await this.deps.api.delete(`/api/me/devices/${encodeURIComponent(stored.deviceId)}`, { auth: false, headers: { authorization: `Bearer ${bearer}` } });
    } catch (err) {
      // 404: zaten pasif / baska kullaniciya tasinmis. Diger hatalarda (cevrimdisi vb.) cihazin push
      // kaydi iptal edilir ve silme ayni kullanicinin sonraki oturumunda yeniden denenir.
      if (!(err instanceof ApiError && err.status === 404)) {
        this.deps.log?.(`[push] cihaz kaydı silinemedi: ${errorMessage(err)}`);
        await this.deps.adapter.unregisterDevice().catch(() => undefined);
        this.lastDeviceToken = null;
        await this.deps.storage.setItem(REVOKE_KEY, JSON.stringify({ userId: stored.userId || userId, deviceId: stored.deviceId } satisfies PendingRevoke));
      }
    } finally {
      await this.deps.storage.removeItem(DEVICE_KEY).catch(() => undefined);
    }
  }

  /** Bekleyen silme: ayni kullanici ise yeniden denenir; baska kullanicida birakilir (token gecersiz). */
  private async retryPendingRevoke(session: AuthSession): Promise<void> {
    const pending = await this.readJson<PendingRevoke>(REVOKE_KEY);
    if (!pending?.deviceId) return;
    if (pending.userId !== session.claims.sub) {
      // Cihaz token'i iptal edildi: Expo DeviceNotRegistered ile sunucu kaydi kendiliginden pasife alir.
      await this.deps.storage.removeItem(REVOKE_KEY);
      return;
    }
    try {
      await this.deps.api.delete(`/api/me/devices/${encodeURIComponent(pending.deviceId)}`);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return;
    }
    await this.deps.storage.removeItem(REVOKE_KEY);
  }

  private fail(err: unknown) {
    this.update({ error: this.snapshot.error ?? errorMessage(err) });
    this.deps.log?.(`[push] ${errorMessage(err)}`);
  }
}
