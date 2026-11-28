/*
 * Ihale ekranlarinin saf yardimcilari. Tasindi: packages/shared/src/api/tenders.ts (web + mobil
 * ortak; KDV normalizasyonu API ile birebir ayni). Burada yalnizca yardimcilar yeniden disa aktarilir.
 */
export {
  TENDER_CATEGORY_LABELS,
  TENDER_STATUS_LABELS,
  TENDER_STATUS_TONES,
  VAT_RATES,
  allowedActions,
  canEditQuotes,
  comparisonColumns,
  deadlineText,
  formatBps,
  normalizeQuote,
  publishBlockers,
  termsSummary,
  warrantyText,
  type ComparisonColumn,
  type QuoteAmounts,
  type TenderAction,
} from '@bm/shared/api/tenders';
