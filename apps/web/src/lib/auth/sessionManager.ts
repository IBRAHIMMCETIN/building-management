import { env } from '@/config/env';
import { AuthRequiredError } from '@/lib/api/errors';
import { authAdapter } from './index';
import { type ActiveContext, type AuthSession, type SignInStep, apiTokenFor, isExpiring } from './session';

export type SessionState =
  | { status: 'initializing'; session: null }
  | { status: 'ready'; session: AuthSession | null };

type Listener = () => void;

/**
 * React disindaki tek oturum kaynagi. apiClient token'i buradan alir, AuthContext
 * buraya abone olur (useSyncExternalStore). Boylece istemci React agacina bagli kalmaz.
 */
class SessionManager {
  private state: SessionState = { status: 'initializing', session: null };
  private listeners = new Set<Listener>();
  /** Ayni anda gelen 401'ler tek bir yenileme cagrisini paylasir (single-flight). */
  private refreshing: Promise<AuthSession> | null = null;

  /** Uygulama acilisinda saklanan oturumu bir kez geri yukler. */
  readonly ready: Promise<void> = authAdapter
    .restore()
    .catch(() => null)
    .then((session) => this.setState({ status: 'ready', session }));

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
        this.set(null);
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
