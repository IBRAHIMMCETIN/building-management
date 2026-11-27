import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AssemblyInput, type AttendanceInput, assembliesApi } from '@/lib/api/assemblies';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (assemblies/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useAssemblyPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const assemblyKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'assemblies'] as const,
  list: (apt: string) => [...assemblyKeys.all(apt), 'list'] as const,
  detail: (apt: string, id: string) => [...assemblyKeys.all(apt), 'detail', id] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useAssemblyPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useAssemblies() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.list(apt), queryFn: ({ signal }) => assembliesApi.list(signal).then((r) => r.items), enabled });
}

export function useAssembly(id: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.detail(apt, id ?? ''), queryFn: ({ signal }) => assembliesApi.detail(id ?? '', signal), enabled: enabled && !!id });
}

function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: assemblyKeys.all(apt) });
}

export function useSaveAssembly() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, version, input }: { id?: string; version?: number; input: AssemblyInput }) =>
      id && version ? assembliesApi.update(id, { ...input, version }) : assembliesApi.create(input),
    onSettled: invalidate,
  });
}

export function useSetAttendance(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ unitId, ...input }: { unitId: string } & AttendanceInput) => assembliesApi.attendance(id, unitId, input),
    onSettled: invalidate,
  });
}

/** Toplanti yeter sayisini tutanaga gecirir (saglanamadiysa ikinci toplantinin dayanagi). */
export function useRecordQuorum(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (version: number) => assembliesApi.recordQuorum(id, version), onSettled: invalidate });
}

export function useRecordTally(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ itemId, ...input }: { itemId: string; version: number; yes: number; no: number; abstain: number }) => assembliesApi.tally(id, itemId, input),
    onSettled: invalidate,
  });
}

export function useCancelAssembly() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, version, reason }: { id: string; version: number; reason: string }) => assembliesApi.cancel(id, version, reason), onSettled: invalidate });
}
