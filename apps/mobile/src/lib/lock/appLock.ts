import type { BiometricAdapter, BiometricStatus } from './types';

/*
 * Uygulama kilidi (Hesabım -> "Face ID / parmak izi ile kilit"), kullanici basina ve istege bagli.
 *
 *  - Acik ise: soguk acilista (saklanan oturum geri yuklenince) ve uygulama arka planda ayarlanan
 *    sureden (varsayilan 5 dk) uzun kaldiysa kilit ekrani; Face ID / parmak izi, tutmazsa cihaz sifresi.
 *  - Etkilesimli giriste kilit yok (kullanici sifresiyle dogruladi). Kilit ekraninda "Çıkış yap" vardir.
 *  - Kimlik bilgisi SAKLANMAZ: token'lar yine Keychain / Keystore'da (oturum yoneticisi); burada yalnizca
 *    `{ enabled, timeoutMinutes }` tercihi kullanici kimligiyle anahtarlanir: asil kayit guvenli depoda
 *    (Keychain / Keystore), gizli olmayan "acik" isareti AsyncStorage'da. Biri okunamazsa digeri "acik"
 *    diyorsa kilit acik sayilir (okuma hatasi "kilit kapali" demek degildir).
 *  - Cihazda kayitli yuz / parmak izi KESIN olarak yoksa (sonradan silindiyse de) kilit kendiliginden
 *    kapanir ve bir kez bildirilir. Durum okunamazsa / gecici hatada kilit acik kalir, cihaz sifresi kalir.
 *  - Gizlilik ortusu: kilit aciksa uygulama `inactive` / `background`a gecince icerik logo ile ortulur
 *    (uygulama degistirici goruntusu, kilit penceresinden onceki an); kilit karari verilince kalkar.
 *  - Sistem istemi kendiliginden yalnizca kilitlenince ve gercek bir arka plan -> on plan gecisinde
 *    (istemin bitisinden en az 1 sn sonra) acilir; istemin kendi yarattigi `inactive` / `background`
 *    gecisi yeni istem acmaz. Vazgecilince "Kilidi aç" dugmesi beklenir.
 */

export const LOCK_TIMEOUT_OPTIONS = [1, 5, 15] as const;
export const DEFAULT_LOCK_TIMEOUT_MINUTES = 5;
/** Istem bittikten sonra bu sure icindeki on plana gelis yeni istem acmaz (istemin kendi gecisi). */
export const REPROMPT_GUARD_MS = 1000;

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
  /** Gizlilik ortusu (kilit acik + uygulama on planda degil / kilit karari bekleniyor). */
  covered: boolean;
};

/** `get` okuyamazsa hata FIRLATABILIR (guvenli depo); hata "kayit yok" sayilmaz. */
export type LockStorage = { get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void> };

export type EnableResult = { ok: true } | { ok: false; message: string };

type Deps = {
  biometrics: BiometricAdapter;
  /** Asil kayit (guvenli depo). */
  storage: LockStorage;
  /** Gizli olmayan "kilit acik" isareti (AsyncStorage); guvenli depo okunamazsa / kaybolursa kilit acik kalir. */
  marker?: LockStorage;
  now?: () => number;
  /** Kayitli biyometri olmadigi icin kilit kapatildi (uygulama geneli not). */
  onAutoDisabled?: () => void;
};

type AppStateValue = 'active' | 'background' | 'inactive' | 'unknown' | 'extension' | null | undefined;

/** Guvenli depo anahtari (secureStorage gecersiz karakterleri kacirir). */
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
      return 'Doğrulama yapılamadı. "Kilidi aç"a dokunup cihaz şifrenizi kullanın veya çıkış yapın.';
  }
}

/** Bu hatalar biyometrinin kullanilamadigini dusundurur; kilit yalnizca cihaz durumu da dogrularsa kapanir. */
const MAYBE_UNUSABLE = new Set(['not_enrolled', 'not_available', 'passcode_not_set']);

