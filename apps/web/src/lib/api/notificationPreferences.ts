import { type NotificationPreferencesInput, notificationPreferencesSchema } from '@bm/shared/api/notificationPreferences';
import { apiClient } from './client';

/**
 * GET|PUT /api/me/notification-preferences. Sema, kategoriler ve Turkce etiketler
 * packages/shared/src/api/notificationPreferences.ts'te (web + mobil ortak); burada yalnizca uclar.
 * PUT yalnizca DEGISEN alani gonderir (iki cihaz / eski sekme birbirinin secimini ezmez).
 */
export * from '@bm/shared/api/notificationPreferences';

export const notificationPreferencesApi = {
  get: (signal?: AbortSignal) => apiClient.get('/api/me/notification-preferences', { signal, schema: notificationPreferencesSchema }),
  put: (prefs: NotificationPreferencesInput) => apiClient.put('/api/me/notification-preferences', prefs, { schema: notificationPreferencesSchema }),
};
