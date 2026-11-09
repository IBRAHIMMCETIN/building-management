import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ChargeDuesInput,
  type FinanceAccount,
  type RecordExpenseInput,
  type RecordPaymentInput,
  financeApi,
} from '@/lib/api/finance';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (finance/routes.ts). */
const FINANCE_READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const FINANCE_WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useFinancePermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return {
    canRead: !!role && FINANCE_READ.includes(role),
    canWrite: !!role && FINANCE_WRITE.includes(role),
  };
}

export const financeKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'finance'] as const,
  summary: (apt: string) => [...financeKeys.all(apt), 'summary'] as const,
  dues: (apt: string) => [...financeKeys.all(apt), 'dues-status'] as const,
  transactions: (apt: string, filter: { from?: string; to?: string }) => [...financeKeys.all(apt), 'transactions', filter] as const,
  accounts: (apt: string, type?: string) => [...financeKeys.all(apt), 'accounts', type ?? 'all'] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useFinancePermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useFinanceSummary() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: financeKeys.summary(apt), queryFn: ({ signal }) => financeApi.summary(signal), enabled });
}

export function useDuesStatus() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: financeKeys.dues(apt), queryFn: ({ signal }) => financeApi.duesStatus(signal), enabled });
}

/** Defter hareketleri, en yeni once; "daha fazla" ile sonraki sayfa (imlec). */
export function useTransactions(filter: { from?: string; to?: string } = {}, pageSize = 30) {
  const { apt, enabled } = useApt();
  return useInfiniteQuery({
    queryKey: financeKeys.transactions(apt, filter),
    queryFn: ({ pageParam, signal }) => financeApi.transactions({ ...filter, limit: pageSize, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useFinanceAccounts(type?: FinanceAccount['type']) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: financeKeys.accounts(apt, type),
    queryFn: ({ signal }) => financeApi.accounts(type, signal).then((r) => r.items.filter((a) => a.status === 'active')),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * Her defter yazimi ozeti, hareketleri, aidat durumunu ve hesap bakiyelerini etkiler:
 * finans anahtarinin tamami gecersiz kilinir (tek apartman, ucuz).
 */
function useInvalidateFinance() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) });
}

export function useRecordPayment() {
  const invalidate = useInvalidateFinance();
  return useMutation({ mutationFn: (input: RecordPaymentInput) => financeApi.recordPayment(input), onSuccess: invalidate });
}

export function useRecordExpense() {
  const invalidate = useInvalidateFinance();
  return useMutation({ mutationFn: (input: RecordExpenseInput) => financeApi.recordExpense(input), onSuccess: invalidate });
}

export function useChargeDues() {
  const invalidate = useInvalidateFinance();
  return useMutation({ mutationFn: (input: ChargeDuesInput) => financeApi.chargeDues(input), onSuccess: invalidate });
}
