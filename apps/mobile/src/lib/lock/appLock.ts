import type { BiometricAdapter, BiometricStatus } from './types';

/*
 * Uygulama kilidi (Hesabım -> "Face ID / parmak izi ile kilit"), kullanici basina ve istege bagli.
 *
 *  - Acik ise: soguk acilista (saklanan oturum geri yuklenince) ve uygulama arka planda ayarlanan
 *    sureden (varsayilan 5 dk) uzun kaldiysa kilit ekrani; Face ID / parmak izi, tutmazsa cihaz sifresi.
 *  - Etkilesimli giriste kilit yok (kullanici sifresiyle dogruladi). Kilit ekraninda "Çıkış yap" vardir.
 *  - Kimlik bilgisi SAKLANMAZ: token'lar yine Keychain / Keystore'da (oturum yoneticisi); burada yalnizca
 *    `{ enabled, timeoutMinutes }` tercihi (gizli degil) kullanici kimligiyle anahtarlanir.
 *  - Cihazda kayitli yuz / parmak izi yoksa (sonradan silindiyse de) kilit kendiliginden kapanir ve
 *    kullaniciya bir kez bildirilir.
 *  - Kilit acma istemi (Android cihaz sifresi ekrani) uygulamayi arka plana alabilir: bu sure sayilmaz.
 */

export const LOCK_TIMEOUT_OPTIONS = [1, 5, 15] as const;
export const DEFAULT_LOCK_TIMEOUT_MINUTES = 5;

export type LockSettings = { enabled: boolean; timeoutMinutes: number };
export const DEFAULT_LOCK_SETTINGS: LockSettings = { enabled: false, timeoutMinutes: DEFAULT_LOCK_TIMEOUT_MINUTES };

/** `checking`: karar bekleniyor (icerik ortulu); `locked`: dogrulama gerekli; `unlocked`: serbest. */
export type LockStatus = 'checking' | 'locked' | 'unlocked';

export type AppLockState = {
  status: LockStatus;
  userId: string | null;
  settings: LockSettings;
  /** Son okunan cihaz durumu (Hesabım). */
  biometric: BiometricStatus | null;
  authenticating: boolean;
  /** Son kilit acma denemesinin Turkce hatasi. */
  error: string | null;
};

export type LockStorage = { get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void> };

export type EnableResult = { ok: true } | { ok: false; message: string };

type Deps = {
  biometrics: BiometricAdapter;
  storage: LockStorage;
  now?: () => number;
  /** Kayitli biyometri olmadigi icin kilit kapatildi (uygulama geneli not). */
  onAutoDisabled?: () => void;
};

type AppStateValue = 'active' | 'background' | 'inactive' | 'unknown' | 'extension' | null | undefined;

export const lockStorageKey = (userId: string) => `appLock.v1:${userId}`;

export const AUTO_DISABLED_MESSAGE = 'Cihazda kayıtlı Face ID / parmak izi bulunmadığı için uygulama kilidi kapatıldı.';

/** Sistem isteminin hata kodu -> ekrandaki metin. */
export function unlockErrorMessage(code: string): string {
  switch (code) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
      return 'Doğrulama iptal edildi. Tekrar denemek için "Kilidi aç"a dokunun.';
    case 'lockout':
      return 'Çok fazla başarısız deneme. Biraz sonra tekrar deneyin veya cihaz şifrenizi kullanın.';
    case 'authentication_failed':
      return 'Doğrulama başarısız. Tekrar deneyin.';
    default:
      return 'Doğrulama yapılamadı. Tekrar deneyin veya çıkış yapın.';
  }
}

/** Biyometri hic kullanilamaz (kayit / sifre yok): kilit kapatilir. */
const UNUSABLE = new Set(['not_enrolled', 'not_available', 'passcode_not_set']);

function parseSettings(raw: string | null): LockSettings {
  if (!raw) return DEFAULT_LOCK_SETTINGS;
  try {
    const v = JSON.parse(raw) as Partial<LockSettings>;
    const timeout = typeof v.timeoutMinutes === 'number' && (LOCK_TIMEOUT_OPTIONS as readonly number[]).includes(v.timeoutMinutes) ? v.timeoutMinutes : DEFAULT_LOCK_TIMEOUT_MINUTES;
    return { enabled: v.enabled === true, timeoutMinutes: timeout };
  } catch {
    return DEFAULT_LOCK_SETTINGS;
  }
}

export class AppLockService {
  private state: AppLockState = { status: 'checking', userId: null, settings: DEFAULT_LOCK_SETTINGS, biometric: null, authenticating: false, error: null };
  private listeners = new Set<() => void>();
  private backgroundAt: number | null = null;
  /** Kullanici degisince artar: eski kullanicinin gec gelen sonucu yok sayilir. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  getState = (): AppLockState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(next: Partial<AppLockState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  private async load(userId: string): Promise<LockSettings> {
    return parseSettings(await this.deps.storage.get(lockStorageKey(userId)));
  }

  private async save(userId: string, settings: LockSettings): Promise<void> {
    if (this.state.userId === userId) this.patch({ settings });
    await this.deps.storage.set(lockStorageKey(userId), JSON.stringify({ enabled: settings.enabled, timeoutMinutes: settings.timeoutMinutes }));
  }

  /** Kayitli biyometri yoksa kilidi kapatir ve bildirir; kullanilabilirse true. */
  private async usable(userId: string, gen: number): Promise<boolean> {
    const status = await this.deps.biometrics.status();
    if (gen !== this.generation) return false;
    this.patch({ biometric: status });
    if (status.hardware && status.enrolled) return true;
    await this.autoDisable(userId);
    return false;
  }

  private async autoDisable(userId: string): Promise<void> {
    await this.save(userId, { ...this.state.settings, enabled: false });
    this.deps.onAutoDisabled?.();
  }

