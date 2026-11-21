import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { ApiError } from '@/lib/api/errors';
import {
  type AccountPatch,
  type CreatePaymentInput,
  type IntentStatus,
  type PaymentIntent,
  type PayoutStatus,
  type ResendInput,
  type ResolveInput,
  type SubMerchantInput,
  paymentsApi,
} from '@/lib/api/payments';
import { RESULT_POLL_LIMIT_MS, RESULT_POLL_MS, TERMINAL_STATUSES } from '@/lib/payments/result';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';
import { portalKeys } from './usePortal';

/** Beklenen 4xx'ler (daire secimi, uyelik yok, bulunamadi) tekrar denenmez. */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

function useResidentScope() {
  const { user } = useAuth();
  const { unitId } = usePortalUnit();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', unitId, enabled: user?.role === 'resident' && !!user.apartmentId };
}

export const paymentKeys = {
  quote: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'payment-quote', unitId ?? 'auto'] as const,
  intent: (apt: string, user: string, intentId: string) => [...portalKeys.all(apt, user), 'payment-intent', intentId] as const,
};

/** Odenebilir kalemler ve online odemenin acik olup olmadigi. */
export function usePaymentQuote() {
  const { apt, userId, unitId, enabled } = useResidentScope();
  return useQuery({
    queryKey: paymentKeys.quote(apt, userId, unitId),
    queryFn: ({ signal }) => paymentsApi.quote(unitId, signal),
    enabled,
    retry,
  });
}

export function useCreatePayment() {
  return useMutation({ mutationFn: (input: CreatePaymentInput) => paymentsApi.create(input) });
}

/**
 * Sonuc sayfasi: niyet durumunu kesinlesene kadar sorgular. Her sorgu `refresh=1` ile gider: tarayici
 * callback'i kaybolsa da API sonucu saglayicidan sorgulayip sonuclandirir. RESULT_POLL_LIMIT_MS
 * sonra durur (mutabakat gorevi arka planda tamamlar). Basarida portal verileri yenilenir.
 */
export function usePaymentIntent(intentId: string | null) {
  const { apt, userId, enabled } = useResidentScope();
  const queryClient = useQueryClient();
  const startedAt = useRef(Date.now());
  const invalidated = useRef(false);

  const query = useQuery({
    queryKey: paymentKeys.intent(apt, userId, intentId ?? ''),
    queryFn: async ({ signal }): Promise<PaymentIntent> => {
      const intent = await paymentsApi.get(intentId as string, true, signal);
      if (intent.status === 'SUCCEEDED' && !invalidated.current) {
        invalidated.current = true;
        void queryClient.invalidateQueries({ queryKey: portalKeys.all(apt, userId) });
      }
      return intent;
    },
    enabled: enabled && !!intentId,
    retry,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (status && TERMINAL_STATUSES.includes(status)) return false;
      return Date.now() - startedAt.current < RESULT_POLL_LIMIT_MS ? RESULT_POLL_MS : false;
    },
  });
  // Sorgulama durduktan sonra ekranin "bekleniyor"da kalmamasi icin ayri zamanlayici.
  const [limitReached, setLimitReached] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLimitReached(true), RESULT_POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const timedOut = limitReached && query.data?.status === 'PENDING';
  return { ...query, timedOut };
}

// ---------------------------------------------------------------------------
// Yonetici / denetci: Finans > Online odemeler (salt okunur)
// ---------------------------------------------------------------------------

export const managerPaymentKeys = {
  all: (apt: string) => [...financeKeys.all(apt), 'online-payments'] as const,
  list: (apt: string, status?: IntentStatus) => [...managerPaymentKeys.all(apt), 'list', status ?? 'all'] as const,
  reviewCount: (apt: string) => [...managerPaymentKeys.all(apt), 'review-count'] as const,
  account: (apt: string) => [...managerPaymentKeys.all(apt), 'account'] as const,
};

