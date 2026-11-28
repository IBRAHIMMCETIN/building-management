import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreateAdvanceInput, type CreateAdvanceOffsetInput, supplierAdvancesApi } from '@/lib/api/supplierAdvances';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';

/*
 * Finans 2.2 sonrasi - tedarikci avansi. Veriler finans anahtarinin altinda: her yazim kasa/banka,
 * tedarikci listesi ve ozet kartlarini da etkiler (tum finans sorgulari yenilenir).
 */
const keys = {
  all: (apt: string) => [...financeKeys.all(apt), 'supplier-advances'] as const,
  list: (apt: string, accountId?: string) => [...keys.all(apt), 'list', accountId ?? 'all'] as const,
  preview: (apt: string, advanceId: string) => [...keys.all(apt), 'offset-preview', advanceId] as const,
  statement: (apt: string, accountId: string, range: { from?: string; to?: string }) => [...keys.all(apt), 'statement', accountId, range] as const,
};

function useScope() {
  const { user } = useAuth();
  const { canRead, canWrite } = useFinancePermissions();
  const apt = user?.apartmentId ?? '';
  return { apt, canRead: !!apt && canRead, canWrite: !!apt && canWrite };
}

function useInvalidate() {
  const { apt } = useScope();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) });
}

export function useSupplierAdvances(accountId?: string) {
  const { apt, canRead } = useScope();
  return useQuery({
    queryKey: keys.list(apt, accountId),
    queryFn: ({ signal }) => supplierAdvancesApi.list(accountId ? { accountId } : {}, signal),
    enabled: canRead,
  });
}

export function useAdvanceOffsetPreview(advanceId: string | null) {
  const { apt, canWrite } = useScope();
  return useQuery({
    queryKey: keys.preview(apt, advanceId ?? ''),
    queryFn: ({ signal }) => supplierAdvancesApi.offsetPreview(advanceId as string, signal),
    enabled: canWrite && !!advanceId,
  });
}

export function useSupplierStatement(accountId: string | null, range: { from?: string; to?: string }) {
  const { apt, canRead } = useScope();
  return useQuery({
    queryKey: keys.statement(apt, accountId ?? '', range),
    queryFn: ({ signal }) => supplierAdvancesApi.statement(accountId as string, range, signal),
    enabled: canRead && !!accountId,
  });
}

export function useCreateSupplierAdvance() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreateAdvanceInput) => supplierAdvancesApi.create(input), onSuccess: invalidate });
}

export function useOffsetSupplierAdvance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { advanceId: string; input: CreateAdvanceOffsetInput }) => supplierAdvancesApi.offset(v.advanceId, v.input),
    onSuccess: invalidate,
  });
}

export function useReverseSupplierAdvance() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { advanceId: string; reason: string }) => supplierAdvancesApi.reverseAdvance(v.advanceId, v.reason), onSuccess: invalidate });
}

export function useReverseAdvanceOffset() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { offsetId: string; reason: string }) => supplierAdvancesApi.reverseOffset(v.offsetId, v.reason), onSuccess: invalidate });
}
