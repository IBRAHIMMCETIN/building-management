import { type NotificationPreferencesInput, notificationPreferencesSchema } from '@bm/shared/api/notificationPreferences';
import { z } from 'zod';
import { apiClient } from './client';

/**
 * GET|PUT /api/me/notification-preferences. Sema, kategoriler ve Turkce etiketler
 * packages/shared/src/api/notificationPreferences.ts'te (web + mobil ortak); burada yalnizca uclar.
 * PUT yalnizca DEGISEN alani gonderir (iki cihaz / eski sekme birbirinin secimini ezmez).
 */
export * from '@bm/shared/api/notificationPreferences';

/**
 * GET /api/me/devices: kullanicinin AKTIF mobil cihazlari (en son gorulen once; token donmez). Web yalnizca
 * "en az bir cihaz var mi" icin okur: Hesabım'daki "Mobil bildirim" bolumu buna bagli.
 */
export const myDevicesSchema = z.object({
  devices: z.array(z.object({ deviceId: z.string(), platform: z.string(), lastSeenAt: z.string(), appVersion: z.string().optional() }).loose()),
});
export type MyDevices = z.infer<typeof myDevicesSchema>;

export const notificationPreferencesApi = {
  get: (signal?: AbortSignal) => apiClient.get('/api/me/notification-preferences', { signal, schema: notificationPreferencesSchema }),
  put: (prefs: NotificationPreferencesInput) => apiClient.put('/api/me/notification-preferences', prefs, { schema: notificationPreferencesSchema }),
  devices: (signal?: AbortSignal) => apiClient.get('/api/me/devices', { signal, schema: myDevicesSchema }),
};
