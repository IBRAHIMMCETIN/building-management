import { env } from '@/config/env';
import { sessionManager } from '@/lib/auth/sessionManager';
import { createApiClient } from './createApiClient';

export type { ApiClient, ApiClientConfig, RequestOptions, TokenProvider } from './createApiClient';

/** Uygulamanin tek API istemcisi. Token: VITE_COGNITO_TOKEN_USE (LITE'ta 'id' -> ID token). */
export const apiClient = createApiClient({
  baseUrl: env.apiUrl,
  getToken: (options) => sessionManager.getApiToken(options),
  onAuthFailure: () => sessionManager.expire(),
  onMfaRequired: () => sessionManager.markMfaRequired(),
});
