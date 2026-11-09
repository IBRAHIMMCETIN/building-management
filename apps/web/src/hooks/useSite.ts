import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type UpdateSiteSettingsInput, sitesApi } from '@/lib/api/sites';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { unitKeys } from './useUnits';

/** Ayarlar ekrani: okuma API ile ayni (yonetici/firma/denetci); bina gorevlisine gosterilmez. */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useSitePermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { apartmentId: user?.apartmentId ?? '', canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const siteKeys = {
  site: (apt: string) => [...unitKeys.apartment(apt), 'site'] as const,
};

export function useSite() {
  const { apartmentId, canRead } = useSitePermissions();
  return useQuery({
    queryKey: siteKeys.site(apartmentId),
    queryFn: ({ signal }) => sitesApi.get(apartmentId, signal),
    enabled: !!apartmentId && canRead,
  });
}

/**
 * Ayar degisikligi gecikme tazminati oranini da etkiler: apartmanin tum sorgulari (finans
 * ozetleri dahil) yenilenir. 409 (surum cakismasi) sonrasi guncel kayit da boylece gelir.
 */
export function useUpdateSiteSettings() {
  const { apartmentId } = useSitePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSiteSettingsInput) => sitesApi.updateSettings(apartmentId, input),
    onSuccess: (site) => queryClient.setQueryData(siteKeys.site(apartmentId), site),
    onSettled: () => queryClient.invalidateQueries({ queryKey: unitKeys.apartment(apartmentId) }),
  });
}
