import { expenseBreakdownSchema, myPaymentReferenceSchema, myReceiptsSchema, myStatementSchema, mySummarySchema } from '@bm/shared/api/portal';
import { apiClient } from './client';

/*
 * Sakin portali (apps/api/src/modules/portal). Semalar ve saf yardimcilar
 * packages/shared/src/api/portal.ts'te (web + mobil ortak); burada yalnizca uclar.
 *   GET /api/portal/my-summary | /my-statement?from&to | /my-payment-reference | /my-receipts
 *   GET /api/portal/expense-breakdown?month=YYYY-AA   (Adim 3; `resident.expenseChart`)
 */
export * from '@bm/shared/api/portal';

const unitQuery = (unitId?: string) => (unitId ? { unitId } : undefined);

export const portalApi = {
  mySummary: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-summary', { signal, query: unitQuery(unitId), schema: mySummarySchema }),
  myStatement: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-statement', { signal, query: unitQuery(unitId), schema: myStatementSchema }),
  myPaymentReference: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-payment-reference', { signal, query: unitQuery(unitId), schema: myPaymentReferenceSchema }),
  myReceipts: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-receipts', { signal, query: unitQuery(unitId), schema: myReceiptsSchema }),
  expenseBreakdown: (month: string, signal?: AbortSignal) =>
    apiClient.get('/api/portal/expense-breakdown', { signal, query: { month }, schema: expenseBreakdownSchema }),
};
