import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeature } from '@/context/SiteFeaturesContext';
import { type RoleEndInput, type RoleInviteInput, apartmentRolesApi } from '@/lib/api/apartmentRoles';
import { notificationPreferencesApi, type NotificationPreferencesInput } from '@/lib/api/notificationPreferences';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';

/** API ile ayni (apps/api/src/modules/apartment-roles/routes.ts). */
export const TEAM_READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
export const TEAM_WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useTeamPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return {
    apartmentId: user?.apartmentId ?? '',
    userId: user?.sub,
    role,
    canRead: !!role && TEAM_READ.includes(role),
    canWrite: !!role && TEAM_WRITE.includes(role),
  };
}

/** Ekip ve "apartment-roles current" (Guvenlik / Denetim ekranlari) ayni onekte: yazim ikisini de tazeler. */
export const teamKeys = {
  all: (apt: string | undefined) => ['apartment-roles', apt] as const,
  list: (apt: string) => ['apartment-roles', apt, 'all'] as const,
};

export function useTeam() {
  const { apartmentId, canRead } = useTeamPermissions();
  return useQuery({
    queryKey: teamKeys.list(apartmentId),
    queryFn: ({ signal }) => apartmentRolesApi.listAll(signal).then((r) => r.items),
    enabled: !!apartmentId && canRead,
  });
}

function useInvalidateTeam() {
  const qc = useQueryClient();
  const { apartmentId } = useTeamPermissions();
  return () => Promise.all([qc.invalidateQueries({ queryKey: teamKeys.all(apartmentId) }), qc.invalidateQueries({ queryKey: ['apartment-roles', 'current'] })]);
}

export function useInviteMember() {
  const invalidate = useInvalidateTeam();
  return useMutation({ mutationFn: (input: RoleInviteInput) => apartmentRolesApi.invite(input), onSuccess: invalidate });
}

export function useEndRole() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: ({ userId, role, input }: { userId: string; role: string; input: RoleEndInput }) => apartmentRolesApi.end(userId, role, input),
    onSettled: invalidate,
  });
}

export function useResendInvite() {
  return useMutation({ mutationFn: ({ userId, role }: { userId: string; role: string }) => apartmentRolesApi.resendInvite(userId, role) });
}

// --- Hesabim ---------------------------------------------------------------

export const accountKeys = {
  notifications: (userId: string | undefined) => ['me', 'notification-preferences', userId] as const,
  devices: (userId: string | undefined) => ['me', 'devices', userId] as const,
};

export function useNotificationPreferences() {
  const { user } = useAuth();
  // Adim 1: sakin baglaminda tercih ekrani site ozelligine baglidir (yonetim rolleri etkilenmez).
  const residentPrefs = useFeature('resident.notificationPrefs');
  return useQuery({
    queryKey: accountKeys.notifications(user?.sub),
    queryFn: ({ signal }) => notificationPreferencesApi.get(signal),
    enabled: !!user && (user.role !== 'resident' || residentPrefs),
  });
}

/**
 * Kullanicinin aktif mobil cihazlari (`GET /api/me/devices`): Hesabım'daki "Mobil bildirim" bolumu yalnizca
 * en az bir telefon varsa gosterilir. Tercih karti ile ayni kosulda okunur.
 */
export function useMyDevices() {
  const { user } = useAuth();
  const residentPrefs = useFeature('resident.notificationPrefs');
  return useQuery({
    queryKey: accountKeys.devices(user?.sub),
    queryFn: ({ signal }) => notificationPreferencesApi.devices(signal),
    enabled: !!user && (user.role !== 'resident' || residentPrefs),
  });
}

export function useSaveNotificationPreferences() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (prefs: NotificationPreferencesInput) => notificationPreferencesApi.put(prefs),
    onSuccess: (data) => qc.setQueryData(accountKeys.notifications(user?.sub), data),
  });
}
