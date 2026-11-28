import {
  type ReadingItemInput,
  readingPeriodListSchema,
  readingUploadSchema,
  saveReadingsSchema,
  sheetSchema,
} from '@bm/shared/api/meterReadings';
import { signedDownloadSchema } from '@bm/shared/api/documents';
import { ticketOneSchema } from '@bm/shared/api/portalTickets';
import { type EstimateInput, photoUploadSchema, ticketDetailSchema, ticketEventSchema, ticketListSchema } from '@bm/shared/api/tickets';
import { type CompleteTaskInput, assigneesSchema, taskCompleteSchema, taskListSchema, taskOneSchema } from '@bm/shared/api/work';
import type { TicketPriority, TransitionAction } from '@bm/shared/tickets/model';
import { z } from 'zod';
import type { ApiClient } from './createApiClient';

/*
 * Bina gorevlisi uclari (web: apps/web/src/lib/api/tickets.ts, maintenance.ts, meters.ts). Yetki ve
 * gecisler API'de (`actions`, `canAssign`, `canEstimate`); masraf uclari yonetimindir, mobilde yok.
 */
const T = '/api/tickets';
const B = '/api/maintenance';
const R = '/api/meter-readings';
const enc = encodeURIComponent;

export type TicketListQuery = { status?: string; assignee?: string; limit?: number };
export type TaskListQuery = { status?: string; assignee?: string };

/** Daire / blok adlari (gorevli okuyabilir: `/api/sites/:id/units|blocks`); yalnizca etiket alanlari. */
const unitListSchema = z.object({ items: z.array(z.object({ unitId: z.string(), blockId: z.string(), number: z.string(), status: z.string() }).loose()) });
const blockListSchema = z.object({ items: z.array(z.object({ blockId: z.string(), name: z.string() }).loose()) });

export const workEndpoints = {
  siteUnits: (api: ApiClient, apartmentId: string, signal?: AbortSignal) => api.get(`/api/sites/${enc(apartmentId)}/units`, { signal, schema: unitListSchema }),
  siteBlocks: (api: ApiClient, apartmentId: string, signal?: AbortSignal) => api.get(`/api/sites/${enc(apartmentId)}/blocks`, { signal, schema: blockListSchema }),

  tickets: (api: ApiClient, q: TicketListQuery, signal?: AbortSignal) => api.get(T, { query: q, signal, schema: ticketListSchema }),
  ticket: (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`${T}/${enc(id)}`, { signal, schema: ticketDetailSchema }),
  assignees: (api: ApiClient, signal?: AbortSignal) => api.get(`${T}/assignees`, { signal, schema: assigneesSchema }),
  assignTicket: (api: ApiClient, id: string, input: { version: number; assigneeId: string | null }) => api.post(`${T}/${enc(id)}/assign`, input, { schema: ticketOneSchema }),
  transitionTicket: (api: ApiClient, id: string, input: { version: number; action: TransitionAction; note?: string; photos?: string[] }) =>
    api.post(`${T}/${enc(id)}/status`, input, { schema: ticketOneSchema }),
  commentTicket: (api: ApiClient, id: string, input: { body: string; visibility: 'public' | 'internal'; photos?: string[] }) =>
    api.post(`${T}/${enc(id)}/comments`, input, { schema: z.object({ event: ticketEventSchema }) }),
  estimateTicket: (api: ApiClient, id: string, input: EstimateInput) => api.put(`${T}/${enc(id)}/estimate`, input, { schema: ticketOneSchema }),
  ticketPhotoUpload: (api: ApiClient, input: { contentType: string; size: number }) => api.post(`${T}/photos/upload-url`, input, { schema: photoUploadSchema }),
  ticketPhoto: (api: ApiClient, id: string, photoId: string) => api.get(`${T}/${enc(id)}/photos/${enc(photoId)}`, { schema: signedDownloadSchema }),
  taskPhoto: (api: ApiClient, id: string, photoId: string) => api.get(`${B}/tasks/${enc(id)}/photos/${enc(photoId)}`, { schema: signedDownloadSchema }),

  tasks: (api: ApiClient, q: TaskListQuery, signal?: AbortSignal) => api.get(`${B}/tasks`, { query: q, signal, schema: taskListSchema }),
  task: (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`${B}/tasks/${enc(id)}`, { signal, schema: taskOneSchema }),
  assignTask: (api: ApiClient, id: string, input: { version: number; assigneeId: string | null }) => api.post(`${B}/tasks/${enc(id)}/assign`, input, { schema: taskOneSchema }),
  startTask: (api: ApiClient, id: string, version: number) => api.post(`${B}/tasks/${enc(id)}/start`, { version }, { schema: taskOneSchema }),
  completeTask: (api: ApiClient, id: string, input: CompleteTaskInput) => api.post(`${B}/tasks/${enc(id)}/complete`, input, { schema: taskCompleteSchema }),
  skipTask: (api: ApiClient, id: string, input: { version: number; reason: string }) => api.post(`${B}/tasks/${enc(id)}/skip`, input, { schema: taskOneSchema }),
  estimateTask: (api: ApiClient, id: string, input: EstimateInput) => api.put(`${B}/tasks/${enc(id)}/estimate`, input, { schema: taskOneSchema }),
  taskTicket: (api: ApiClient, id: string, input: { idempotencyKey: string; title?: string; priority?: TicketPriority }) =>
    api.post(`${B}/tasks/${enc(id)}/ticket`, input, { schema: ticketOneSchema.loose() }),
  taskPhotoUpload: (api: ApiClient, input: { contentType: string; size: number }) => api.post(`${B}/photos/upload-url`, input, { schema: photoUploadSchema }),

  readingPeriods: (api: ApiClient, signal?: AbortSignal) => api.get(`${R}/periods`, { signal, schema: readingPeriodListSchema }),
  readingSheet: (api: ApiClient, periodId: string, signal?: AbortSignal) => api.get(`${R}/periods/${enc(periodId)}`, { signal, schema: sheetSchema }),
  saveReadings: (api: ApiClient, periodId: string, items: ReadingItemInput[]) => api.put(`${R}/periods/${enc(periodId)}`, { items }, { schema: saveReadingsSchema }),
  readingPhotoUpload: (api: ApiClient, periodId: string, meterId: string, input: { contentType: string; size: number }) =>
    api.post(`${R}/periods/${enc(periodId)}/meters/${enc(meterId)}/photo-upload`, input, { schema: readingUploadSchema }),
};
