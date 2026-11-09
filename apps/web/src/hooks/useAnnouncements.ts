import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AnnouncementStatusFilter,
  type CreateAnnouncementInput,
  type UpdateAnnouncementInput,
  announcementsApi,
} from '@/lib/api/announcements';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (announcements/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useAnnouncementPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const announcementKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'announcements'] as const,
  list: (apt: string, status: AnnouncementStatusFilter) => [...announcementKeys.all(apt), 'list', status] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useAnnouncementPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useAnnouncements(status: AnnouncementStatusFilter) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: announcementKeys.list(apt, status),
    queryFn: ({ signal }) => announcementsApi.list(status, signal).then((r) => r.items),
    enabled,
  });
}

/** Her yazim durum listelerini etkiler; 409 (surum cakismasi) sonrasi da guncel veri cekilir. */
function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: announcementKeys.all(apt) });
}

export function useCreateAnnouncement() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreateAnnouncementInput) => announcementsApi.create(input), onSettled: invalidate });
}

export function useUpdateAnnouncement() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAnnouncementInput }) => announcementsApi.update(id, input),
    onSettled: invalidate,
  });
}

export function useApproveAnnouncement() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => announcementsApi.approve(id, version),
    onSettled: invalidate,
  });
}

export function useArchiveAnnouncement() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => announcementsApi.archive(id, version),
    onSettled: invalidate,
  });
}
