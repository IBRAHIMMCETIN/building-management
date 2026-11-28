import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeature } from '@/context/SiteFeaturesContext';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { ApiError } from '@/lib/api/errors';
import type { CreatePlanRequestInput, PlanRequestStatus } from '@bm/shared/api/planRequests';
import {
  type ApprovePlanRequestInput,
  type PlanRequestSettings,
  type ApproveOffsetRequestInput,
  type CreateOffsetInput,
  type CreateOffsetRequestInput,
  type CreatePlanInput,
  type OffsetRequestStatus,
  type PlanAction,
  type PlanDisplayStatus,
  type PlanInput,
  restructureApi,
} from '@/lib/api/restructure';
import { useAuth } from './useAuth';
import { financeKeys, useFinancePermissions } from './useFinance';
import { portalKeys } from './usePortal';

/** Mahsup ve plan verisi finans anahtarinin altinda: her yazim defteri de etkiler. */
export const restructureKeys = {
  all: (apt: string) => [...financeKeys.all(apt), 'restructure'] as const,
  offsetPreview: (apt: string, source: string, target: string) => [...restructureKeys.all(apt), 'offset-preview', source, target] as const,
  offsets: (apt: string, accountId?: string) => [...restructureKeys.all(apt), 'offsets', accountId ?? 'all'] as const,
  requests: (apt: string, status?: OffsetRequestStatus) => [...restructureKeys.all(apt), 'offset-requests', status ?? 'all'] as const,
  plans: (apt: string, filter: { accountId?: string; status?: PlanDisplayStatus }) => [...restructureKeys.all(apt), 'plans', filter] as const,
  openItems: (apt: string, accountId: string) => [...restructureKeys.all(apt), 'open-items', accountId] as const,
  planPreview: (apt: string, input: PlanInput | null) => [...restructureKeys.all(apt), 'plan-preview', input] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead, canWrite } = useFinancePermissions();
  const apt = user?.apartmentId ?? '';
  return { apt, canRead: !!apt && canRead, canWrite: !!apt && canWrite };
}

function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: financeKeys.all(apt) });
}

// ----- Avans mahsubu -----

/** Onizleme (yazmaz): kaynak ve hedef secilip farkli olunca. */
export function useOffsetPreview(sourceAccountId: string, targetAccountId: string) {
  const { apt, canWrite } = useApt();
  return useQuery({
    queryKey: restructureKeys.offsetPreview(apt, sourceAccountId, targetAccountId),
    queryFn: ({ signal }) => restructureApi.previewOffset({ sourceAccountId, targetAccountId }, signal),
    enabled: canWrite && !!sourceAccountId && !!targetAccountId && sourceAccountId !== targetAccountId,
    retry: false,
  });
}

export function useOffsets(accountId?: string) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: restructureKeys.offsets(apt, accountId),
    queryFn: ({ signal }) => restructureApi.listOffsets(accountId, signal).then((r) => r.items),
    enabled: canRead,
  });
}

export function useCreateOffset() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreateOffsetInput) => restructureApi.createOffset(input), onSuccess: invalidate });
}

export function useReverseOffset() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { offsetId: string; reason: string }) => restructureApi.reverseOffset(v.offsetId, v.reason), onSuccess: invalidate });
}

export function useOffsetRequests(status?: OffsetRequestStatus) {
  const { apt, canRead } = useApt();
  return useQuery({
    queryKey: restructureKeys.requests(apt, status),
    queryFn: ({ signal }) => restructureApi.listOffsetRequests(status, signal).then((r) => r.items),
    enabled: canRead,
  });
}

export function useApproveOffsetRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { requestId: string; input: ApproveOffsetRequestInput }) => restructureApi.approveOffsetRequest(v.requestId, v.input),
    onSuccess: invalidate,
  });
}

export function useRejectOffsetRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { requestId: string; reason: string }) => restructureApi.rejectOffsetRequest(v.requestId, v.reason),
    onSuccess: invalidate,
  });
}

// ----- Borc yapilandirma -----

export function usePlans(filter: { accountId?: string; status?: PlanDisplayStatus } = {}) {
  const { apt, canRead } = useApt();
  // Adim 1: borc yapilandirma sitede kapaliysa liste istenmez (API 403 feature_disabled).
  const on = useFeature('admin.debtRestructure');
  return useQuery({
    queryKey: restructureKeys.plans(apt, filter),
    queryFn: ({ signal }) => restructureApi.listPlans(filter, signal).then((r) => r.items),
    enabled: canRead && on,
  });
}

export function usePlanOpenItems(accountId: string) {
  const { apt, canWrite } = useApt();
  return useQuery({
    queryKey: restructureKeys.openItems(apt, accountId),
    queryFn: ({ signal }) => restructureApi.planOpenItems(accountId, signal),
    enabled: canWrite && !!accountId,
  });
}

/** Plan onizlemesi (yazmaz): taslak gecersizken (null) istek atilmaz. */
export function usePlanPreview(input: PlanInput | null) {
  const { apt, canWrite } = useApt();
  return useQuery({
    queryKey: restructureKeys.planPreview(apt, input),
    queryFn: ({ signal }) => restructureApi.previewPlan(input as PlanInput, signal),
    enabled: canWrite && input !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useCreatePlan() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreatePlanInput) => restructureApi.createPlan(input), onSuccess: invalidate });
}

export function usePlanAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { planId: string; action: PlanAction; reason: string }) => restructureApi.planAction(v.planId, v.action, v.reason),
    onSuccess: invalidate,
  });
}

// ----- Sakin portali -----

