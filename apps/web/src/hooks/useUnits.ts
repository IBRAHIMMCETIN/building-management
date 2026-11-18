import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreateUnitInput, type InviteResidentInput, type UnitExemption, unitsApi } from '@/lib/api/units';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';

/**
 * Sorgu anahtarlari apartmana gore ayrilir: baglam degisince bir apartmanin listesi
 * digerinde asla gorunmez (ayrica baglam degisiminde onbellek tamamen temizlenir).
 */
export const unitKeys = {
  apartment: (apartmentId: string) => ['apartment', apartmentId] as const,
  units: (apartmentId: string) => ['apartment', apartmentId, 'units'] as const,
  blocks: (apartmentId: string) => ['apartment', apartmentId, 'blocks'] as const,
  memberships: (apartmentId: string) => ['apartment', apartmentId, 'memberships', 'current'] as const,
  people: (apartmentId: string) => ['apartment', apartmentId, 'people'] as const,
};

/** API rol listeleriyle ayni (core / memberships / residents routes). */
const UNIT_READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer', 'building_staff'];
const RESIDENT_READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const UNIT_WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useUnitPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return {
    apartmentId: user?.apartmentId,
    canReadUnits: !!role && UNIT_READ.includes(role),
    /** Bina gorevlisi daireleri gorur ama kisi bilgisini (ad/e-posta) gormez. */
    canReadResidents: !!role && RESIDENT_READ.includes(role),
    canManage: !!role && UNIT_WRITE.includes(role),
  };
}

function useApartmentId(): string {
  const { user } = useAuth();
  // Bu hook'lar yalnizca rol + apartman claim'i olan oturumda (RequireRole) render edilir.
  return user?.apartmentId ?? '';
}

export function useUnits() {
  const apartmentId = useApartmentId();
  const { canReadUnits } = useUnitPermissions();
  return useQuery({
    queryKey: unitKeys.units(apartmentId),
    queryFn: ({ signal }) => unitsApi.listUnits(apartmentId, signal),
    enabled: !!apartmentId && canReadUnits,
  });
}

export function useBlocks() {
  const apartmentId = useApartmentId();
  const { canReadUnits } = useUnitPermissions();
  return useQuery({
    queryKey: unitKeys.blocks(apartmentId),
    queryFn: ({ signal }) => unitsApi.listBlocks(apartmentId, signal).then((r) => r.items),
    enabled: !!apartmentId && canReadUnits,
    staleTime: 5 * 60_000,
  });
}

export function useCurrentMemberships() {
  const apartmentId = useApartmentId();
  const { canReadResidents } = useUnitPermissions();
  return useQuery({
    queryKey: unitKeys.memberships(apartmentId),
    queryFn: ({ signal }) => unitsApi.listCurrentMemberships(signal).then((r) => r.items),
    enabled: !!apartmentId && canReadResidents,
  });
}

export function usePeople() {
  const apartmentId = useApartmentId();
  const { canReadResidents } = useUnitPermissions();
  return useQuery({
    queryKey: unitKeys.people(apartmentId),
    queryFn: ({ signal }) => unitsApi.listPeople(signal).then((r) => r.items),
    enabled: !!apartmentId && canReadResidents,
  });
}

/**
 * Daire ekler. `newBlockName` verilirse once blok olusturulur (ilk daire senaryosu).
 * Basarida daire listesi (+ gerekiyorsa blok listesi) gecersiz kilinir.
 */
export function useCreateUnit() {
  const apartmentId = useApartmentId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ newBlockName, ...input }: Omit<CreateUnitInput, 'blockId'> & { blockId?: string; newBlockName?: string }) => {
      let blockId = input.blockId;
      if (newBlockName) {
        const block = await unitsApi.createBlock(apartmentId, newBlockName);
        // Daire adimi basarisiz olsa bile blok olustu: listede hemen gorunsun.
        await queryClient.invalidateQueries({ queryKey: unitKeys.blocks(apartmentId) });
        blockId = block.blockId;
      }
      if (!blockId) throw new Error('Blok seçilmedi');
      return unitsApi.createUnit(apartmentId, { ...input, blockId });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: unitKeys.units(apartmentId) }),
  });
}

/** Dairenin gider kalemi muafiyetlerini yazar (iyimser kilit: `version`); liste yenilenir. */
export function useUpdateUnitExemptions() {
  const apartmentId = useApartmentId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { unitId: string; version: number; exemptions: UnitExemption[] }) =>
      unitsApi.updateUnitExemptions(apartmentId, input.unitId, { version: input.version, exemptions: input.exemptions }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: unitKeys.apartment(apartmentId) }),
  });
}

/** Sakin/malik davet eder; uyelik ve kisi listeleri yenilenir. */
export function useInviteResident() {
  const apartmentId = useApartmentId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteResidentInput) => unitsApi.inviteResident(input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: unitKeys.memberships(apartmentId) }),
        queryClient.invalidateQueries({ queryKey: unitKeys.people(apartmentId) }),
      ]),
  });
}
