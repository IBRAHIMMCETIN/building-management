import { z } from 'zod';
import { apiClient } from './client';

/*
 * /api/apartment-roles - apartmanin ekip / yonetici rolleri (apps/api/src/modules/apartment-roles).
 *   GET    /?status=active|inactive|all&current=true     (yonetici, yonetim firmasi, denetci; denetciye e-posta maskeli)
 *   POST   /invite { email, fullName, role, startDate?, endDate? }   -> { role, invitation, reactivated }
 *   POST   /:userId/:role/end { version, reason, endDate? }          (son yonetici korumasi: 409)
 *   POST   /:userId/:role/resend-invite                              -> { result: 'sent' | 'not_pending' }
 */
export const STAFF_ROLES = ['apartment_manager', 'management_company', 'observer', 'building_staff', 'security_guard'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const apartmentRoleSchema = z
  .object({
    userId: z.string(),
    role: z.string(),
    displayName: z.string().optional(),
    fullName: z.string().optional(),
    email: z.string().optional(),
    status: z.string(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    endReason: z.string().optional(),
    isCurrent: z.boolean().optional(),
    version: z.number().int().optional(),
  })
  .passthrough();
export type ApartmentRoleView = z.infer<typeof apartmentRoleSchema>;

export const inviteResultSchema = z.object({
  role: apartmentRoleSchema,
  invitation: z.enum(['sent', 'existing_user']),
  reactivated: z.boolean().default(false),
  mock: z.object({ temporaryPassword: z.string().optional() }).optional(),
});
export type RoleInviteResult = z.infer<typeof inviteResultSchema>;

export type RoleInviteInput = { email: string; fullName: string; role: StaffRole; startDate?: string; endDate?: string };
export type RoleEndInput = { version: number; reason: string; endDate?: string };

const list = z.object({ items: z.array(apartmentRoleSchema) });
const enc = encodeURIComponent;
const path = (userId: string, role: string) => `/api/apartment-roles/${enc(userId)}/${enc(role)}`;

export const apartmentRolesApi = {
  listCurrent: (signal?: AbortSignal) => apiClient.get('/api/apartment-roles', { signal, query: { current: 'true' }, schema: list }),
  /** Ekip ekrani: aktif + sona ermis tum kayitlar. */
  listAll: (signal?: AbortSignal) => apiClient.get('/api/apartment-roles', { signal, query: { status: 'all' }, schema: list }),
  invite: (input: RoleInviteInput) => apiClient.post('/api/apartment-roles/invite', input, { schema: inviteResultSchema }),
  end: (userId: string, role: string, input: RoleEndInput) => apiClient.post(`${path(userId, role)}/end`, input, { schema: apartmentRoleSchema }),
  resendInvite: (userId: string, role: string) =>
    apiClient.post(`${path(userId, role)}/resend-invite`, {}, { schema: z.object({ result: z.enum(['sent', 'not_pending']) }) }),
};