  /** Oturum yok (acilista veya cikis / 401 sonrasi): kilit yok. */
  clear(): void {
    this.generation++;
    this.backgroundAt = null;
    this.patch({ status: 'unlocked', userId: null, settings: DEFAULT_LOCK_SETTINGS, authenticating: false, error: null });
  }

  /** Soguk acilis: saklanan oturum geri yuklendi. Kilit acik ve kullanilabilirse kilitli baslar. */
  async onRestored(userId: string): Promise<void> {
    const gen = ++this.generation;
    this.backgroundAt = null;
    this.patch({ status: 'checking', userId, error: null, authenticating: false });
    const settings = await this.load(userId);
    if (gen !== this.generation) return;
    this.patch({ settings });
    if (!settings.enabled) {
      this.patch({ status: 'unlocked' });
      return;
    }
    const ok = await this.usable(userId, gen);
    if (gen !== this.generation) return;
    this.patch({ status: ok ? 'locked' : 'unlocked' });
  }

  /** Etkilesimli giris: kullanici sifresiyle dogruladi; kilitsiz baslar, tercihi okunur. */
  async onSignedIn(userId: string): Promise<void> {
    const gen = ++this.generation;
    this.backgroundAt = null;
    this.patch({ status: 'unlocked', userId, settings: DEFAULT_LOCK_SETTINGS, error: null, authenticating: false });
    const settings = await this.load(userId);
    if (gen === this.generation) this.patch({ settings });
  }

  /** AppState degisimi (kok yerlesimde). Arka planda gecen sure kilit suresini asarsa kilitlenir. */
  onAppState(next: AppStateValue): void {
    const { userId, settings, status, authenticating } = this.state;
    if (next === 'background') {
      if (!authenticating && userId && settings.enabled && status === 'unlocked') this.backgroundAt = this.now();
      return;
    }
    if (next !== 'active') return;
    const since = this.backgroundAt;
    this.backgroundAt = null;
    if (since === null || !userId || !settings.enabled || status !== 'unlocked') return;
    if (this.now() - since >= settings.timeoutMinutes * 60_000) void this.relock(userId);
  }

  private async relock(userId: string): Promise<void> {
    const gen = this.generation;
    this.patch({ status: 'checking', error: null });
    const ok = await this.usable(userId, gen);
    if (gen !== this.generation) return;
    this.patch({ status: ok ? 'locked' : 'unlocked' });
  }

  /** Kilit ekrani: sistem istemi (Face ID / parmak izi, gerekirse cihaz sifresi). */
  async unlock(): Promise<boolean> {
    const { status, authenticating, userId } = this.state;
    if (status !== 'locked' || authenticating || !userId) return false;
    const gen = this.generation;
    this.patch({ authenticating: true, error: null });
    const result = await this.deps.biometrics.authenticate('YÖNESİST kilidini açın');
    if (gen !== this.generation) return false;
    if (result.ok) {
      this.patch({ status: 'unlocked', authenticating: false, error: null });
      return true;
    }
    if (UNUSABLE.has(result.error)) {
      // Kayitli yuz / parmak izi kaldirilmis (cihaz sifresi gerektirir): kilit kapanir.
      this.patch({ authenticating: false });
      await this.autoDisable(userId);
      if (gen === this.generation) this.patch({ status: 'unlocked' });
      return true;
    }
    this.patch({ authenticating: false, error: unlockErrorMessage(result.error) });
    return false;
  }

  /** Hesabım acilinca: cihaz durumu (anahtarin etkinligi); acik kilit artik kullanilamiyorsa kapatilir. */
  async refreshBiometric(): Promise<BiometricStatus | null> {
    const { userId } = this.state;
    if (!userId) return null;
    const gen = this.generation;
    const status = await this.deps.biometrics.status();
    if (gen !== this.generation) return null;
    this.patch({ biometric: status });
    if (this.state.settings.enabled && !(status.hardware && status.enrolled)) await this.autoDisable(userId);
    return status;
  }

  /** Hesabım anahtari. Acarken once dogrulama istenir (kullanici calistigini gorur); kapatmak serbest. */
  async setEnabled(enabled: boolean): Promise<EnableResult> {
    const { userId, settings } = this.state;
    if (!userId) return { ok: false, message: 'Oturum bulunamadı.' };
    const gen = this.generation;
    if (!enabled) {
      await this.save(userId, { ...settings, enabled: false });
      return { ok: true };
    }
    const status = await this.deps.biometrics.status();
    if (gen !== this.generation) return { ok: false, message: 'Oturum değişti.' };
    this.patch({ biometric: status });
    if (!status.hardware) return { ok: false, message: 'Bu cihazda Face ID / parmak izi doğrulaması yok.' };
    if (!status.enrolled) return { ok: false, message: 'Cihazda kayıtlı Face ID / parmak izi yok. Önce cihaz ayarlarından ekleyin.' };
    this.patch({ authenticating: true });
    const result = await this.deps.biometrics.authenticate('Uygulama kilidini açmak için doğrulayın');
    if (gen !== this.generation) return { ok: false, message: 'Oturum değişti.' };
    this.patch({ authenticating: false });
    if (!result.ok) return { ok: false, message: 'Uygulama kilidi etkinleştirilmedi: doğrulama tamamlanmadı.' };
    await this.save(userId, { ...this.state.settings, enabled: true });
    return { ok: true };
  }

  async setTimeoutMinutes(minutes: number): Promise<void> {
    const { userId, settings } = this.state;
    if (!userId || !(LOCK_TIMEOUT_OPTIONS as readonly number[]).includes(minutes)) return;
    await this.save(userId, { ...settings, timeoutMinutes: minutes });
  }
}
