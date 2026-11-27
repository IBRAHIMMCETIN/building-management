import { z } from 'zod';
import { apiClient } from './client';

/*
 * Ortak alan rezervasyonu.
 *  - Yonetim: /api/reservations (yazma: yonetici + yonetim firmasi; okuma: + denetci)
 *  - Sakin:   /api/portal/reservations (yalnizca `resident`; baska daireler yalnizca dolu dilim)
 * Saatler Europe/Istanbul duvar saati ("SS:DD"); `start` / `end` UTC ISO.
 */

export const BOOKING_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const FEE_STATUSES = ['none', 'pending', 'charged', 'void', 'reversal_pending', 'reversed'] as const;
export type FeeStatus = (typeof FEE_STATUSES)[number];
export const SLOT_LENGTHS = [30, 60, 90, 120, 180, 240] as const;

export const openingWindowSchema = z.object({ day: z.number().int().min(1).max(7), open: z.string(), close: z.string() });
export type OpeningWindow = z.infer<typeof openingWindowSchema>;

const facilityRules = {
  facilityId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  capacity: z.number(),
  openingHours: z.array(openingWindowSchema),
  slotMinutes: z.number(),
  maxBookingMinutes: z.number(),
  advanceDays: z.number(),
  maxActivePerUnit: z.number(),
  requiresApproval: z.boolean(),
  cancelNoticeHours: z.number(),
  blockIds: z.array(z.string()).optional(),
  feeKurus: z.number(),
  status: z.enum(['active', 'inactive']),
  version: z.number(),
};

export const facilitySchema = z.object({ ...facilityRules, incomeAccountId: z.string().optional(), updatedAt: z.string() });
export type Facility = z.infer<typeof facilitySchema>;

export const portalFacilitySchema = z.object({ ...facilityRules, unitIds: z.array(z.string()) });
export type PortalFacility = z.infer<typeof portalFacilitySchema>;

const feeSchema = z.object({
  amount: z.number(),
  status: z.enum(FEE_STATUSES),
  incomeAccountId: z.string().optional(),
  transactionId: z.string().optional(),
  chargedAt: z.string().optional(),
  reversedAt: z.string().optional(),
  error: z.string().optional(),
});

const bookingBase = {
  bookingId: z.string(),
  facilityId: z.string(),
  facilityName: z.string(),
  unitId: z.string(),
  date: z.string(),
  start: z.string(),
  end: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  minutes: z.number(),
  partySize: z.number().optional(),
  note: z.string().optional(),
  status: z.enum(BOOKING_STATUSES),
  decisionNote: z.string().optional(),
  cancelKind: z.enum(['resident', 'manager']).optional(),
  cancelReason: z.string().optional(),
  expired: z.boolean(),
  past: z.boolean(),
  canCancel: z.boolean(),
  createdAt: z.string(),
  version: z.number(),
};

export const bookingSchema = z.object({
  ...bookingBase,
  blockId: z.string().optional(),
  fee: feeSchema,
  autoConfirm: z.boolean().optional(),
  createdBy: z.string(),
  createdByRole: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelledBy: z.string().optional(),
  canApprove: z.boolean(),
  canRetryReversal: z.boolean(),
});
export type Booking = z.infer<typeof bookingSchema>;

export const myBookingSchema = z.object({ ...bookingBase, fee: feeSchema.pick({ amount: true, status: true }), mine: z.boolean(), cancelDeadline: z.string() });
export type MyBooking = z.infer<typeof myBookingSchema>;

export const SLOT_STATES = ['free', 'busy', 'mine', 'past'] as const;
export type SlotState = (typeof SLOT_STATES)[number];
export const availabilitySchema = z.object({
  facilityId: z.string(),
  date: z.string(),
  open: z.boolean(),
  window: z.object({ open: z.string(), close: z.string() }).optional(),
  bookable: z.boolean(),
  lastBookableDate: z.string(),
  slotMinutes: z.number(),
  maxBookingMinutes: z.number(),
  slots: z.array(z.object({ start: z.string(), end: z.string(), startAt: z.string(), state: z.enum(SLOT_STATES) })),
});
export type Availability = z.infer<typeof availabilitySchema>;
export type AvailabilitySlot = Availability['slots'][number];

