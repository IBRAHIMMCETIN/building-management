import { env } from '@/config/env';
import { apiClient } from '@/lib/api/client';
import { type MeContexts, meContextsSchema } from './contextsSchema';
import { mockContextsFor } from './mockAdapter';
import type { AuthSession } from './session';

/**
 * Kullanicinin secebilecegi apartman/rol baglamlari. Cognito modunda `GET /api/me/contexts`
 * (rol gerektirmeyen uc), mock modunda yerel senaryo verisi.
 */
export async function fetchContexts(session: AuthSession, signal?: AbortSignal): Promise<MeContexts> {
  if (env.authMode === 'mock') {
    const { claims } = session;
    return {
      userId: claims.sub,
      email: claims.email,
      ...mockContextsFor(claims.email ?? ''),
      active: claims.role ? { role: claims.role, apartmentId: claims.apartmentId } : null,
    };
  }
  return apiClient.get('/api/me/contexts', { signal, schema: meContextsSchema });
}

export type { MeContexts, SelectableContext } from './contextsSchema';
