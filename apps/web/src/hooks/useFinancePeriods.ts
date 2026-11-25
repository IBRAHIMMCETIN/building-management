import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type BudgetInput, type ReportKind, type ReportQuery, financePeriodsApi } from '@/lib/api/financePeriods';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';
import { unitKeys } from './useUnits';

/** Finans 2.4: donem kapanisi, raporlar, Genel Bakis ve butce sorgulari (finans anahtari altinda). */
export const periodKeys = {
  status: (apt: string) => [...financeKeys.all(apt), 'periods'] as const,
  checklist: (apt: string, period: string) => [...financeKeys.all(apt), 'periods', period, 'checklist'] as const,
  report: (apt: string, kind: ReportKind, query: ReportQuery) => [...financeKeys.all(apt), 'reports', kind, query] as const,
  dashboard: (apt: string) => [...financeKeys.all(apt), 'dashboard'] as const,
  budgets: (apt: string, year?: number) => [...financeKeys.all(apt), 'budgets', year ?? 'all'] as const,
  budgetDues: (apt: string, budgetId: string, month?: string) => [...financeKeys.all(apt), 'budgets', budgetId, 'dues', month ?? ''] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useFinancePermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

function useInvalidateFinance() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) });
}

export function usePeriodStatus() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: periodKeys.status(apt), queryFn: ({ signal }) => financePeriodsApi.status(signal), enabled });
}

export function usePeriodChecklist(period: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: periodKeys.checklist(apt, period ?? ''),
    queryFn: ({ signal }) => financePeriodsApi.checklist(period as string, signal),
    enabled: enabled && !!period,
    retry: false,
  });
}

export function useClosePeriod() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (v: { period: string; expectedLockVersion: number; acknowledgeWarnings: string[] }) =>
      financePeriodsApi.close(v.period, { expectedLockVersion: v.expectedLockVersion, acknowledgeWarnings: v.acknowledgeWarnings }),
    onSettled: invalidate,
  });
}

export function useReopenPeriod() {
  const invalidate = useInvalidateFinance();
  return useMutation({ mutationFn: (v: { period: string; reason: string }) => financePeriodsApi.reopen(v.period, v.reason), onSettled: invalidate });
}

export function useFinanceReport<K extends ReportKind>(kind: K, query: ReportQuery, active = true) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: periodKeys.report(apt, kind, query),
    queryFn: ({ signal }) => financePeriodsApi.report(kind, query, signal),
    enabled: enabled && active,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useReportPdf() {
  return useMutation({ mutationFn: (v: { kind: ReportKind; query: ReportQuery }) => financePeriodsApi.reportPdf(v.kind, v.query) });
}

export function useFinanceDashboard() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: periodKeys.dashboard(apt), queryFn: ({ signal }) => financePeriodsApi.dashboard(signal), enabled });
}

export function useBudgets(year?: number) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: periodKeys.budgets(apt, year), queryFn: ({ signal }) => financePeriodsApi.budgets(year, signal), enabled });
}

export function useBudgetDuesPreview(budgetId: string | undefined, month?: string) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: periodKeys.budgetDues(apt, budgetId ?? '', month),
    queryFn: ({ signal }) => financePeriodsApi.budgetDuesPreview(budgetId as string, month, signal),
    enabled: enabled && !!budgetId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useCreateBudget() {
  const invalidate = useInvalidateFinance();
  return useMutation({ mutationFn: (input: BudgetInput & { year: number; copyFrom?: string }) => financePeriodsApi.createBudget(input), onSuccess: invalidate });
}

export function useUpdateBudget() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (v: { budgetId: string; input: BudgetInput & { version: number } }) => financePeriodsApi.updateBudget(v.budgetId, v.input),
    onSettled: invalidate,
  });
}

export function useDeleteBudget() {
  const invalidate = useInvalidateFinance();
  return useMutation({ mutationFn: (v: { budgetId: string; version: number }) => financePeriodsApi.deleteBudget(v.budgetId, v.version), onSettled: invalidate });
}

export function useApproveBudget() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (v: { budgetId: string; version: number; decisionRef: string; decisionDate: string }) =>
      financePeriodsApi.approveBudget(v.budgetId, { version: v.version, decisionRef: v.decisionRef, decisionDate: v.decisionDate }),
    onSettled: invalidate,
  });
}

/** Aidat planina uygulama site ayarlarini degistirir: apartmanin tum sorgulari yenilenir. */
export function useApplyBudgetDuesPlan() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { budgetId: string; siteVersion: number; month?: string }) => financePeriodsApi.applyDuesPlan(v.budgetId, { siteVersion: v.siteVersion, month: v.month }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: unitKeys.apartment(apt) }),
  });
}