function useManagerScope() {
  const { user } = useAuth();
  const { canRead } = useFinancePermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

/** Odeme niyetleri, en yeni once; "daha fazla" ile sonraki sayfa. */
export function useManagerPayments(status?: IntentStatus, pageSize = 25) {
  const { apt, enabled } = useManagerScope();
  return useInfiniteQuery({
    queryKey: managerPaymentKeys.list(apt, status),
    queryFn: ({ pageParam, signal }) => paymentsApi.managerList({ status, limit: pageSize, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    retry,
  });
}

/** Inceleme bekleyen odeme sayisi (uyari bandi icin; en fazla 100 sayilir). */
export function useNeedsReviewCount() {
  const { apt, enabled } = useManagerScope();
  return useQuery({
    queryKey: managerPaymentKeys.reviewCount(apt),
    queryFn: ({ signal }) => paymentsApi.managerList({ status: 'NEEDS_REVIEW', limit: 100 }, signal),
    select: (r) => ({ count: r.items.length, more: !!r.nextCursor }),
    enabled,
    retry,
  });
}

export function usePaymentAccountSummary() {
  const { apt, enabled } = useManagerScope();
  return useQuery({
    queryKey: managerPaymentKeys.account(apt),
    queryFn: ({ signal }) => paymentsApi.managerAccount(signal),
    enabled,
    retry,
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Platform yoneticisi: apartmanlarin odeme hesaplari
// ---------------------------------------------------------------------------

export const platformPaymentKeys = {
  all: () => ['platform', 'payments'] as const,
  apartments: () => ['platform', 'payments', 'apartments'] as const,
  reviewQueue: () => ['platform', 'payments', 'review'] as const,
  reviewCheck: (apartmentId: string, intentId: string) => ['platform', 'payments', 'review', 'check', apartmentId, intentId] as const,
  settings: (apartmentId: string) => ['platform', 'payments', 'settings', apartmentId] as const,
  payouts: (status: string, days: number) => ['platform', 'payments', 'payouts', status, days] as const,
  settlements: (days: number) => ['platform', 'payments', 'settlements', days] as const,
  invoices: (period: string) => ['platform', 'payments', 'invoices', period] as const,
};

export function usePlatformPaymentApartments() {
  const { user } = useAuth();
  return useQuery({
    queryKey: platformPaymentKeys.apartments(),
    queryFn: ({ signal }) => paymentsApi.platformApartments(signal),
    enabled: user?.role === 'platform_admin',
    retry,
  });
}

function useInvalidatePlatform() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: platformPaymentKeys.apartments() });
}

export function useOnboardSubMerchant() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: ({ apartmentId, input }: { apartmentId: string; input: SubMerchantInput }) => paymentsApi.onboard(apartmentId, input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdatePaymentAccount() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: ({ apartmentId, patch }: { apartmentId: string; patch: AccountPatch }) => paymentsApi.updateAccount(apartmentId, patch),
    onSuccess: () => invalidate(),
  });
}

// ---------------------------------------------------------------------------
// Platform yoneticisi: NEEDS_REVIEW elle sonuclandirma
// ---------------------------------------------------------------------------

export function useReviewQueue() {
  const { user } = useAuth();
  return useQuery({
    queryKey: platformPaymentKeys.reviewQueue(),
    queryFn: ({ signal }) => paymentsApi.reviewQueue(signal),
    enabled: user?.role === 'platform_admin',
    retry,
    // Iade suren kayitlar mutabakatla ilerler: ekran acikken ara ara tazelenir.
    refetchInterval: 60_000,
  });
}

/** Saglayicidan guncel sonuc + yapilabilecek islemler. Her acilista yeniden sorgulanir (onbellek yok). */
export function useReviewCheck(target: { apartmentId: string; intentId: string } | null) {
  return useQuery({
    queryKey: platformPaymentKeys.reviewCheck(target?.apartmentId ?? '', target?.intentId ?? ''),
    queryFn: ({ signal }) => paymentsApi.reviewCheck(target!.apartmentId, target!.intentId, signal),
    enabled: target !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useResolveReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ apartmentId, intentId, input }: { apartmentId: string; intentId: string; input: ResolveInput }) =>
      paymentsApi.resolveReview(apartmentId, intentId, input),
    // Basarili ya da 409 (kayit degisti): kuyruk ve kontrol yeniden okunur.
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformPaymentKeys.all() }),
  });
}

