import { AuthRequiredError } from '@bm/shared/api/errors';
import { type ActiveContext, type AuthAdapter, type AuthSession, type SignInStep, type TokenUse, apiTokenFor, isExpiring } from '@bm/shared/auth/session';

/*
 * React disindaki tek oturum kaynagi (web: apps/web/src/lib/auth/sessionManager.ts). apiClient
 * token'i buradan alir, AuthProvider buraya abone olur (useSyncExternalStore). Mobilde destek modu
 * (platform yoneticisi) ve zorunlu MFA kurulumu yoktur: yonetim rolleri paneli web'de kullanir.
 * Web'den farki: adapter ve token turu disaridan verilir (test edilebilir, env'e bagimli degil).
 */

export type SessionState = { status: 'initializing'; session: null } | { status: 'ready'; session: AuthSession | null };

type Listener = () => void;

export class SessionManager {
  private state: SessionState = { status: 'initializing', session: null };
  private listeners = new Set<Listener>();
  private expiredNotice: 'unauthorized' | null = null;
  /** Ayni anda gelen 401'ler tek bir yenileme cagrisini paylasir (single-flight). */
  private refreshing: Promise<AuthSession> | null = null;
  readonly ready: Promise<void>;

  constructor(
    private readonly adapter: AuthAdapter,
    private readonly tokenUse: TokenUse,
  ) {
    // Uygulama acilisinda saklanan oturum bir kez geri yuklenir.
    this.ready = adapter
      .restore()
      .catch(() => null)
      .then((session) => this.setState({ status: 'ready', session }));
  }

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
    this.setState({ status: 'ready', session });
  }

  private applyStep(step: SignInStep): SignInStep {
    if (step.type === 'done') this.set(step.session);
    return step;
  }

  async signIn(input: { email: string; password: string }): Promise<SignInStep> {
    this.expiredNotice = null;
    return this.applyStep(await this.adapter.signIn(input));
  }

  async confirmNewPassword(newPassword: string): Promise<SignInStep> {
    return this.applyStep(await this.adapter.confirmNewPassword(newPassword));
  }

  async confirmTotp(code: string): Promise<SignInStep> {
    return this.applyStep(await this.adapter.confirmTotp(code));
  }

  requestPasswordReset(email: string): Promise<{ destination?: string }> {
    return this.adapter.requestPasswordReset(email);
  }

  confirmPasswordReset(input: { email: string; code: string; newPassword: string }): Promise<void> {
    return this.adapter.confirmPasswordReset(input);
  }

  async signOut(): Promise<void> {
    const current = this.state.session;
    this.set(null);
    await this.adapter.signOut(current);
  }

  /** Oturum sunucuda gecersiz (401 / yenileme basarisiz): saklanan token'lar da silinir. */
  expire(): void {
    const current = this.state.session;
    if (!current) return;
    this.expiredNotice = 'unauthorized';
    this.set(null);
    void this.adapter.signOut(current).catch(() => undefined);
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
    const next = await this.adapter.setActiveContext(current, context);
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

    this.refreshing ??= this.adapter
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

  /** API'ye gidecek token; suresi dolmak uzereyse once yenilenir; oturum yoksa null. */
  async getApiToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    await this.ready;
    let session = this.state.session;
    if (!session) return null;
    if (options.forceRefresh || isExpiring(session)) session = await this.refresh();
    return apiTokenFor(session, this.tokenUse);
  }
}
