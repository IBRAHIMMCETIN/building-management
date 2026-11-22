import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormatSpec, type LineStatus, type MatchInput, bankApi } from '@/lib/api/bank';
import { portalApi } from '@/lib/api/portal';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';
import { portalKeys } from './usePortal';

/** Banka anahtarlari finans anahtarinin altinda: her finans yazimi banka gorunumlerini de yeniler. */
export const bankKeys = {
  all: (apt: string) => [...financeKeys.all(apt), 'bank'] as const,
  accounts: (apt: string) => [...bankKeys.all(apt), 'accounts'] as const,
  reconciliation: (apt: string, acct: string) => [...bankKeys.all(apt), 'reconciliation', acct] as const,
  queue: (apt: string, acct: string, status?: LineStatus) => [...bankKeys.all(apt), 'queue', acct, status ?? 'all'] as const,
  targets: (apt: string) => [...bankKeys.all(apt), 'targets'] as const,
  suggestions: (apt: string, acct: string, lineId: string) => [...bankKeys.all(apt), 'suggestions', acct, lineId] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useFinancePermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) });
}

export function useBankAccounts() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: bankKeys.accounts(apt), queryFn: ({ signal }) => bankApi.accounts(signal).then((r) => r.items), enabled });
}

export function useReconciliation(bankAccountId: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.reconciliation(apt, bankAccountId ?? ''),
    queryFn: ({ signal }) => bankApi.reconciliation(bankAccountId as string, signal),
    enabled: enabled && !!bankAccountId,
  });
}

export function useBankQueue(bankAccountId: string | undefined, status?: LineStatus) {
  const { apt, enabled } = useApt();
  return useInfiniteQuery({
    queryKey: bankKeys.queue(apt, bankAccountId ?? '', status),
    queryFn: ({ pageParam, signal }) =>
      bankApi.queue({ bankAccountId: bankAccountId as string, limit: 50, ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    enabled: enabled && !!bankAccountId,
  });
}

export function useMatchTargets(enabledWhen = true) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.targets(apt),
    queryFn: ({ signal }) => bankApi.targets(signal).then((r) => r.items),
    enabled: enabled && enabledWhen,
    staleTime: 60_000,
  });
}

export function useLineSuggestions(bankAccountId: string, lineId: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.suggestions(apt, bankAccountId, lineId ?? ''),
    queryFn: ({ signal }) => bankApi.suggestions(bankAccountId, lineId as string, signal),
    enabled: enabled && !!lineId,
  });
}

export function useMatchLine() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { lineId: string; input: MatchInput }) => bankApi.match(v.lineId, v.input), onSuccess: invalidate });
}

export function useIgnoreLine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { lineId: string; bankAccountId: string; expectedVersion: number; reason: string }) =>
      bankApi.ignore(v.lineId, { bankAccountId: v.bankAccountId, expectedVersion: v.expectedVersion, reason: v.reason }),
    onSuccess: invalidate,
  });
}

export function useUnmatchLine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { lineId: string; bankAccountId: string; expectedVersion: number; reason: string }) =>
      bankApi.unmatch(v.lineId, { bankAccountId: v.bankAccountId, expectedVersion: v.expectedVersion, reason: v.reason }),
    onSuccess: invalidate,
  });
}

export function useSaveBankProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { bankAccountId: string; input: Parameters<typeof bankApi.saveProfile>[1] }) => bankApi.saveProfile(v.bankAccountId, v.input),
    onSuccess: invalidate,
  });
}

/** Yukleme + onizleme (ayni ekstre farkli eslemeyle yeniden onizlenebilir). */
export function useStatementPreview() {
  return useMutation({
    mutationFn: async (v: { bankAccountId: string; file: File; statementId?: string; format?: FormatSpec }) => {
      const statementId = v.statementId ?? (await bankApi.uploadStatement(v.bankAccountId, v.file)).statementId;
      try {
        return { statementId, preview: await bankApi.preview({ statementId, bankAccountId: v.bankAccountId, fileName: v.file.name, ...(v.format ? { format: v.format } : {}) }) };
      } catch (err) {
        // Yuklenen dosyanin kimligi hatayla birlikte tasinir: esleme duzeltilip ayni dosya yeniden onizlenir.
        if (err instanceof ApiError) Object.assign(err, { statementId });
        throw err;
      }
    },
  });
}

export function useCommitStatement() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { statementId: string; expectedVersion: number; acknowledgeWarnings: boolean }) =>
      bankApi.commit(v.statementId, { expectedVersion: v.expectedVersion, acknowledgeWarnings: v.acknowledgeWarnings }),
    onSuccess: invalidate,
  });
}

// ----- Sakin: Havale / EFT -----

const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

export function useMyPaymentReference() {
  const { user } = useAuth();
  const { unitId } = usePortalUnit();
  const apt = user?.apartmentId ?? '';
  const userId = user?.sub ?? '';
  return useQuery({
    queryKey: [...portalKeys.all(apt, userId), 'payment-reference', unitId ?? 'auto'] as const,
    queryFn: ({ signal }) => portalApi.myPaymentReference(unitId, signal),
    enabled: user?.role === 'resident' && !!user.apartmentId,
    retry,
    staleTime: 10 * 60_000,
  });
}
