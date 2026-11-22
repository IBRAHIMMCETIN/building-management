import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type BankExpenseInput, type FormatSpec, type LineStatus, type MatchInput, type SettlePayableInput, bankApi } from '@/lib/api/bank';
import { runAutoMatch } from '@/lib/bank/autoMatch';
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
  reconciliation: (apt: string, acct: string, from = '', to = '') => [...bankKeys.all(apt), 'reconciliation', acct, from, to] as const,
  statements: (apt: string, acct: string) => [...bankKeys.all(apt), 'statements', acct] as const,
  autoPreview: (apt: string, statementId: string, min: number) => [...bankKeys.all(apt), 'auto-match', statementId, min] as const,
  queue: (apt: string, acct: string, status?: LineStatus) => [...bankKeys.all(apt), 'queue', acct, status ?? 'all'] as const,
  targets: (apt: string) => [...bankKeys.all(apt), 'targets'] as const,
  suggestions: (apt: string, acct: string, lineId: string) => [...bankKeys.all(apt), 'suggestions', acct, lineId] as const,
  payableSuggestions: (apt: string, acct: string, lineId: string) => [...bankKeys.all(apt), 'payable-suggestions', acct, lineId] as const,
  format: (apt: string, acct: string) => [...bankKeys.all(apt), 'format', acct] as const,
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

export function useReconciliation(bankAccountId: string | undefined, range: { from?: string; to?: string } = {}) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.reconciliation(apt, bankAccountId ?? '', range.from, range.to),
    queryFn: ({ signal }) => bankApi.reconciliation(bankAccountId as string, range, signal),
    enabled: enabled && !!bankAccountId,
  });
}

// ----- Faz B3 -----

export function useBankStatements(bankAccountId: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.statements(apt, bankAccountId ?? ''),
    queryFn: ({ signal }) => bankApi.statements(bankAccountId as string, signal).then((r) => r.items),
    enabled: enabled && !!bankAccountId,
  });
}

export function useAutoMatchPreview(statementId: string | undefined, minConfidence: number) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.autoPreview(apt, statementId ?? '', minConfidence),
    queryFn: ({ signal }) => bankApi.autoMatchPreview(statementId as string, minConfidence, signal),
    enabled: enabled && !!statementId,
  });
}

/** Toplu onay: ayni anahtarla, calisma tamamlanana kadar tekrar cagirir (API istek basina sinirli). */
export function useAutoMatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { statementId: string; minConfidence: number; idempotencyKey: string }) =>
      runAutoMatch(() => bankApi.autoMatch(v.statementId, { idempotencyKey: v.idempotencyKey, minConfidence: v.minConfidence })),
    onSettled: invalidate,
  });
}

export function useCreateBankExpense() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { lineId: string; input: BankExpenseInput }) => bankApi.expense(v.lineId, v.input), onSuccess: invalidate });
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
    mutationFn: (v: { statementId: string; expectedVersion: number; acknowledgeWarnings: boolean; rememberFormat?: boolean }) =>
      bankApi.commit(v.statementId, {
        expectedVersion: v.expectedVersion,
        acknowledgeWarnings: v.acknowledgeWarnings,
        ...(v.rememberFormat ? { rememberFormat: true } : {}),
      }),
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

// ----- Faz B3.5 -----

/** Cikan satir icin tedarikci onerileri ve acik borclu tedarikciler (diyalog acikken). */
export function usePayableSuggestions(bankAccountId: string, lineId: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.payableSuggestions(apt, bankAccountId, lineId ?? ''),
    queryFn: ({ signal }) => bankApi.payableSuggestions(lineId as string, bankAccountId, signal),
    enabled: enabled && !!lineId && !!bankAccountId,
  });
}

export function useSettlePayable() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { lineId: string; input: SettlePayableInput }) => bankApi.settlePayable(v.lineId, v.input), onSuccess: invalidate });
}

/** Hesaba kayitli sutun eslemesi (yukleme sihirbazinda kaynak gosterimi). */
export function useSavedFormat(bankAccountId: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: bankKeys.format(apt, bankAccountId ?? ''),
    queryFn: ({ signal }) => bankApi.getFormat(bankAccountId as string, signal),
    enabled: enabled && !!bankAccountId,
  });
}
