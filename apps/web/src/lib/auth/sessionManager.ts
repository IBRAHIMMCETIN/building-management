import { env } from '@/config/env';
import { AuthRequiredError } from '@/lib/api/errors';
import { authAdapter } from './index';
import { type ActiveContext, type AuthSession, type SignInStep, apiTokenFor, isExpiring } from './session';

/**
 * Platform yoneticisinin destek modu: istekler `X-Support-Session` ile o apartmana SALT OKUNUR
 * (denetci) gider. Sekme bazlidir (sessionStorage); ana oturum ayrica korunur.
 */
export type SupportMode = {
  apartmentId: string;
  apartmentName?: string;
  sessionId: string;
  header: string;
  expiresAt: string;
  /** Oturumu acan kullanici (baska kullaniciya tasinmasin). */
  sub: string;
};

export type SupportEndReason = 'ended' | 'expired' | 'rejected';

export type SessionState =
  | { status: 'initializing'; session: null; mfaRequired?: false; support?: undefined }
  /** `mfaRequired`: API bu oturumda `403 MFA_REQUIRED` dondu (token eski olsa bile kurulum gerekli). */
  | { status: 'ready'; session: AuthSession | null; mfaRequired?: boolean; support?: SupportMode };

const SUPPORT_KEY = 'bm.support-session';

function readStoredSupport(): SupportMode | undefined {
  try {
    const raw = sessionStorage.getItem(SUPPORT_KEY);
    return raw ? (JSON.parse(raw) as SupportMode) : undefined;
  } catch {
    return undefined;
  }
}

function storeSupport(mode: SupportMode | undefined) {
  try {
    if (mode) sessionStorage.setItem(SUPPORT_KEY, JSON.stringify(mode));
    else sessionStorage.removeItem(SUPPORT_KEY);
  } catch {
    // depolama yoksa yalnizca bellekte
  }
}

const supportUsable = (mode: SupportMode | undefined, session: AuthSession | null, now = Date.now()): mode is SupportMode =>
  !!mode && !!session && session.claims.role === 'platform_admin' && mode.sub === session.claims.sub && Date.parse(mode.expiresAt) > now;

type Listener = () => void;

/**
 * React disindaki tek oturum kaynagi. apiClient token'i buradan alir, AuthContext
 * buraya abone olur (useSyncExternalStore). Boylece istemci React agacina bagli kalmaz.
 */
class SessionManager {
  private state: SessionState = { status: 'initializing', session: null };
  private listeners = new Set<Listener>();
  /** Oturumun sunucu tarafindan dusuruldugu bilgisi (giris ekraninda bir kez gosterilir). */
  private expiredNotice: 'unauthorized' | null = null;
  /** Ayni anda gelen 401'ler tek bir yenileme cagrisini paylasir (single-flight). */
  private refreshing: Promise<AuthSession> | null = null;
  /** Destek modu neden kapandi (arayuzde bir kez gosterilir). */
  private supportNotice: SupportEndReason | null = null;

  /** Uygulama acilisinda saklanan oturumu bir kez geri yukler (destek modu dahil, gecerliyse). */
  readonly ready: Promise<void> = authAdapter
    .restore()
    .catch(() => null)
    .then((session) => {
      const stored = readStoredSupport();
      const support = supportUsable(stored, session) ? stored : undefined;
      if (stored && !support) storeSupport(undefined);
      this.setState({ status: 'ready', session, ...(support ? { support } : {}) });
    });

  getState = (): SessionState => this.state;
  getSession = (): AuthSession | null => this.state.session;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(state: SessionState) {
    this.state = state;
    for (const l of this.listeners) l();
  }

  set(session: AuthSession | null): void {
    // API'nin MFA_REQUIRED isareti ayni kullanici TOTP'yi etkinlestirene kadar korunur.
    const prev = this.state.session;
    const mfaRequired =
      !!session && !!this.state.mfaRequired && prev?.claims.sub === session.claims.sub && !session.claims.mfa?.enabled;
    // Destek modu yalnizca ayni platform yoneticisinin oturumunda surer.
    const support = supportUsable(this.state.support, session) ? this.state.support : undefined;
    if (this.state.support && !support) storeSupport(undefined);
    this.setState({ status: 'ready', session, mfaRequired, ...(support ? { support } : {}) });
  }

  /** Destek modunu baslatir (API'de oturum acildiktan sonra). */
  startSupport(mode: Omit<SupportMode, 'sub'>): void {
    const session = this.state.session;
    if (!session || session.claims.role !== 'platform_admin') throw new Error('Destek modu yalnızca platform yöneticisi içindir');
    const full: SupportMode = { ...mode, sub: session.claims.sub };
    storeSupport(full);
    this.supportNotice = null;
    this.setState({ status: 'ready', session, mfaRequired: this.state.mfaRequired, support: full });
  }

