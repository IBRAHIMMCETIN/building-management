import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreateClosureInput, closuresApi } from '@/lib/api/closures';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';
import { unitKeys } from './useUnits';

export const closureKeys = {
  preview: (apt: string, unitId: string, party: string, moveOutDate: string) =>
    [...financeKeys.all(apt), 'closure-preview', unitId, party, moveOutDate] as const,
  unit: (apt: string, unitId: string) => [...financeKeys.all(apt), 'closures', unitId] as const,
  former: (apt: string, all: boolean) => [...financeKeys.all(apt), 'former-accounts', all ? 'all' : 'open'] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead, canWrite } = useFinancePermissions();
  return { apt: user?.apartmentId ?? '', canRead: !!user?.apartmentId && canRead, canWrite: !!user?.apartmentId && canWrite };
}

/**
 * Kapama onizlemesi (yazmaz). Taraf ve tarih secilmeden istek atilmaz. Onizleme defterin o anki
 * haliyle hesaplanir; her adim degisikliginde taze alinsin diye onbellekte tutulmaz.
 */
export function useClosurePreview(unitId: string | undefined, q: { party: 'owner' | 'occupant'; moveOutDate: string } | null) {
  const { apt, canWrite } = useApt();
  return useQuery({
    queryKey: closureKeys.preview(apt, unitId ?? '', q?.party ?? '', q?.moveOutDate ?? ''),
    queryFn: ({ signal }) => closuresApi.preview(unitId as string, q as NonNullable<typeof q>, signal),
    enabled: canWrite && !!unitId && q !== null,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useUnitClosures(unitId: string | undefined) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: closureKeys.unit(apt, unitId ?? ''),
    queryFn: ({ signal }) => closuresApi.listForUnit(unitId as string, signal).then((r) => r.items),
    enabled: canRead && !!unitId,
  });
}

export function useFormerAccounts(all = false, enabled = true) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: closureKeys.former(apt, all),
    queryFn: ({ signal }) => closuresApi.formerAccounts(all, signal),
    enabled: canRead && enabled,
  });
}

/**
 * Kapama/geri alma defteri, aidat durumunu VE uyelikleri (bitis tarihi / oturma) degistirir:
 * finans anahtarinin tamami ile daire uyelikleri gecersiz kilinir.
 */
function useInvalidateAfterClosure() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) }),
      queryClient.invalidateQueries({ queryKey: unitKeys.memberships(apt) }),
    ]);
}

export function useCreateClosure() {
  const invalidate = useInvalidateAfterClosure();
  return useMutation({
    mutationFn: ({ unitId, input }: { unitId: string; input: CreateClosureInput }) => closuresApi.create(unitId, input),
    onSuccess: invalidate,
  });
}

export function useReverseClosure() {
  const invalidate = useInvalidateAfterClosure();
  return useMutation({
    mutationFn: ({ closureId, reason }: { closureId: string; reason: string }) => closuresApi.reverse(closureId, reason),
    onSuccess: invalidate,
  });
}