/** Daire secimi / uyelik yok gibi "beklenen" 4xx'ler tekrar denenmez. */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

function usePortalScope() {
  const { user } = useAuth();
  const { unitId } = usePortalUnit();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', unitId, enabled: user?.role === 'resident' && !!user.apartmentId };
}

const portalRestructureKeys = {
  plans: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'plans', unitId ?? 'auto'] as const,
  options: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'offset-options', unitId ?? 'auto'] as const,
  requests: (apt: string, user: string) => [...portalKeys.all(apt, user), 'offset-requests'] as const,
};

export function useMyPlans() {
  const { apt, userId, unitId, enabled } = usePortalScope();
  const on = useFeature('resident.restructure');
  return useQuery({
    queryKey: portalRestructureKeys.plans(apt, userId, unitId),
    queryFn: ({ signal }) => restructureApi.myPlans(unitId, signal).then((r) => r.items),
    enabled: enabled && on,
    retry,
  });
}

export function useOffsetOptions() {
  const { apt, userId, unitId, enabled } = usePortalScope();
  const on = useFeature('resident.advanceOffset');
  return useQuery({
    queryKey: portalRestructureKeys.options(apt, userId, unitId),
    queryFn: ({ signal }) => restructureApi.offsetOptions(unitId, signal),
    enabled: enabled && on,
    retry,
  });
}

export function useMyOffsetRequests() {
  const { apt, userId, enabled } = usePortalScope();
  const on = useFeature('resident.advanceOffset');
  return useQuery({
    queryKey: portalRestructureKeys.requests(apt, userId),
    queryFn: ({ signal }) => restructureApi.myOffsetRequests(signal).then((r) => r.items),
    enabled: enabled && on,
    retry,
  });
}

// ----- Sakin: yapilandirma talebi (Finans 2.2 sonrasi) -----

const portalPlanRequestKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'plan-requests'] as const,
  options: (apt: string, user: string, unitId?: string) => [...portalPlanRequestKeys.all(apt, user), 'options', unitId ?? 'auto'] as const,
  mine: (apt: string, user: string) => [...portalPlanRequestKeys.all(apt, user), 'mine'] as const,
};

export function usePlanRequestOptions() {
  const { apt, userId, unitId, enabled } = usePortalScope();
  const on = useFeature('resident.restructure');
  return useQuery({
    queryKey: portalPlanRequestKeys.options(apt, userId, unitId),
    queryFn: ({ signal }) => restructureApi.planRequestOptions(unitId, signal),
    enabled: enabled && on,
    retry,
  });
}

export function useMyPlanRequests() {
  const { apt, userId, enabled } = usePortalScope();
  const on = useFeature('resident.restructure');
  return useQuery({
    queryKey: portalPlanRequestKeys.mine(apt, userId),
    queryFn: ({ signal }) => restructureApi.myPlanRequests(signal).then((r) => r.items),
    enabled: enabled && on,
    retry,
  });
}

/** Talep / geri cekme sonrasi secenekler, talepler ve plan karti yeniden cekilir. */
export function useCreatePlanRequest() {
  const { apt, userId, unitId } = usePortalScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreatePlanRequestInput, 'unitId'>) => restructureApi.createPlanRequest({ ...input, ...(unitId ? { unitId } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all(apt, userId) }),
  });
}

export function useWithdrawPlanRequest() {
  const { apt, userId } = usePortalScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => restructureApi.withdrawPlanRequest(requestId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all(apt, userId) }),
  });
}

// ----- Yonetici: yapilandirma talepleri -----

/** KVKK: talepler yalnizca yonetici + firma (denetci istemez; API 403). */
export function usePlanRequests(status?: PlanRequestStatus) {
  const { apt, canWrite } = useApt();
  const on = useFeature('admin.debtRestructure');
  return useQuery({
    queryKey: [...restructureKeys.all(apt), 'plan-requests', status ?? 'all'] as const,
    queryFn: ({ signal }) => restructureApi.listPlanRequests(status, signal),
    enabled: canWrite && on,
  });
}

export function usePlanRequestDetail(requestId: string | null) {
  const { apt, canWrite } = useApt();
  return useQuery({
    queryKey: [...restructureKeys.all(apt), 'plan-request', requestId ?? ''] as const,
    queryFn: ({ signal }) => restructureApi.planRequest(requestId as string, signal),
    enabled: canWrite && !!requestId,
  });
}

export function useApprovePlanRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { requestId: string; input: ApprovePlanRequestInput }) => restructureApi.approvePlanRequest(v.requestId, v.input),
    onSuccess: invalidate,
  });
}

export function useRejectPlanRequest() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { requestId: string; reason: string }) => restructureApi.rejectPlanRequest(v.requestId, v.reason), onSuccess: invalidate });
}

export function usePlanRequestSettings() {
  const { apt, canWrite } = useApt();
  const on = useFeature('admin.debtRestructure');
  return useQuery({
    queryKey: [...restructureKeys.all(apt), 'plan-request-settings'] as const,
    queryFn: ({ signal }) => restructureApi.planRequestSettings(signal),
    enabled: canWrite && on,
  });
}

export function useSavePlanRequestSettings() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: Partial<PlanRequestSettings> & { version: number }) => restructureApi.savePlanRequestSettings(input), onSuccess: invalidate });
}

export function useCreateOffsetRequest() {
  const { apt, userId, unitId } = usePortalScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateOffsetRequestInput, 'unitId'>) => restructureApi.createOffsetRequest({ ...input, ...(unitId ? { unitId } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all(apt, userId) }),
  });
}
