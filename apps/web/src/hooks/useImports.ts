import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { importsApi } from '@/lib/api/imports';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (imports/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useImportPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { apartmentId: user?.apartmentId ?? '', canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const importKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'imports'] as const,
  detail: (apt: string, id: string) => [...importKeys.all(apt), 'detail', id] as const,
};

export function useImports() {
  const { apartmentId, canRead } = useImportPermissions();
  return useQuery({
    queryKey: importKeys.all(apartmentId),
    queryFn: ({ signal }) => importsApi.list(signal).then((r) => r.items),
    enabled: !!apartmentId && canRead,
  });
}

export function useImportDetail(importId: string | null) {
  const { apartmentId, canRead } = useImportPermissions();
  return useQuery({
    queryKey: importKeys.detail(apartmentId, importId ?? ''),
    queryFn: ({ signal }) => importsApi.get(importId as string, signal),
    enabled: !!apartmentId && canRead && !!importId,
  });
}

/** Onizleme hicbir sey yazmaz; onbellek yok. */
export function useImportPreview() {
  return useMutation({ mutationFn: importsApi.preview });
}

/**
 * Aktarim, geri alma ve davetler apartmanin tum verisini (daireler, finans, uyelikler)
 * etkiler: is bitince apartman sorgularinin tamami yenilenir.
 */
export function useInvalidateApartment() {
  const { apartmentId } = useImportPermissions();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: unitKeys.apartment(apartmentId) });
}

/** Sunucu parca parca isler (`remaining`); 0 olana kadar tekrar cagrilir. */
async function untilDone<T extends { remaining: number }>(step: () => Promise<T>, onStep?: (r: T) => void, max = 200): Promise<T> {
  let last = await step();
  onStep?.(last);
  for (let i = 0; last.remaining > 0 && i < max; i++) {
    last = await step();
    onStep?.(last);
  }
  return last;
}

export function useSendImportInvitations() {
  const invalidate = useInvalidateApartment();
  return useMutation({
    mutationFn: async (importId: string) => {
      let sent = 0;
      await untilDone(() => importsApi.sendInvitations(importId), (r) => (sent += r.sent));
      return { sent };
    },
    onSettled: invalidate,
  });
}

export function useRollbackImport() {
  const invalidate = useInvalidateApartment();
  return useMutation({
    mutationFn: ({ importId, reason }: { importId: string; reason?: string }) => untilDone(() => importsApi.rollback(importId, reason)),
    onSettled: invalidate,
  });
}

export function useCompleteImport() {
  const invalidate = useInvalidateApartment();
  return useMutation({ mutationFn: importsApi.complete, onSettled: invalidate });
}
