import {
  type CreateBookingInput,
  type FacilityInput,
  availabilitySchema,
  bookingSchema,
  facilitySchema,
  myBookingSchema,
  portalFacilitiesSchema,
} from '@bm/shared/api/reservations';
import { z } from 'zod';
import { apiClient } from './client';

/*
 * Ortak alan rezervasyonu.
 *  - Yonetim: /api/reservations (yazma: yonetici + yonetim firmasi; okuma: + denetci)
 *  - Sakin:   /api/portal/reservations (yalnizca `resident`; baska daireler yalnizca dolu dilim)
 * Saatler Europe/Istanbul duvar saati ("SS:DD"); `start` / `end` UTC ISO.
 * Semalar ve tipler web + mobil ortak: packages/shared/src/api/reservations.ts.
 */
export {
  type Availability,
  type AvailabilitySlot,
  type Booking,
  type BookingStatus,
  type CreateBookingInput,
  type Facility,
  type FacilityInput,
  type FeeStatus,
  type MyBooking,
  type OpeningWindow,
  type PortalFacility,
  type PortalUnit,
  type SlotState,
  BOOKING_STATUSES,
  FEE_STATUSES,
  SLOT_LENGTHS,
  SLOT_STATES,
  availabilitySchema,
  bookingSchema,
  facilitySchema,
  myBookingSchema,
  openingWindowSchema,
  portalFacilitiesSchema,
  portalFacilitySchema,
} from '@bm/shared/api/reservations';

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
  pending: (signal?: AbortSignal) =>
    apiClient.get(`${A}/bookings/pending`, { signal, schema: z.object({ items: z.array(bookingSchema), total: z.number(), reversals: z.array(bookingSchema) }) }),
  approve: (id: string, input: { version: number; note?: string }) => apiClient.post(`${A}/bookings/${enc(id)}/approve`, input, { schema: oneBooking }),
  reject: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/bookings/${enc(id)}/reject`, input, { schema: oneBooking }),
  cancel: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/bookings/${enc(id)}/cancel`, input, { schema: oneBooking.extend({ warning: z.string().optional() }) }),
  resolveFee: (id: string, input: { version: number; reason: string }) => apiClient.post(`${A}/bookings/${enc(id)}/fee-resolved`, input, { schema: oneBooking }),
};

export const portalReservationsApi = {
  facilities: (signal?: AbortSignal) => apiClient.get(`${P}/facilities`, { signal, schema: portalFacilitiesSchema }),
  availability: (facilityId: string, date: string, signal?: AbortSignal) =>
    apiClient.get(`${P}/facilities/${enc(facilityId)}/availability`, { signal, query: { date }, schema: availabilitySchema }),
  bookings: (signal?: AbortSignal) => apiClient.get(`${P}/bookings`, { signal, schema: z.object({ upcoming: z.array(myBookingSchema), history: z.array(myBookingSchema) }) }),
  book: (input: CreateBookingInput) => apiClient.post(`${P}/bookings`, input, { schema: z.object({ booking: myBookingSchema, replayed: z.boolean(), warning: z.string().optional() }) }),
  cancel: (id: string, input: { version: number; reason?: string }) =>
    apiClient.post(`${P}/bookings/${enc(id)}/cancel`, input, { schema: z.object({ booking: myBookingSchema, warning: z.string().optional() }) }),
};