/** Cihazda kesin olarak kullanilabilir biyometri yok (durum okunabildi). */
const definitelyUnusable = (s: BiometricStatus) => !s.error && !(s.hardware && s.enrolled);

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
  private state: AppLockState = { status: 'checking', userId: null, settings: DEFAULT_LOCK_SETTINGS, biometric: null, authenticating: false, error: null, covered: false };
  private listeners = new Set<() => void>();
  private backgroundAt: number | null = null;
  private appState: AppStateValue = 'active';
  private promptEndedAt = Number.NEGATIVE_INFINITY;
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
    const key = lockStorageKey(userId);
    const markerOn = this.deps.marker ? await this.deps.marker.get(key).then((v) => v === '1', () => false) : false;
    let raw: string | null;
    try {
      raw = await this.deps.storage.get(key);
    } catch {
      // Guvenli depo okunamadi: isaret "acik" diyorsa kilit acik (fail locked), yoksa kapali.
      return { ...DEFAULT_LOCK_SETTINGS, enabled: markerOn };
    }
    const settings = parseSettings(raw);
    // Asil kayit kaybolmus / bozulmus ama kilit acilmisti: kapali sayilmaz.
    return markerOn && !settings.enabled ? { ...settings, enabled: true } : settings;
  }

  private async save(userId: string, settings: LockSettings): Promise<void> {
    if (this.state.userId === userId) this.patch({ settings });
    const key = lockStorageKey(userId);
    await this.deps.storage.set(key, JSON.stringify({ enabled: settings.enabled, timeoutMinutes: settings.timeoutMinutes }));
    await this.deps.marker?.set(key, settings.enabled ? '1' : null).catch(() => undefined);
  }

  private async readStatus(): Promise<BiometricStatus> {
    try {
      return await this.deps.biometrics.status();
    } catch {
      return { hardware: false, enrolled: false, kind: null, error: true };
    }
  }

  /**
   * Kilit kullanilabilir mi: cihazda kesin olarak biyometri yoksa kilit kapatilir ve bildirilir (false).
   * Durum okunamadiysa kilit acik kalir (true): cihaz sifresiyle acilir.
   */
  private async usable(userId: string, gen: number): Promise<boolean> {
    const status = await this.readStatus();
    if (gen !== this.generation) return false;
    this.patch({ biometric: status });
    if (!definitelyUnusable(status)) return true;
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
    this.patch({ status: 'unlocked', userId: null, settings: DEFAULT_LOCK_SETTINGS, authenticating: false, error: null, covered: false });
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
      this.patch({ status: 'unlocked', covered: false });
      return;
    }
    const ok = await this.usable(userId, gen);
    if (gen !== this.generation) return;
    this.patch(ok ? { status: 'locked' } : { status: 'unlocked', covered: false });
  }

  /** Etkilesimli giris: kullanici sifresiyle dogruladi; kilitsiz baslar, tercihi okunur. */
  async onSignedIn(userId: string): Promise<void> {
    const gen = ++this.generation;
    this.backgroundAt = null;
    this.patch({ status: 'unlocked', userId, settings: DEFAULT_LOCK_SETTINGS, error: null, authenticating: false, covered: false });
    const settings = await this.load(userId);
    if (gen === this.generation) this.patch({ settings });
  }

  /** AppState degisimi (kok yerlesimde). */
  onAppState(next: AppStateValue): void {
    const prev = this.appState;
    this.appState = next;
    const { userId, settings, status, authenticating, covered } = this.state;
    const lockOn = !!userId && settings.enabled;

    if (next === 'inactive' || next === 'background') {
      // Gizlilik ortusu: istem sirasinda (Face ID / cihaz sifresi) ortu acilmaz.
      if (lockOn && !authenticating && !covered) this.patch({ covered: true });
      if (next === 'background' && lockOn && !authenticating && status === 'unlocked' && this.backgroundAt === null) this.backgroundAt = this.now();
      return;
    }
    if (next !== 'active') return;

    if (status === 'locked') {
      if (covered) this.patch({ covered: false });
      // Yalnizca gercek arka plan -> on plan; istemin kendi gecisi ve vazgecme sonrasi tekrar istem yok.
      if (prev === 'background' && !authenticating && this.now() - this.promptEndedAt >= REPROMPT_GUARD_MS) void this.unlock();
      return;
    }
    const since = this.backgroundAt;
    this.backgroundAt = null;
    if (since !== null && lockOn && status === 'unlocked') {
      const elapsed = this.now() - since;
      // Saat geri alindiysa (negatif sure) suresi dolmus sayilir.
      if (elapsed < 0 || elapsed >= settings.timeoutMinutes * 60_000) {
        void this.relock(userId);
        return;
      }
    }
    if (covered && status === 'unlocked') this.patch({ covered: false });
  }

  private async relock(userId: string): Promise<void> {
    const gen = this.generation;
    this.patch({ status: 'checking', error: null, covered: true });
    const ok = await this.usable(userId, gen);
    if (gen !== this.generation) return;
    this.patch(ok ? { status: 'locked', covered: false } : { status: 'unlocked', covered: false });
  }

  /** Kilit ekrani: sistem istemi (Face ID / parmak izi, gerekirse cihaz sifresi). */
  async unlock(): Promise<boolean> {
    const { status, authenticating, userId } = this.state;
    if (status !== 'locked' || authenticating || !userId) return false;
    const gen = this.generation;
    this.patch({ authenticating: true, error: null });
    let result: Awaited<ReturnType<BiometricAdapter['authenticate']>>;
    try {
      result = await this.deps.biometrics.authenticate('YÖNESİST kilidini açın');
    } catch {
      result = { ok: false, error: 'unknown' };
    }
    this.promptEndedAt = this.now();
    if (gen !== this.generation) return false;
    if (result.ok) {
      this.patch({ status: 'unlocked', authenticating: false, error: null, covered: false });
      return true;
    }
    if (MAYBE_UNUSABLE.has(result.error)) {
      // Kayitli yuz / parmak izi kaldirilmis olabilir: cihaz durumu da dogrularsa kilit kapanir.
      const status = await this.readStatus();
      if (gen !== this.generation) return false;
      this.patch({ biometric: status });
      if (definitelyUnusable(status)) {
        this.patch({ authenticating: false });
        await this.autoDisable(userId);
        if (gen === this.generation) this.patch({ status: 'unlocked', covered: false });
        return true;
      }
    }
    this.patch({ authenticating: false, error: unlockErrorMessage(result.error) });
    return false;
  }

  /** Hesabım acilinca: cihaz durumu (anahtarin etkinligi); acik kilit KESIN olarak kullanilamiyorsa kapatilir. */
  async refreshBiometric(): Promise<BiometricStatus | null> {
    const { userId } = this.state;
    if (!userId) return null;
    const gen = this.generation;
    const status = await this.readStatus();
    if (gen !== this.generation) return null;
    this.patch({ biometric: status });
    if (this.state.settings.enabled && definitelyUnusable(status)) await this.autoDisable(userId);
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
    const status = await this.readStatus();
    if (gen !== this.generation) return { ok: false, message: 'Oturum değişti.' };
    this.patch({ biometric: status });
    if (status.error) return { ok: false, message: 'Cihazın Face ID / parmak izi durumu okunamadı. Biraz sonra tekrar deneyin.' };
    if (!status.hardware) return { ok: false, message: 'Bu cihazda Face ID / parmak izi doğrulaması yok.' };
    if (!status.enrolled) return { ok: false, message: 'Cihazda kayıtlı Face ID / parmak izi yok. Önce cihaz ayarlarından ekleyin.' };
    this.patch({ authenticating: true });
    const result = await this.deps.biometrics.authenticate('Uygulama kilidini açmak için doğrulayın').catch(() => ({ ok: false as const, error: 'unknown' }));
    this.promptEndedAt = this.now();
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
