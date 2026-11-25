import { z } from 'zod';
import { apiClient } from './client';

/**
 * GET|PUT /api/me/notification-preferences (kayit yoksa varsayilan: e-posta acik). Rol claim'i gerektirmez.
 * O1-6: `email.tickets` ariza / talep e-postalari (yoksa acik; ana anahtar kapaliysa hicbiri gitmez).
 */
export const notificationPreferencesSchema = z.object({
  email: z.object({ enabled: z.boolean(), tickets: z.boolean().optional() }),
});

/** Ariza e-postalari: kayitli tercih yoksa acik. */
export const ticketEmailsEnabled = (p: NotificationPreferences) => p.email.tickets !== false;
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const notificationPreferencesApi = {
  get: (signal?: AbortSignal) => apiClient.get('/api/me/notification-preferences', { signal, schema: notificationPreferencesSchema }),
  put: (prefs: NotificationPreferences) => apiClient.put('/api/me/notification-preferences', prefs, { schema: notificationPreferencesSchema }),
};
