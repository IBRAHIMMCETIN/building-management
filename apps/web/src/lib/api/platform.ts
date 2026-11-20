import { z } from 'zod';
import { apiClient } from './client';

/*
 * Platform ekibi (yalnizca platform_admin):
 *   GET /api/admin/apartments   tum apartmanlarin dizini (ad, tur, il/ilce, durum)
 * Apartman ici veri (daire, kisi, finans) platform rolune acik degildir.
 */

export const SITE_TYPE_LABELS = { apartment: 'Apartman', site: 'Site', residence: 'Rezidans' } as const;

export const platformSiteSchema = z.object({
  siteId: z.string(),
  tenantId: z.string(),
  name: z.string(),
  type: z.enum(['apartment', 'site', 'residence']),
  city: z.string(),
  district: z.string(),
  status: z.enum(['active', 'inactive']),
  createdAt: z.string(),
});
export type PlatformSite = z.infer<typeof platformSiteSchema>;

const directorySchema = z.object({ items: z.array(platformSiteSchema) });

export const platformApi = {
  apartments: (signal?: AbortSignal) => apiClient.get('/api/admin/apartments', { signal, schema: directorySchema }),
};

/** Ad, il veya ilceye gore arama (Turkce buyuk/kucuk harf duyarsiz). */
export function matchesSiteQuery(site: Pick<PlatformSite, 'name' | 'city' | 'district'>, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('tr');
  if (!q) return true;
  return `${site.name} ${site.district} ${site.city}`.toLocaleLowerCase('tr').includes(q);
}
