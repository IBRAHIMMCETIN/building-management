import { z } from 'zod';
import { apiClient } from './client';

/**
 * Platform yoneticisinin gerekceli ve sureli destek erisimi (yalnizca `platform_admin`).
 *   POST /api/support/sessions                       { apartmentId, reason (>=20), durationMinutes (5-60) }
 *   GET  /api/support/sessions?apartmentId=          oturum gecmisi
 *   POST /api/support/sessions/:apartmentId/:sessionId/end
 * Oturum, istekte `X-Support-Session: <header>` ile o apartmana SALT OKUNUR (denetci) erisim
 * verir; her istek apartmanin denetim gunlugune yazilir. Bu uclar destek basligi OLMADAN
 * cagrilir (baslikla rol denetciye duser ve 403 alinir).
 */
export const supportSessionSchema = z.object({
  sessionId: z.string(),
  apartmentId: z.string(),
  adminUserId: z.string(),
  reason: z.string(),
  startedAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().optional(),
  active: z.boolean(),
  header: z.string(),
});
export type SupportSessionView = z.infer<typeof supportSessionSchema>;

export const SUPPORT_REASON_MIN = 20;
export const SUPPORT_DURATIONS = [15, 30, 60] as const;

export const supportApi = {
  start: (input: { apartmentId: string; reason: string; durationMinutes: number }) =>
    apiClient.post('/api/support/sessions', input, { schema: supportSessionSchema, support: false }),
  list: (apartmentId: string, signal?: AbortSignal) =>
    apiClient.get('/api/support/sessions', {
      signal,
      query: { apartmentId },
      schema: z.object({ items: z.array(supportSessionSchema) }),
      support: false,
    }),
  end: (apartmentId: string, sessionId: string) =>
    apiClient.post(
      `/api/support/sessions/${encodeURIComponent(apartmentId)}/${encodeURIComponent(sessionId)}/end`,
      undefined,
      { schema: supportSessionSchema, support: false },
    ),
};
