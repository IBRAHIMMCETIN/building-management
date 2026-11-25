import { z } from 'zod';
import { apiClient } from './client';

/** GET|PUT /api/me/notification-preferences (kayit yoksa varsayilan: e-posta acik). Rol claim'i gerektirmez. */
export const notificationPreferencesSchema = z.object({
  email: z.object({ enabled: z.boolean() }),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const notificationPreferencesApi = {
  get: (signal?: AbortSignal) => apiClient.get('/api/me/notification-preferences', { signal, schema: notificationPreferencesSchema }),
  put: (prefs: NotificationPreferences) => apiClient.put('/api/me/notification-preferences', prefs, { schema: notificationPreferencesSchema }),
};