// ---------------------------------------------------------------------------
// Platform yoneticisi (P5): saglayici secimi, aktarimlar, komisyon faturalari
// ---------------------------------------------------------------------------

function usePlatformEnabled() {
  const { user } = useAuth();
  return user?.role === 'platform_admin';
}

/** Apartmanin saglayici tercihi; diyalog her acildiginda guncel surum okunur. */
export function usePaymentSettings(apartmentId: string | null) {
  return useQuery({
    queryKey: platformPaymentKeys.settings(apartmentId ?? ''),
    queryFn: ({ signal }) => paymentsApi.settings(apartmentId as string, signal),
    enabled: usePlatformEnabled() && apartmentId !== null,
    retry,
    staleTime: 0,
  });
}

export function useUpdatePaymentSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ apartmentId, paymentProvider, expectedVersion }: { apartmentId: string; paymentProvider: string | null; expectedVersion: number }) =>
      paymentsApi.updateSettings(apartmentId, { paymentProvider, expectedVersion }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformPaymentKeys.all() }),
  });
}

export function usePlatformPayouts(status: PayoutStatus | 'all' | undefined, days: number) {
  return useQuery({
    queryKey: platformPaymentKeys.payouts(status ?? 'attention', days),
    queryFn: ({ signal }) => paymentsApi.payouts({ status, days }, signal),
    enabled: usePlatformEnabled(),
    retry,
    // Geri donus ve yeniden gonderim zamanlanmis gorevle ilerler: ekran acikken tazelenir.
    refetchInterval: 60_000,
  });
}

export function useResendPayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ apartmentId, transferId, input }: { apartmentId: string; transferId: string; input: ResendInput }) =>
      paymentsApi.resendPayout(apartmentId, transferId, input),
    // Basarili ya da 409: aktarimlar ve (IBAN duzeltildiyse) hesaplar yeniden okunur.
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformPaymentKeys.all() }),
  });
}

export function usePlatformSettlements(days = 30) {
  return useQuery({
    queryKey: platformPaymentKeys.settlements(days),
    queryFn: ({ signal }) => paymentsApi.settlements({ days }, signal),
    enabled: usePlatformEnabled(),
    retry,
    refetchInterval: 60_000,
  });
}

export function useReleaseSettlement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ apartmentId, intentId, input }: { apartmentId: string; intentId: string; input: { note: string; expectedVersion: number } }) =>
      paymentsApi.releaseSettlement(apartmentId, intentId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformPaymentKeys.all() }),
  });
}

export function usePlatformInvoices(period: string) {
  return useQuery({
    queryKey: platformPaymentKeys.invoices(period),
    queryFn: ({ signal }) => paymentsApi.invoices(period, signal),
    enabled: usePlatformEnabled() && /^\d{4}-\d{2}$/.test(period),
    retry,
  });
}

/** Fatura islemleri (taslak yenile / kesildi / iptal): sonrasinda donem listesi yeniden okunur. */
export function useInvoiceAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      a:
        | { kind: 'draft'; apartmentId: string; period: string }
        | { kind: 'issue'; apartmentId: string; invoiceId: string; expectedVersion: number; invoiceNumber: string }
        | { kind: 'cancel'; apartmentId: string; invoiceId: string; expectedVersion: number; reason: string },
    ) => {
      if (a.kind === 'draft') return paymentsApi.draftInvoices(a.apartmentId, a.period);
      if (a.kind === 'issue') return paymentsApi.issueInvoice(a.apartmentId, a.invoiceId, { expectedVersion: a.expectedVersion, invoiceNumber: a.invoiceNumber });
      return paymentsApi.cancelInvoice(a.apartmentId, a.invoiceId, { expectedVersion: a.expectedVersion, reason: a.reason });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...platformPaymentKeys.all(), 'invoices'] }),
  });
}
