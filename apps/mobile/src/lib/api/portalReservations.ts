import {
  type CreateBookingInput,
  availabilitySchema,
  cancelledMyBookingSchema,
  createdMyBookingSchema,
  myBookingsSchema,
  portalFacilitiesSchema,
} from '@bm/shared/api/reservations';
import type { ApiClient } from './createApiClient';

/* Sakin rezervasyon uclari (web: apps/web/src/lib/api/reservations.ts -> portalReservationsApi; ayni istekler). */

const enc = encodeURIComponent;
const P = '/api/portal/reservations';

export const portalReservationsApi = {
  facilities: (api: ApiClient, signal?: AbortSignal) => api.get(`${P}/facilities`, { signal, schema: portalFacilitiesSchema }),
  availability: (api: ApiClient, facilityId: string, date: string, signal?: AbortSignal) =>
    api.get(`${P}/facilities/${enc(facilityId)}/availability`, { signal, query: { date }, schema: availabilitySchema }),
  bookings: (api: ApiClient, signal?: AbortSignal) => api.get(`${P}/bookings`, { signal, schema: myBookingsSchema }),
  book: (api: ApiClient, input: CreateBookingInput) => api.post(`${P}/bookings`, input, { schema: createdMyBookingSchema }),
  cancel: (api: ApiClient, id: string, input: { version: number; reason?: string }) => api.post(`${P}/bookings/${enc(id)}/cancel`, input, { schema: cancelledMyBookingSchema }),
};
