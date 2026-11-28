import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/errors';
import {
  type BillingSettingsInput,
  type ChangePlanInput,
  type MarkPaidInput,
  type PlanInput,
  type StartInput,
  type StatusInput,
  subscriptionsApi,
} from '@/lib/api/subscriptions';
import { OFFICE_ROLES, type Role } from '@/types/roles';
import { useAuth } from './useAuth';

/** Beklenen 4xx'ler tekrar denenmez. */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

export const subscriptionKeys = {
  status: (apt: string) => ['subscription', apt, 'status'] as const,
  mine: (apt: string) => ['subscription', apt, 'detail'] as const,
  platform: () => ['platform', 'billing'] as const,
  settings: () => ['platform', 'billing', 'settings'] as const,
  plans: () => ['platform', 'billing', 'plans'] as const,
  subscriptions: () => ['platform', 'billing', 'subscriptions'] as const,
  invoices: () => ['platform', 'billing', 'invoices'] as const,
};

/** Ust bant ve salt okunur bildirimi: yonetim panelindeki apartman rolleri (sakin ve platform degil). */
const STATUS_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer', 'building_staff', 'security_guard'];

export function useSubscriptionStatus() {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  return useQuery({
    queryKey: subscriptionKeys.status(apt),
    queryFn: ({ signal }) => subscriptionsApi.status(signal),
    enabled: !!apt && !!user?.role && STATUS_ROLES.includes(user.role),
    retry,
    // Durum gunde bir kez degisir; bant her sayfada yeniden istenmez.
    staleTime: 5 * 60_000,
  });
}

/** Ayarlar > Abonelik: yonetici, yonetim firmasi, denetci. */
export function useMySubscription() {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  return useQuery({
    queryKey: subscriptionKeys.mine(apt),
    queryFn: ({ signal }) => subscriptionsApi.mine(signal),
    enabled: !!apt && !!user?.role && (OFFICE_ROLES as readonly Role[]).includes(user.role),
    retry,
  });
}

function usePlatformEnabled() {
  const { user } = useAuth();
  return user?.role === 'platform_admin';
}

/** Platform ayari: abonelik sistemi ve otomatik donem isleme (varsayilan ikisi de kapali). */
export function useBillingSettings() {
  return useQuery({ queryKey: subscriptionKeys.settings(), queryFn: ({ signal }) => subscriptionsApi.settings(signal), enabled: usePlatformEnabled(), retry });
}

export function usePlans() {
  return useQuery({ queryKey: subscriptionKeys.plans(), queryFn: ({ signal }) => subscriptionsApi.plans(signal), enabled: usePlatformEnabled(), retry });
}

export function usePlatformSubscriptions() {
  return useQuery({
    queryKey: subscriptionKeys.subscriptions(),
    queryFn: ({ signal }) => subscriptionsApi.subscriptions(signal),
    enabled: usePlatformEnabled(),
    retry,
  });
}

/** Tum apartmanlarin abonelik faturalari (en yeni once; 100'erli sayfa). */
export function usePlatformSubscriptionInvoices() {
  return useInfiniteQuery({
    queryKey: subscriptionKeys.invoices(),
    queryFn: ({ pageParam, signal }) => subscriptionsApi.invoices(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: usePlatformEnabled(),
    retry,
  });
}

/** Platform islemleri: her biri sonrasinda abonelik, fatura ve plan listeleri yeniden okunur. */
export function useBillingAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      a:
        | { kind: 'settings'; input: BillingSettingsInput }
        | { kind: 'seed' }
        | { kind: 'createPlan'; input: PlanInput & { code: string; idempotencyKey: string } }
        | { kind: 'updatePlan'; code: string; input: PlanInput & { version: number; reason: string } }
        | { kind: 'planStatus'; code: string; input: { version: number; status: 'active' | 'archived'; reason: string } }
        | { kind: 'start'; apartmentId: string; input: StartInput }
        | { kind: 'status'; apartmentId: string; input: StatusInput }
        | { kind: 'changePlan'; apartmentId: string; input: ChangePlanInput }
        | { kind: 'sync'; apartmentId: string }
        | { kind: 'paid'; apartmentId: string; invoiceId: string; input: MarkPaidInput }
        | { kind: 'void'; apartmentId: string; invoiceId: string; input: { version: number; reason: string } },
    ): Promise<unknown> => {
      switch (a.kind) {
        case 'settings':
          return subscriptionsApi.updateSettings(a.input);
        case 'seed':
          return subscriptionsApi.seedPlans();
        case 'createPlan':
          return subscriptionsApi.createPlan(a.input);
        case 'updatePlan':
          return subscriptionsApi.updatePlan(a.code, a.input);
        case 'planStatus':
          return subscriptionsApi.setPlanStatus(a.code, a.input);
        case 'start':
          return subscriptionsApi.start(a.apartmentId, a.input);
        case 'status':
          return subscriptionsApi.changeStatus(a.apartmentId, a.input);
        case 'changePlan':
          return subscriptionsApi.changePlan(a.apartmentId, a.input);
        case 'sync':
          return subscriptionsApi.sync(a.apartmentId);
        case 'paid':
          return subscriptionsApi.markPaid(a.apartmentId, a.invoiceId, a.input);
        case 'void':
          return subscriptionsApi.voidInvoice(a.apartmentId, a.invoiceId, a.input);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: subscriptionKeys.platform() }),
  });
}
