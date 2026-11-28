import type { CreateBookingInput } from '@bm/shared/api/reservations';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthProvider';
import { portalReservationsApi } from '@/lib/api/portalReservations';
import { useServices } from '@/services';
import { portalKeys } from './usePortal';

/* Sakin rezervasyonlari (web: hooks/useReservations.ts sakin bolumu; ayni anahtar yapisi). */

export const reservationKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'reservations'] as const,
  facilities: (apt: string, user: string) => [...reservationKeys.all(apt, user), 'facilities'] as const,
  availability: (apt: string, user: string, facilityId: string, date: string) => [...reservationKeys.all(apt, user), 'availability', facilityId, date] as const,
  bookings: (apt: string, user: string) => [...reservationKeys.all(apt, user), 'bookings'] as const,
};

function useScope() {
  const { user } = useAuth();
  const { api } = useServices();
  const apt = user?.apartmentId ?? '';
  return { api, apt, userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!apt };
}

export function usePortalFacilities() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: reservationKeys.facilities(apt, userId), queryFn: ({ signal }) => portalReservationsApi.facilities(api, signal), enabled });
}

export function useAvailability(facilityId: string | undefined, date: string | undefined) {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: reservationKeys.availability(apt, userId, facilityId ?? '', date ?? ''),
    queryFn: ({ signal }) => portalReservationsApi.availability(api, facilityId ?? '', date ?? '', signal),
    enabled: enabled && !!facilityId && !!date,
  });
}

export function useMyBookings() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: reservationKeys.bookings(apt, userId), queryFn: ({ signal }) => portalReservationsApi.bookings(api, signal), enabled });
}

function useInvalidate() {
  const qc = useQueryClient();
  const { apt, userId } = useScope();
  return () => qc.invalidateQueries({ queryKey: reservationKeys.all(apt, userId) });
}

export function useCreateBooking() {
  const { api } = useScope();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreateBookingInput) => portalReservationsApi.book(api, input), onSettled: invalidate });
}

export function useCancelMyBooking() {
  const { api } = useScope();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { id: string; version: number }) => portalReservationsApi.cancel(api, v.id, { version: v.version }), onSettled: invalidate });
}
