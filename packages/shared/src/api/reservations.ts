import { z } from 'zod';

/*
 * Ortak alan rezervasyonu (apps/api/src/modules/reservations), web + mobil ortak semalar:
 *  - Yonetim: /api/reservations (yazma: yonetici + yonetim firmasi; okuma: + denetci)
 *  - Sakin:   /api/portal/reservations (yalnizca `resident`; baska daireler yalnizca dolu dilim)
 * Saatler Europe/Istanbul duvar saati ("SS:DD"); `start` / `end` UTC ISO. Uclar: web
 * apps/web/src/lib/api/reservations.ts, mobil apps/mobile/src/lib/api/portalReservations.ts.
 */

export const BOOKING_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const FEE_STATUSES = ['none', 'pending', 'charged', 'void', 'reversal_pending', 'reversed', 'resolved_manually'] as const;
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
  resolvedNote: z.string().optional(),
  resolvedAt: z.string().optional(),
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
  payer: z.object({ liableParty: z.enum(['occupant', 'owner']), relation: z.enum(['owner', 'tenant']) }).optional(),
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

/** Sakin: rezervasyonlarim (yaklasan + gecmis / iptal). */
export const myBookingsSchema = z.object({ upcoming: z.array(myBookingSchema), history: z.array(myBookingSchema) });
export const createdMyBookingSchema = z.object({ booking: myBookingSchema, replayed: z.boolean(), warning: z.string().optional() });
export const cancelledMyBookingSchema = z.object({ booking: myBookingSchema, warning: z.string().optional() });

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
