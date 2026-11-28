import { portalAnnouncementSchema } from '@bm/shared/api/announcements';
import { signedDownloadSchema } from '@bm/shared/api/documents';
import { type NotificationPreferencesInput, notificationPreferencesSchema } from '@bm/shared/api/notificationPreferences';
import { quoteSchema } from '@bm/shared/api/payments';
import { myStatementSchema, mySummarySchema } from '@bm/shared/api/portal';
import { ticketListSchema } from '@bm/shared/api/tickets';
import { meContextsSchema } from '@bm/shared/auth/contextsSchema';
import { z } from 'zod';
import type { ApiClient } from './createApiClient';

/*
 * M1'in kullandigi API uclari (web karsiliklari: apps/web/src/lib/api/portal.ts, announcements.ts,
 * payments.ts, portalTickets.ts, documents.ts, notificationPreferences.ts, lib/auth/contexts.ts).
 * Portal uclari: `unitId` yalnizca birden fazla dairesi olan sakin icin gonderilir.
 */

const unitQuery = (unitId?: string) => (unitId ? { unitId } : undefined);
const enc = encodeURIComponent;

export const endpoints = {
  meContexts: (api: ApiClient, signal?: AbortSignal) => api.get('/api/me/contexts', { signal, schema: meContextsSchema }),

  mySummary: (api: ApiClient, unitId: string | undefined, signal?: AbortSignal) =>
    api.get('/api/portal/my-summary', { signal, query: unitQuery(unitId), schema: mySummarySchema }),

  myStatement: (api: ApiClient, unitId: string | undefined, signal?: AbortSignal) =>
    api.get('/api/portal/my-statement', { signal, query: unitQuery(unitId), schema: myStatementSchema }),

  myAnnouncements: (api: ApiClient, unitId: string | undefined, signal?: AbortSignal) =>
    api.get('/api/portal/announcements', { signal, query: unitQuery(unitId), schema: z.object({ items: z.array(portalAnnouncementSchema) }) }),

  paymentQuote: (api: ApiClient, unitId: string | undefined, signal?: AbortSignal) =>
    api.get('/api/portal/payments/quote', { signal, query: unitQuery(unitId), schema: quoteSchema }),

  myTickets: (api: ApiClient, status: string, signal?: AbortSignal) =>
    api.get('/api/portal/tickets', { signal, query: { status, limit: 100 }, schema: ticketListSchema }),

  myReceipt: (api: ApiClient, paymentId: string, unitId?: string) =>
    api.get(`/api/documents/my-receipts/${enc(paymentId)}`, { query: unitQuery(unitId), schema: signedDownloadSchema }),

  notificationPreferences: (api: ApiClient, signal?: AbortSignal) =>
    api.get('/api/me/notification-preferences', { signal, schema: notificationPreferencesSchema }),

  saveNotificationPreferences: (api: ApiClient, input: NotificationPreferencesInput) =>
    api.put('/api/me/notification-preferences', input, { schema: notificationPreferencesSchema }),
};
