import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreateTransferInput, type OwnerBilling, type RegisterInput, type TransferInput, ownershipApi } from '@/lib/api/ownership';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';
import { unitKeys } from './useUnits';

/** Mulkiyet verisi finans anahtarinin altinda: devir/mod degisimi defteri de etkiler. */
export const ownershipKeys = {
  all: (apt: string) => [...financeKeys.all(apt), 'ownership'] as const,
  unit: (apt: string, unitId: string) => [...ownershipKeys.all(apt), 'unit', unitId] as const,
  transfers: (apt: string, unitId: string) => [...ownershipKeys.all(apt), 'transfers', unitId] as const,
  issues: (apt: string) => [...ownershipKeys.all(apt), 'issues'] as const,
  preview: (apt: string, unitId: string, input: TransferInput | null) => [...ownershipKeys.all(apt), 'preview', unitId, input] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead, canWrite } = useFinancePermissions();
  return { apt: user?.apartmentId ?? '', canRead: !!user?.apartmentId && canRead, canWrite: !!user?.apartmentId && canWrite };
}

export function useOwnershipPermissions() {
  const { canRead, canWrite } = useApt();
  return { canRead, canWrite };
}

export function useUnitOwnership(unitId: string | undefined) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: ownershipKeys.unit(apt, unitId ?? ''),
    queryFn: ({ signal }) => ownershipApi.unit(unitId as string, signal),
    enabled: canRead && !!unitId,
  });
}

export function useUnitTransfers(unitId: string | undefined) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: ownershipKeys.transfers(apt, unitId ?? ''),
    queryFn: ({ signal }) => ownershipApi.listTransfers(unitId as string, signal).then((r) => r.items),
    enabled: canRead && !!unitId,
  });
}

export function useOwnershipIssues(enabled = true) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: ownershipKeys.issues(apt),
    queryFn: ({ signal }) => ownershipApi.issues(signal),
    enabled: canRead && enabled,
  });
}

/** Devir onizlemesi (yazmaz): taslak gecerli degilken (null) istek atilmaz, onbellekte tutulmaz. */
export function useTransferPreview(unitId: string | undefined, input: TransferInput | null) {
  const { apt, canWrite } = useApt();
  return useQuery({
    queryKey: ownershipKeys.preview(apt, unitId ?? '', input),
    queryFn: ({ signal }) => ownershipApi.previewTransfer(unitId as string, input as TransferInput, signal),
    enabled: canWrite && !!unitId && input !== null,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Devir/mod/sicil degisiklikleri defteri, uyelikleri ve aidat durumunu etkiler. */
function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) }),
      queryClient.invalidateQueries({ queryKey: unitKeys.memberships(apt) }),
    ]);
}

export function useSetBilling() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ unitId, ...input }: { unitId: string; mode: OwnerBilling; reason: string; version: number }) => ownershipApi.setBilling(unitId, input),
    onSuccess: invalidate,
  });
}

export function useSetRepresentative() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ unitId, ...input }: { unitId: string; userId: string | null; version: number }) => ownershipApi.setRepresentative(unitId, input),
    onSuccess: invalidate,
  });
}

export function useSetRegister() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ unitId, input }: { unitId: string; input: RegisterInput }) => ownershipApi.setRegister(unitId, input),
    onSuccess: invalidate,
  });
}

export function useCreateTransfer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ unitId, input }: { unitId: string; input: CreateTransferInput }) => ownershipApi.createTransfer(unitId, input),
    onSuccess: invalidate,
  });
}

export function useReverseTransfer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ transferId, reason }: { transferId: string; reason: string }) => ownershipApi.reverseTransfer(transferId, reason),
    onSuccess: invalidate,
  });
}

export function useBackfillOwnership() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => ownershipApi.backfill(), onSuccess: invalidate });
}
