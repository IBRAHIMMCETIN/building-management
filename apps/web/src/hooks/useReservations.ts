import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreateBookingInput, type FacilityInput, portalReservationsApi, reservationsApi } from '@/lib/api/reservations';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { portalKeys } from './usePortal';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (reservations/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useReservationPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const reservationKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'reservations'] as const,
  facilities: (apt: string) => [...reservationKeys.all(apt), 'facilities'] as const,
  bookings: (apt: string, facilityId: string, from: string, to: string) => [...reservationKeys.all(apt), 'bookings', facilityId, from, to] as const,
  pending: (apt: string) => [...reservationKeys.all(apt), 'pending'] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useReservationPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useFacilities() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: reservationKeys.facilities(apt), queryFn: ({ signal }) => reservationsApi.facilities(signal).then((r) => r.items), enabled });
}

export function useFacilityBookings(facilityId: string, from: string, to: string) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: reservationKeys.bookings(apt, facilityId, from, to),
    queryFn: ({ signal }) => reservationsApi.bookings({ ...(facilityId ? { facilityId } : {}), from, to }, signal).then((r) => r.items),
    enabled: enabled && !!from && !!to,
  });
}

export function usePendingBookings() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: reservationKeys.pending(apt), queryFn: ({ signal }) => reservationsApi.pending(signal), enabled });
}

/** Her yazim takvimi, kuyrugu ve alanlari etkiler; 409 sonrasi da guncel veri cekilir. */
function useInvalidate() {
  const { apt } = useApt();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: reservationKeys.all(apt) });
}

export function useSaveFacility() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id?: string; version?: number; idempotencyKey: string; input: FacilityInput }) =>
      v.id && v.version !== undefined ? reservationsApi.updateFacility(v.id, { ...v.input, version: v.version }) : reservationsApi.createFacility({ ...v.input, idempotencyKey: v.idempotencyKey }),
    onSettled: invalidate,
  });
}

export function useFacilityStatus() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; version: number; status: 'active' | 'inactive' }) => reservationsApi.updateFacility(v.id, { version: v.version, status: v.status }),
    onSettled: invalidate,
  });
}

export function useBookingActions() {
  const invalidate = useInvalidate();
  const opts = { onSettled: invalidate };
  return {
    approve: useMutation({ mutationFn: (v: { id: string; version: number; note?: string }) => reservationsApi.approve(v.id, { version: v.version, ...(v.note ? { note: v.note } : {}) }), ...opts }),
    reject: useMutation({ mutationFn: (v: { id: string; version: number; reason: string }) => reservationsApi.reject(v.id, { version: v.version, reason: v.reason }), ...opts }),
    cancel: useMutation({ mutationFn: (v: { id: string; version: number; reason: string }) => reservationsApi.cancel(v.id, { version: v.version, reason: v.reason }), ...opts }),
    resolveFee: useMutation({ mutationFn: (v: { id: string; version: number; reason: string }) => reservationsApi.resolveFee(v.id, { version: v.version, reason: v.reason }), ...opts }),
  };
}

// ---------------------------------------------------------------------------
// Sakin portali
// ---------------------------------------------------------------------------

function usePortalScope() {
  const { user } = useAuth();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!user.apartmentId };
}

export const portalReservationKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'reservations'] as const,
  facilities: (apt: string, user: string) => [...portalReservationKeys.all(apt, user), 'facilities'] as const,
  availability: (apt: string, user: string, facilityId: string, date: string) => [...portalReservationKeys.all(apt, user), 'availability', facilityId, date] as const,
  bookings: (apt: string, user: string) => [...portalReservationKeys.all(apt, user), 'bookings'] as const,
};

export function usePortalFacilities() {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({ queryKey: portalReservationKeys.facilities(apt, userId), queryFn: ({ signal }) => portalReservationsApi.facilities(signal), enabled });
}

export function useAvailability(facilityId: string | undefined, date: string | undefined) {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({
    queryKey: portalReservationKeys.availability(apt, userId, facilityId ?? '', date ?? ''),
    queryFn: ({ signal }) => portalReservationsApi.availability(facilityId ?? '', date ?? '', signal),
    enabled: enabled && !!facilityId && !!date,
  });
}

export function useMyBookings() {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({ queryKey: portalReservationKeys.bookings(apt, userId), queryFn: ({ signal }) => portalReservationsApi.bookings(signal), enabled });
}

function usePortalInvalidate() {
  const qc = useQueryClient();
  const { apt, userId } = usePortalScope();
  return () => qc.invalidateQueries({ queryKey: portalReservationKeys.all(apt, userId) });
}

export function useCreateBooking() {
  const invalidate = usePortalInvalidate();
  return useMutation({ mutationFn: (input: CreateBookingInput) => portalReservationsApi.book(input), onSettled: invalidate });
}

export function useCancelMyBooking() {
  const invalidate = usePortalInvalidate();
  return useMutation({ mutationFn: (v: { id: string; version: number }) => portalReservationsApi.cancel(v.id, { version: v.version }), onSettled: invalidate });
}
