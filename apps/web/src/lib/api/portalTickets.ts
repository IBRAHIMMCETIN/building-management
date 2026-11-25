import { z } from 'zod';
import type { TicketCategory } from '@/lib/tickets/model';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import { photoUploadSchema, putPhoto, similarSchema, ticketDetailSchema, ticketEventSchema, ticketListSchema, ticketSchema } from './tickets';

/*
 * Faz 3 (O1-2/O1-6) sakin portali - /api/portal/tickets (yalnizca `resident`):
 * actigim + dairemin talepleri; yalnizca herkese acik olaylar; onay (1-5 puan), yeniden acma
 * (cozumden sonra `autoCloseDays` icinde), geri cekme (atanmadan once).
 */

export type PortalCreateTicketInput = {
  idempotencyKey: string;
  title: string;
  description: string;
  category: TicketCategory;
  location: { kind: 'unit'; unitId: string } | { kind: 'common'; area: string };
  photos?: string[];
};

const enc = encodeURIComponent;
const P = '/api/portal/tickets';
const one = z.object({ ticket: ticketSchema });

export const portalTicketsApi = {
  list: (status: string | undefined, signal?: AbortSignal) => apiClient.get(P, { query: status ? { status, limit: 100 } : { limit: 100 }, signal, schema: ticketListSchema }),
  similar: (category: string, signal?: AbortSignal) => apiClient.get(`${P}/similar`, { query: { category }, signal, schema: similarSchema }),
  create: (input: PortalCreateTicketInput) => apiClient.post(P, input, { schema: z.object({ ticket: ticketSchema, replayed: z.boolean() }) }),
  async uploadPhoto(file: File): Promise<string> {
    const upload = await apiClient.post(`${P}/photos/upload-url`, { contentType: file.type, size: file.size }, { schema: photoUploadSchema });
    return putPhoto(upload, file);
  },
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${P}/${enc(id)}`, { signal, schema: ticketDetailSchema }),
  comment: (id: string, input: { body: string; photos?: string[] }) => apiClient.post(`${P}/${enc(id)}/comments`, input, { schema: z.object({ event: ticketEventSchema }) }),
  confirm: (id: string, input: { version: number; rating?: number; note?: string }) => apiClient.post(`${P}/${enc(id)}/confirm`, input, { schema: one }),
  reopen: (id: string, input: { version: number; note: string }) => apiClient.post(`${P}/${enc(id)}/reopen`, input, { schema: one }),
  cancel: (id: string, input: { version: number }) => apiClient.post(`${P}/${enc(id)}/cancel`, input, { schema: one }),
  photo: (id: string, photoId: string) => apiClient.get(`${P}/${enc(id)}/photos/${enc(photoId)}`, { schema: signedDownloadSchema }),
};

/** Sakin listesi: acik (cozum bekleyen + onay bekleyen) ve kapanan. */
export const PORTAL_OPEN_STATUSES = 'open,assigned,in_progress,on_hold,resolved';
export const PORTAL_CLOSED_STATUSES = 'closed,cancelled';

/** Onayini bekleyen talep: cozuldu ve sakin onaylayabilir. */
export const awaitsMyConfirmation = (t: { status: string; actions: readonly string[] }) => t.status === 'resolved' && t.actions.includes('confirm');
