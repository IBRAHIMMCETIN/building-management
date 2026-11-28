import type { MeContexts } from '@bm/shared/auth/contextsSchema';
import { mockContextsFor } from '@bm/shared/auth/mockScenarios';
import { type AuthAdapter, type AuthSession, apiTokenFor } from '@bm/shared/auth/session';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode, createContext, use } from 'react';
import type { AppEnv } from '@/config/env';
import { type ApiClient, createApiClient } from '@/lib/api/createApiClient';
import { endpoints } from '@/lib/api/endpoints';
import { createAuthAdapter } from '@/lib/auth/adapter';
import { SessionManager } from '@/lib/auth/sessionManager';
import { AUTO_DISABLED_MESSAGE, AppLockService, type LockStorage } from '@/lib/lock/appLock';
import { biometrics as defaultBiometrics } from '@/lib/lock/biometrics';
import type { BiometricAdapter } from '@/lib/lock/types';
import { type NoticeStore, createNoticeStore } from '@/lib/notices';
import { notificationsAdapter } from '@/lib/push/notificationsAdapter';
import { PushService } from '@/lib/push/pushService';
import type { NotificationsAdapter } from '@/lib/push/types';
import { preferences } from '@/lib/storage/preferences';
import { secureStorage } from '@/lib/storage/secureStorage';
import type { KeyValueStorage } from '@/lib/storage/types';

/**
 * Uygulama servisleri: oturum yoneticisi, API istemcisi ve baglam listesi. Kok yerlesimde bir kez
 * olusturulur ve baglamla verilir; testler sahte adapter / fetch ile kendi orneklerini kurar
 * (web'deki modul duzeyi tekiller yerine).
 */
export type Services = {
  env: AppEnv;
  session: SessionManager;
  api: ApiClient;
  /** Secilebilir apartman/rol baglamlari: cognito'da `GET /api/me/contexts`, mock'ta yerel senaryo. */
  fetchContexts: (session: AuthSession, signal?: AbortSignal) => Promise<MeContexts>;
  /** Imzali S3 linkine fotograf PUT'u (yetki basligi yok; demo modunda sahte API). */
  rawFetch: typeof fetch;
  /** Mobil bildirim kaydi; oturum kancalarina bagli (giris -> kayit, cikis -> silme). */
  push: PushService;
  notifications: NotificationsAdapter;
  /** Uygulama geneli bilgi notu (ust bant). */
  notices: NoticeStore;
  /** Face ID / parmak izi ile uygulama kilidi (kullanici basina, istege bagli). */
  lock: AppLockService;
};

export type ServiceOverrides = {
  adapter?: AuthAdapter;
  fetchImpl?: typeof fetch;
  notifications?: NotificationsAdapter;
  /** Push cihaz kaydinin deposu (varsayilan: guvenli depo). */
  pushStorage?: KeyValueStorage;
  biometrics?: BiometricAdapter;
  /** Kilit tercihinin deposu (varsayilan: AsyncStorage tercihleri; gizli degil). */
  lockStorage?: LockStorage;
};

/**
 * Demo verisi yalnizca gelistirme paketinde yuklenir: demo modu mock kimlik ister, mock kimlik de
 * yalnizca `__DEV__` paketinde gecerlidir (config/env.ts). Uretim paketinde Metro `__DEV__`'i
 * `false` yapar ve bu dal sabit katlamayla silinir; demo dosyalari (ornek veri) pakete girmez.
 */
function demoFetch(env: AppEnv): typeof fetch | undefined {
  if (__DEV__ && env.apiMode === 'demo') {
    const { createDemoFetch } = require('./dev/demoApi') as typeof import('./dev/demoApi');
    return createDemoFetch();
  }
  return undefined;
}

export function createServices(env: AppEnv, overrides: ServiceOverrides = {}): Services {
  const session = new SessionManager(overrides.adapter ?? createAuthAdapter(env), env.tokenUse);
  const fetchImpl = overrides.fetchImpl ?? demoFetch(env);
  const api = createApiClient({
    baseUrl: env.apiMode === 'demo' ? '' : env.apiUrl,
    getToken: (options) => session.getApiToken(options),
    onAuthFailure: () => session.expire(),
    // Cevrimdisi (NetInfo -> React Query onlineManager; hooks/useNetwork.ts): yazan istekler gonderilmez.
    isOnline: () => onlineManager.isOnline(),
    fetchImpl,
  });

  const fetchContexts = async (current: AuthSession, signal?: AbortSignal): Promise<MeContexts> => {
    // Mock kimlik + gercek (yerel) API: web gibi yerel senaryo. Demo veride liste demo API'den gelir
    // (sakin baglaminda ozetle ayni daire ve malik iliskisi).
    if (env.authMode === 'mock' && env.apiMode !== 'demo') {
      const { claims } = current;
      return {
        userId: claims.sub,
        email: claims.email,
        ...mockContextsFor(claims.email ?? ''),
        active: claims.role ? { role: claims.role, apartmentId: claims.apartmentId } : null,
      };
    }
    return endpoints.meContexts(api, signal);
  };

  const notifications = overrides.notifications ?? notificationsAdapter;
  const push = new PushService({
    adapter: notifications,
    api,
    storage: overrides.pushStorage ?? secureStorage,
    preferences,
    getSession: () => session.getSession(),
    tokenFor: (s) => apiTokenFor(s, env.tokenUse),
    log: (message) => console.info(message),
  });
  session.setHooks({
    afterSignIn: (s) => push.onSignedIn(s),
    // Giden oturumun token'i kancanin basinda alinir; silme kancanin 3 sn sinirindan sonra da dogrulanir.
    beforeSignOut: (s) => push.beginSignOut(s),
  });
  // Kullanici degisti / oturum dustu (401 dahil): izin aciklamasi ve kayit durumu sifirlanir.
  session.onScopeChange((prev, next) => push.onSessionChange(prev, next));
  // Acilista geri yuklenen oturum: izin verilmisse yalnizca token degistiyse yeniden kayit (istem yok).
  void session.ready.then(() => {
    const restored = session.getSession();
    if (restored) void push.onRestored(restored);
  });

  const notices = createNoticeStore();
  const lock = new AppLockService({
    biometrics: overrides.biometrics ?? defaultBiometrics,
    storage: overrides.lockStorage ?? preferences,
    onAutoDisabled: () => notices.show(AUTO_DISABLED_MESSAGE, 'warning'),
  });
  // Kilit: soguk acilista geri yuklenen oturum kilitli baslayabilir; etkilesimli giris kilitsiz; cikis temizler.
  session.onScopeChange((prev, next) => {
    if (!next) lock.clear();
    else if (prev?.claims.sub !== next.claims.sub) void lock.onSignedIn(next.claims.sub);
  });
  void session.ready.then(() => {
    const restored = session.getSession();
    if (restored) void lock.onRestored(restored.claims.sub);
    else lock.clear();
  });

  const rawFetch = fetchImpl ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
  return { env, session, api, fetchContexts, rawFetch, push, notifications, notices, lock };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

export function useServices(): Services {
  const ctx = use(ServicesContext);
  if (!ctx) throw new Error('useServices, ServicesProvider icinde kullanilmalidir');
  return ctx;
}
