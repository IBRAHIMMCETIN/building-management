import type { MeContexts } from '@bm/shared/auth/contextsSchema';
import { mockContextsFor } from '@bm/shared/auth/mockScenarios';
import type { AuthAdapter, AuthSession } from '@bm/shared/auth/session';
import { type ReactNode, createContext, use } from 'react';
import type { AppEnv } from '@/config/env';
import { createDemoFetch } from '@/dev/demoApi';
import { type ApiClient, createApiClient } from '@/lib/api/createApiClient';
import { endpoints } from '@/lib/api/endpoints';
import { createAuthAdapter } from '@/lib/auth/adapter';
import { SessionManager } from '@/lib/auth/sessionManager';

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
};

export type ServiceOverrides = { adapter?: AuthAdapter; fetchImpl?: typeof fetch };

export function createServices(env: AppEnv, overrides: ServiceOverrides = {}): Services {
  const session = new SessionManager(overrides.adapter ?? createAuthAdapter(env), env.tokenUse);
  const fetchImpl = overrides.fetchImpl ?? (env.apiMode === 'demo' ? createDemoFetch() : undefined);
  const api = createApiClient({
    baseUrl: env.apiMode === 'demo' ? '' : env.apiUrl,
    getToken: (options) => session.getApiToken(options),
    onAuthFailure: () => session.expire(),
    fetchImpl,
  });

  const fetchContexts = async (current: AuthSession, signal?: AbortSignal): Promise<MeContexts> => {
    if (env.authMode === 'mock') {
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

  return { env, session, api, fetchContexts };
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
