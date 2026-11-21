import { z } from 'zod';
import { apiClient } from './client';

/** GET /api/apartment-roles?current=true - apartmanin gorev/yonetici rolleri. */
export const apartmentRoleSchema = z
  .object({
    userId: z.string(),
    role: z.string(),
    displayName: z.string().optional(),
    status: z.string(),
  })
  .passthrough();
export type ApartmentRoleView = z.infer<typeof apartmentRoleSchema>;

export const apartmentRolesApi = {
  listCurrent: (signal?: AbortSignal) =>
    apiClient.get('/api/apartment-roles', {
      signal,
      query: { current: 'true' },
      schema: z.object({ items: z.array(apartmentRoleSchema) }),
    }),
};
