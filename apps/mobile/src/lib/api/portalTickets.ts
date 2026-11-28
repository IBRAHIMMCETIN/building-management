import { signedDownloadSchema } from '@bm/shared/api/documents';
import {
  type PortalCreateTicketInput,
  createdTicketSchema,
  photoUploadSchema,
  similarTicketsSchema,
  ticketCommentResultSchema,
  ticketDetailSchema,
  ticketOneSchema,
} from '@bm/shared/api/portalTickets';
import { ticketListSchema } from '@bm/shared/api/tickets';
import type { ApiClient } from './createApiClient';

/*
 * Sakin ariza / talep uclari (web: apps/web/src/lib/api/portalTickets.ts; ayni istekler):
 * /api/portal/tickets. Fotograf: once `photos/upload-url` (tur + boyut), sonra imzali linke PUT
 * (lib/photos.ts), olaya `uploadId` verilir.
 */

const enc = encodeURIComponent;
const P = '/api/portal/tickets';

export const portalTicketsApi = {
  list: (api: ApiClient, status: string, signal?: AbortSignal) => api.get(P, { signal, query: { status, limit: 100 }, schema: ticketListSchema }),
  similar: (api: ApiClient, category: string, signal?: AbortSignal) => api.get(`${P}/similar`, { signal, query: { category }, schema: similarTicketsSchema }),
  create: (api: ApiClient, input: PortalCreateTicketInput) => api.post(P, input, { schema: createdTicketSchema }),
  uploadUrl: (api: ApiClient, file: { contentType: string; size: number }) => api.post(`${P}/photos/upload-url`, file, { schema: photoUploadSchema }),
  get: (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`${P}/${enc(id)}`, { signal, schema: ticketDetailSchema }),
  comment: (api: ApiClient, id: string, input: { body: string; photos?: string[] }) => api.post(`${P}/${enc(id)}/comments`, input, { schema: ticketCommentResultSchema }),
  confirm: (api: ApiClient, id: string, input: { version: number; rating?: number; note?: string }) => api.post(`${P}/${enc(id)}/confirm`, input, { schema: ticketOneSchema }),
  reopen: (api: ApiClient, id: string, input: { version: number; note: string }) => api.post(`${P}/${enc(id)}/reopen`, input, { schema: ticketOneSchema }),
  cancel: (api: ApiClient, id: string, input: { version: number }) => api.post(`${P}/${enc(id)}/cancel`, input, { schema: ticketOneSchema }),
  photo: (api: ApiClient, id: string, photoId: string) => api.get(`${P}/${enc(id)}/photos/${enc(photoId)}`, { schema: signedDownloadSchema }),
};
