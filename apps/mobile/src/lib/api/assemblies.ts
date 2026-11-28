import { portalAssemblySchema } from '@bm/shared/api/assemblies';
import { signedDownloadSchema } from '@bm/shared/api/documents';
import { z } from 'zod';
import type { ApiClient } from './createApiClient';

/*
 * Sakin genel kurul (web karsiligi: apps/web/src/lib/api/assemblies.ts -> portalList / portalGet /
 * portalMinutes). Yalnizca bugun apartmanda aktif MALIK uyeligi olan sakin; kiraci 403.
 *   GET /api/portal/assemblies              cagrisi gonderilmis veya tutanagi kesinlesmis toplantilar
 *   GET /api/portal/assemblies/:id          gundem, gerekli cogunluk; kesinlesince yeter sayi ve kararlar
 *   GET /api/portal/assemblies/:id/minutes  kesinlesmis tutanak PDF (5 dk imzali link)
 */

const P = '/api/portal/assemblies';
const enc = encodeURIComponent;

export const assembliesApi = {
  list: (api: ApiClient, signal?: AbortSignal) => api.get(P, { signal, schema: z.object({ items: z.array(portalAssemblySchema) }) }),
  get: (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`${P}/${enc(id)}`, { signal, schema: portalAssemblySchema }),
  minutes: (api: ApiClient, id: string) => api.get(`${P}/${enc(id)}/minutes`, { schema: signedDownloadSchema }),
};