  /** Destek modunu kapatir; ana (platform) oturum korunur. */
  endSupport(reason: SupportEndReason = 'ended'): void {
    if (!this.state.support) return;
    storeSupport(undefined);
    if (reason !== 'ended') this.supportNotice = reason;
    this.setState({ status: 'ready', session: this.state.session, mfaRequired: this.state.mfaRequired });
  }

  /** Destek modu neden kapandi (bir kez). */
  consumeSupportNotice(): SupportEndReason | null {
    const notice = this.supportNotice;
    this.supportNotice = null;
    return notice;
  }

  /** API istemcisi: gecerli destek basligi; suresi dolduysa mod kapanir. */
  getSupportHeader = (): string | undefined => {
    const mode = this.state.support;
    if (!mode) return undefined;
    if (!supportUsable(mode, this.state.session)) {
      this.endSupport('expired');
      return undefined;
    }
    return mode.header;
  };

  /** API `403 MFA_REQUIRED`: arayuz kurulum ekranina yonlenir. */
  markMfaRequired(): void {
    if (!this.state.session || this.state.mfaRequired || this.state.session.claims.mfa?.enabled) return;
    this.setState({ ...this.state, status: 'ready', session: this.state.session, mfaRequired: true });
  }

  private applyStep(step: SignInStep): SignInStep {
    if (step.type === 'done') this.set(step.session);
    return step;
  }

  async signIn(input: { email: string; password: string }): Promise<SignInStep> {
    this.expiredNotice = null;
    return this.applyStep(await authAdapter.signIn(input));
  }

  async confirmNewPassword(newPassword: string): Promise<SignInStep> {
    return this.applyStep(await authAdapter.confirmNewPassword(newPassword));
  }

  async confirmTotp(code: string): Promise<SignInStep> {
    return this.applyStep(await authAdapter.confirmTotp(code));
  }

  async signOut(): Promise<void> {
    const current = this.state.session;
    this.set(null);
    await authAdapter.signOut(current);
  }

  /**
   * Oturum sunucuda gecersiz (401 / yenileme basarisiz): bellekteki oturumla birlikte
   * adapter'in sakladigi token'lar da silinir. Yalnizca `set(null)` yetmez; aksi halde
   * sayfa yenilenince `restore()` ayni gecersiz oturumu geri getirir.
   */
  expire(): void {
    const current = this.state.session;
    if (!current) return;
    this.expiredNotice = 'unauthorized';
    this.set(null);
    void authAdapter.signOut(current).catch(() => undefined);
  }

  /** Giris ekrani: oturum 401 ile dustuyse nedenini bir kez dondurur. */
  consumeExpiredNotice(): 'unauthorized' | null {
    const notice = this.expiredNotice;
    this.expiredNotice = null;
    return notice;
  }

  async setActiveContext(context: ActiveContext): Promise<AuthSession> {
    const current = this.state.session;
    if (!current) throw new AuthRequiredError();
    const next = await authAdapter.setActiveContext(current, context);
    this.set(next);
    // Pre Token Lambda tercihi reddettiyse (yetki bu arada kaldirilmis) claim'ler eslesmez.
    if (next.claims.role !== context.role || next.claims.apartmentId !== context.apartmentId) {
      throw new Error('Seçilen apartman/rol doğrulanamadı. Yetkiniz değişmiş olabilir.');
    }
    return next;
  }

  /** Token yenileme (sure dolumu veya 401 sonrasi). */
  refresh(): Promise<AuthSession> {
    const current = this.state.session;
    if (!current) return Promise.reject(new AuthRequiredError());

    this.refreshing ??= authAdapter
      .refresh(current)
      .then((next) => {
        this.set(next);
        return next;
      })
      .catch((err: unknown) => {
        this.expire();
        throw err instanceof AuthRequiredError ? err : new AuthRequiredError();
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /**
   * API'ye gidecek token (`VITE_COGNITO_TOKEN_USE`'a gore ID veya access).
   * Suresi dolmak uzereyse once yenilenir; oturum yoksa null.
   */
  async getApiToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    await this.ready;
    let session = this.state.session;
    if (!session) return null;
    if (options.forceRefresh || isExpiring(session)) session = await this.refresh();
    return apiTokenFor(session, env.tokenUse);
  }
}

export const sessionManager = new SessionManager();
