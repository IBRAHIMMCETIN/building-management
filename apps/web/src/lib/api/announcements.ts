import { z } from 'zod';
import {
  type AnnouncementStatusFilter,
  type CreateAnnouncementInput,
  type UpdateAnnouncementInput,
  announcementSchema,
  portalAnnouncementSchema,
} from './announcementModel';
import { apiClient } from './client';

export * from './announcementModel';

const base = '/api/announcements';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const announcementsApi = {
  list: (status: AnnouncementStatusFilter, signal?: AbortSignal) =>
    apiClient.get(base, { signal, query: { status }, schema: z.object({ items: z.array(announcementSchema) }) }),
  create: (input: CreateAnnouncementInput) => apiClient.post(base, input, { schema: announcementSchema }),
  update: (id: string, input: UpdateAnnouncementInput) => apiClient.patch(one(id), input, { schema: announcementSchema }),
  approve: (id: string, version: number) => apiClient.post(`${one(id)}/approve`, { version }, { schema: announcementSchema }),
  archive: (id: string, version: number) => apiClient.post(`${one(id)}/archive`, { version }, { schema: announcementSchema }),
  portalList: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/announcements', {
      signal,
      query: unitId ? { unitId } : undefined,
      schema: z.object({ items: z.array(portalAnnouncementSchema) }),
    }),
};
