import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Equipment, type EquipmentInput, type EquipmentListQuery, equipmentApi } from '@/lib/api/equipment';
import type { EquipmentDocumentKind } from '@/lib/equipment/model';
import { EQUIPMENT_ROLES, type Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (equipment/routes.ts). Gorevli masraf ve servis sozlesmesini gormez. */
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];
const COSTS: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

export function useEquipmentPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  const has = (list: readonly Role[]) => !!role && list.includes(role);
  return { canRead: has(EQUIPMENT_ROLES), canWrite: has(WRITE), canReadCosts: has(COSTS) };
}

export const equipmentKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'equipment'] as const,
  list: (apt: string, q: EquipmentListQuery) => [...equipmentKeys.all(apt), 'list', q] as const,
  expiring: (apt: string) => [...equipmentKeys.all(apt), 'expiring'] as const,
  detail: (apt: string, id: string) => [...equipmentKeys.all(apt), 'detail', id] as const,
  history: (apt: string, id: string) => [...equipmentKeys.all(apt), 'history', id] as const,
  options: (apt: string) => [...equipmentKeys.all(apt), 'options'] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useEquipmentPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useEquipmentList(q: EquipmentListQuery) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: equipmentKeys.list(apt, q), queryFn: ({ signal }) => equipmentApi.list(q, signal), enabled, placeholderData: keepPreviousData });
}

export function useEquipmentExpiring() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: equipmentKeys.expiring(apt), queryFn: ({ signal }) => equipmentApi.expiring(30, signal).then((r) => r.items), enabled });
}

export function useEquipment(id: string | null) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: equipmentKeys.detail(apt, id ?? ''), queryFn: ({ signal }) => equipmentApi.get(id ?? '', signal).then((r) => r.equipment), enabled: enabled && !!id });
}

export function useEquipmentHistory(id: string | null) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: equipmentKeys.history(apt, id ?? ''), queryFn: ({ signal }) => equipmentApi.history(id ?? '', signal), enabled: enabled && !!id });
}

/**
 * Talep / bakim formlarindaki ekipman secimi: hizmetteki ekipman (calisiyor + devre disi).
 * Rolu ekipman sicilini okuyamayan (guvenlik) icin sorgu calismaz ve liste bos kalir.
 */
export function useEquipmentOptions() {
  const { apt, enabled } = useApt();
  return useQuery({
    queryKey: equipmentKeys.options(apt),
    queryFn: ({ signal }) => equipmentApi.list({ limit: 200 }, signal).then((r) => r.items),
    enabled,
    staleTime: 60_000,
  });
}

/** Ekipman, talep ve bakim ekranlari birlikte tazelenir (gecmis ve baglantilar). */
function useInvalidate() {
  const { apt } = useApt();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: equipmentKeys.all(apt) });
}

export function useSaveEquipment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id?: string; version?: number; input: EquipmentInput }) =>
      v.id && v.version ? equipmentApi.update(v.id, { ...v.input, version: v.version }) : equipmentApi.create(v.input),
    onSettled: () => invalidate(),
  });
}

export function useEquipmentStatus() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; version: number; status: Equipment['status']; note?: string }) => equipmentApi.setStatus(v.id, { version: v.version, status: v.status, ...(v.note ? { note: v.note } : {}) }),
    onSettled: () => invalidate(),
  });
}

export function useAddEquipmentDocument(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { version: number; file: File; kind: EquipmentDocumentKind; title?: string; validUntil?: string }) => equipmentApi.addDocument(id, v),
    onSettled: () => invalidate(),
  });
}

export function useArchiveEquipmentDocument(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { documentId: string; version: number }) => equipmentApi.archiveDocument(id, v.documentId, v.version), onSettled: () => invalidate() });
}
