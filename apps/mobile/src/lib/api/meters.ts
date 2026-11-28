import { signedDownloadSchema } from '@bm/shared/api/documents';
import { consumptionSchema } from '@bm/shared/api/meters';
import type { ApiClient } from './createApiClient';

/*
 * Sakin tuketimi (web karsiligi: apps/web/src/lib/api/meters.ts -> myConsumption / myStatement).
 *   GET /api/portal/meters/consumption?unitId=          donemler, bina / blok ortalamasi
 *   GET /api/portal/meters/statement/:periodId?unitId=  Sayac Dagitim Dokumu PDF (5 dk imzali link)
 * Web'deki gibi `unitId` her zaman gonderilir (secili daire, yoksa ozetteki daire).
 */

const P = '/api/portal/meters';
const enc = encodeURIComponent;

export const metersApi = {
  consumption: (api: ApiClient, unitId: string, signal?: AbortSignal) => api.get(`${P}/consumption`, { signal, query: { unitId }, schema: consumptionSchema }),
  statement: (api: ApiClient, periodId: string, unitId: string) => api.get(`${P}/statement/${enc(periodId)}`, { query: { unitId }, schema: signedDownloadSchema }),
};
