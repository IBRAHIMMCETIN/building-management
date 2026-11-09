import { z } from 'zod';
import { ROLES } from '@/types/roles';

const contextRole = z.enum(ROLES).exclude(['platform_admin']);

/** `GET /api/me/contexts` yaniti (apps/api/src/modules/me/service.ts -> MeContexts). */
export const meContextsSchema = z.object({
  userId: z.string(),
  email: z.string().optional(),
  isPlatformAdmin: z.boolean(),
  active: z
    .object({ role: z.enum(ROLES), apartmentId: z.string().optional(), organizationId: z.string().optional() })
    .nullable(),
  contexts: z.array(
    z.object({
      apartmentId: z.string(),
      apartmentName: z.string(),
      role: contextRole,
      organizationId: z.string().optional(),
      units: z
        .array(z.object({ unitId: z.string(), unitNumber: z.string().optional(), relation: z.enum(['owner', 'tenant']) }))
        .optional(),
    }),
  ),
});

export type MeContexts = z.infer<typeof meContextsSchema>;
export type SelectableContext = MeContexts['contexts'][number];
