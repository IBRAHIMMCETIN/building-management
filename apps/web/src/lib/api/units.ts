import { z } from 'zod';
import { UNIT_TYPES, type UnitType } from '@/types/units';
import { apiClient } from './client';

/*
 * Daire / blok / uyelik / kisi uclari. Apartman URL'de gecse de API onu JWT'deki
 * `apartmentId` ile karsilastirir (siteGuard); yetki her zaman claim'den gelir.
 *   GET/POST /api/sites/:siteId/units      GET/POST /api/sites/:siteId/blocks
 *   GET      /api/memberships?current=true GET /api/residents   POST /api/residents/invite
 */

export { UNIT_TYPES, UNIT_TYPE_LABELS, type UnitType } from '@/types/units';

const share = z.object({ numerator: z.number().int(), denominator: z.number().int() });

export const blockSchema = z.object({
  blockId: z.string(),
  name: z.string(),
  floorCount: z.number().optional(),
  status: z.enum(['active', 'inactive']),
});

export const unitSchema = z.object({
  unitId: z.string(),
  blockId: z.string(),
  number: z.string(),
  floor: z.number().int().optional(),
  type: z.enum(UNIT_TYPES),
  grossAreaM2: z.number(),
  landShare: share.optional(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
});

export const unitListSchema = z.object({
  items: z.array(unitSchema),
  summary: z.object({
    activeUnitCount: z.number(),
    totalGrossAreaTenthsM2: z.number(),
    landShare: z.object({ numerator: z.string(), denominator: z.string(), isComplete: z.boolean() }),
  }),
});

export const membershipSchema = z.object({
  userId: z.string(),
  unitId: z.string(),
  relation: z.enum(['owner', 'tenant']),
  residesInUnit: z.boolean(),
  ownershipShare: share.optional(),
  startDate: z.string(),
  endDate: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  isCurrent: z.boolean(),
});

export const personSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
  email: z.string(),
});

export const inviteResultSchema = z.object({
  person: personSchema,
  membership: membershipSchema,
  invitation: z.enum(['sent', 'existing_user']),
});

export type Block = z.infer<typeof blockSchema>;
export type Unit = z.infer<typeof unitSchema>;
export type UnitList = z.infer<typeof unitListSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Person = z.infer<typeof personSchema>;
export type InviteResult = z.infer<typeof inviteResultSchema>;

export type CreateUnitInput = {
  blockId: string;
  number: string;
  type: UnitType;
  grossAreaM2: number;
  floor?: number;
  landShare?: { numerator: number; denominator: number };
};

export type InviteResidentInput = {
  unitId: string;
  fullName: string;
  email: string;
  relation: 'owner' | 'tenant';
  startDate: string;
  residesInUnit?: boolean;
  ownershipShare?: { numerator: number; denominator: number };
};

const site = (apartmentId: string) => `/api/sites/${encodeURIComponent(apartmentId)}`;

export const unitsApi = {
  listUnits: (apartmentId: string, signal?: AbortSignal) =>
    apiClient.get(`${site(apartmentId)}/units`, { signal, schema: unitListSchema }),
  listBlocks: (apartmentId: string, signal?: AbortSignal) =>
    apiClient.get(`${site(apartmentId)}/blocks`, { signal, schema: z.object({ items: z.array(blockSchema) }) }),
  createUnit: (apartmentId: string, input: CreateUnitInput) =>
    apiClient.post(`${site(apartmentId)}/units`, input, { schema: unitSchema }),
  createBlock: (apartmentId: string, name: string) =>
    apiClient.post(`${site(apartmentId)}/blocks`, { name }, { schema: blockSchema }),
  listCurrentMemberships: (signal?: AbortSignal) =>
    apiClient.get('/api/memberships', {
      signal,
      query: { current: 'true' },
      schema: z.object({ items: z.array(membershipSchema) }),
    }),
  listPeople: (signal?: AbortSignal) =>
    apiClient.get('/api/residents', { signal, schema: z.object({ items: z.array(personSchema) }) }),
  inviteResident: (input: InviteResidentInput) =>
    apiClient.post('/api/residents/invite', input, { schema: inviteResultSchema }),
};
