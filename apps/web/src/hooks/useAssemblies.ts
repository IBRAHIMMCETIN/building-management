import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AssemblyInput,
  type AttendanceInput,
  type ConsentEntryInput,
  type ConsentInput,
  type MinutesInput,
  type RescheduleInput,
  type ServiceAttemptInput,
  type ServiceUpdateInput,
  type TallyInput,
  assembliesApi,
} from '@/lib/api/assemblies';
import { ApiError } from '@/lib/api/errors';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { portalKeys } from './usePortal';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (assemblies/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useAssemblyPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const assemblyKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'assemblies'] as const,
  list: (apt: string) => [...assemblyKeys.all(apt), 'list'] as const,
  detail: (apt: string, id: string) => [...assemblyKeys.all(apt), 'detail', id] as const,
  service: (apt: string, id: string, unserved: boolean) => [...assemblyKeys.all(apt), 'service', id, unserved] as const,
  consents: (apt: string) => [...assemblyKeys.all(apt), 'consents'] as const,
  consent: (apt: string, cid: string) => [...assemblyKeys.all(apt), 'consents', cid] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useAssemblyPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useAssemblies() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.list(apt), queryFn: ({ signal }) => assembliesApi.list(signal).then((r) => r.items), enabled });
}

export function useAssembly(id: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.detail(apt, id ?? ''), queryFn: ({ signal }) => assembliesApi.detail(id ?? '', signal), enabled: enabled && !!id });
}

function useInvalidate() {
  const { apt } = useApt();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: assemblyKeys.all(apt) });
}

export function useSaveAssembly() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, version, input }: { id?: string; version?: number; input: AssemblyInput }) =>
      id && version ? assembliesApi.update(id, { ...input, version }) : assembliesApi.create(input),
    onSettled: invalidate,
  });
}

/** Cagri e-postasi (ilk gonderim veya gerekceli yeniden gonderim). */
export function useSendCall(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: { version: number; resend?: boolean; reason?: string }) => assembliesApi.call(id, input), onSettled: invalidate });
}

export function useSetAttendance(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ unitId, ...input }: { unitId: string } & AttendanceInput) => assembliesApi.attendance(id, unitId, input),
    onSettled: invalidate,
  });
}

/** Toplanti yeter sayisini tutanaga gecirir (saglanamadiysa ikinci toplantinin dayanagi). */
export function useRecordQuorum(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ version, noAttendance }: { version: number; noAttendance?: boolean }) => assembliesApi.recordQuorum(id, version, noAttendance),
    onSettled: invalidate,
  });
}

/** Gundem karari; kayitli karar yalnizca gerekceli duzeltmeyle (yeni kayit). */
export function useRecordTally(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: TallyInput }) => assembliesApi.tally(id, itemId, input),
    onSettled: invalidate,
  });
}

export function useSaveMinutes(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: MinutesInput) => assembliesApi.minutes(id, input), onSettled: invalidate });
}

export function useFinalizeAssembly(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (version: number) => assembliesApi.finalize(id, version), onSettled: invalidate });
}

export function useCancelAssembly() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, version, reason }: { id: string; version: number; reason: string }) => assembliesApi.cancel(id, version, reason), onSettled: invalidate });
}

/** Cagrisi gonderilmis toplantinin ertelenmesi / yer degisikligi (maliklere bildirim). */
export function useRescheduleAssembly(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: RescheduleInput) => assembliesApi.reschedule(id, input), onSettled: invalidate });
}

// ---------------------------------------------------------------------------
// Yasal cagri teslim takibi (KMK m.29)
// ---------------------------------------------------------------------------

export function useServiceReport(id: string | undefined, unserved = false) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.service(apt, id ?? '', unserved), queryFn: ({ signal }) => assembliesApi.serviceReport(id ?? '', unserved, signal), enabled: enabled && !!id });
}

export function useAddServiceAttempt(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ ownerId, input }: { ownerId: string; input: ServiceAttemptInput }) => assembliesApi.addServiceAttempt(id, ownerId, input), onSettled: invalidate });
}

export function useUpdateServiceAttempt(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ ownerId, seq, input }: { ownerId: string; seq: number; input: ServiceUpdateInput }) => assembliesApi.updateServiceAttempt(id, ownerId, seq, input),
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Toplanti disinda yazili riza
// ---------------------------------------------------------------------------

export function useConsents() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.consents(apt), queryFn: ({ signal }) => assembliesApi.consents(signal).then((r) => r.items), enabled });
}

export function useConsent(cid: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: assemblyKeys.consent(apt, cid ?? ''), queryFn: ({ signal }) => assembliesApi.consent(cid ?? '', signal), enabled: enabled && !!cid });
}

export function useCreateConsent() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: ConsentInput) => assembliesApi.createConsent(input), onSettled: invalidate });
}

export function useRecordConsent(cid: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ unitId, input }: { unitId: string; input: ConsentEntryInput }) => assembliesApi.recordConsent(cid, unitId, input), onSettled: invalidate });
}

export function useCloseConsent(cid: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (version: number) => assembliesApi.closeConsent(cid, version), onSettled: invalidate });
}

export function useCancelConsent(cid: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ version, reason }: { version: number; reason: string }) => assembliesApi.cancelConsent(cid, version, reason), onSettled: invalidate });
}

// ---------------------------------------------------------------------------
// Sakin portali (kat maliki)
// ---------------------------------------------------------------------------

/** Yetki (kiraci / uyelik yok) gibi "beklenen" 4xx'ler tekrar denenmez. */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

function usePortalScope() {
  const { user } = useAuth();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!user.apartmentId };
}

export const portalAssemblyKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'assemblies'] as const,
  list: (apt: string, user: string) => [...portalAssemblyKeys.all(apt, user), 'list'] as const,
  detail: (apt: string, user: string, id: string) => [...portalAssemblyKeys.all(apt, user), 'detail', id] as const,
};

export function useMyAssemblies() {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({ queryKey: portalAssemblyKeys.list(apt, userId), queryFn: ({ signal }) => assembliesApi.portalList(signal).then((r) => r.items), enabled, retry });
}

export function useMyAssembly(id: string | undefined) {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({ queryKey: portalAssemblyKeys.detail(apt, userId, id ?? ''), queryFn: ({ signal }) => assembliesApi.portalGet(id ?? '', signal), enabled: enabled && !!id, retry });
}