export const portalFacilitiesSchema = z.object({
  units: z.array(z.object({ unitId: z.string(), blockId: z.string(), number: z.string(), label: z.string() })),
  today: z.string(),
  items: z.array(portalFacilitySchema),
});
export type PortalUnit = z.infer<typeof portalFacilitiesSchema>['units'][number];

export type FacilityInput = {
  name: string;
  description?: string | null;
  capacity: number;
  openingHours: OpeningWindow[];
  slotMinutes: number;
  maxBookingMinutes: number;
  advanceDays: number;
  maxActivePerUnit: number;
  requiresApproval: boolean;
  cancelNoticeHours: number;
  blockIds?: string[] | null;
  feeKurus: number;
  incomeAccountId?: string | null;
};

export type CreateBookingInput = { idempotencyKey: string; facilityId: string; unitId: string; date: string; start: string; minutes: number; partySize?: number; note?: string };

const enc = encodeURIComponent;
const A = '/api/reservations';
const P = '/api/portal/reservations';
const oneFacility = z.object({ facility: facilitySchema });
const oneBooking = z.object({ booking: bookingSchema });

export const reservationsApi = {
  facilities: (signal?: AbortSignal) => apiClient.get(`${A}/facilities`, { signal, schema: z.object({ items: z.array(facilitySchema) }) }),
  createFacility: (input: FacilityInput & { idempotencyKey: string }) => apiClient.post(`${A}/facilities`, input, { schema: oneFacility.extend({ replayed: z.boolean() }) }),
  updateFacility: (id: string, input: Partial<FacilityInput> & { version: number; status?: 'active' | 'inactive' }) => apiClient.patch(`${A}/facilities/${enc(id)}`, input, { schema: oneFacility }),
  bookings: (q: { facilityId?: string; from: string; to: string }, signal?: AbortSignal) =>
    apiClient.get(`${A}/bookings`, { signal, query: q, schema: z.object({ from: z.string(), to: z.string(), items: z.array(bookingSchema) }) }),
  pending: (signal?: AbortSignal) => apiClient.get(`${A}/bookings/pending`, { signal, schema: z.object({ items: z.array(bookingSchema), total: z.number() }) }),
  approve: (id: string, input: { version: number; note?: string }) => apiClient.post(`${A}/bookings/${enc(id)}/approve`, input, { schema: oneBooking }),
  reject: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/bookings/${enc(id)}/reject`, input, { schema: oneBooking }),
  cancel: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/bookings/${enc(id)}/cancel`, input, { schema: oneBooking }),
};

export const portalReservationsApi = {
  facilities: (signal?: AbortSignal) => apiClient.get(`${P}/facilities`, { signal, schema: portalFacilitiesSchema }),
  availability: (facilityId: string, date: string, signal?: AbortSignal) =>
    apiClient.get(`${P}/facilities/${enc(facilityId)}/availability`, { signal, query: { date }, schema: availabilitySchema }),
  bookings: (signal?: AbortSignal) => apiClient.get(`${P}/bookings`, { signal, schema: z.object({ upcoming: z.array(myBookingSchema), history: z.array(myBookingSchema) }) }),
  book: (input: CreateBookingInput) => apiClient.post(`${P}/bookings`, input, { schema: z.object({ booking: myBookingSchema, replayed: z.boolean(), warning: z.string().optional() }) }),
  cancel: (id: string, input: { version: number; reason?: string }) => apiClient.post(`${P}/bookings/${enc(id)}/cancel`, input, { schema: z.object({ booking: myBookingSchema }) }),
};
