import type { PayableOption, PayableSuggestion } from '@/lib/api/bank';

/*
 * Faz B3.5 - Cikan banka satiriyla tedarikci borcu kapatma (saf yardimcilar).
 * Fazla odeme API'de reddedilir (fatura oncesi odeme Tedarikciler sekmesinden avans olarak
 * kaydedilir); burada da erkenden gosterilir.
 */

/** Diyalogda varsayilan tedarikci: guveni en az 0.5 olan ilk oneri, yoksa bos. */
export function preselectPayable(suggestions: readonly PayableSuggestion[], payables: readonly Pick<PayableOption, 'accountId'>[]): string {
  const top = suggestions[0];
  if (!top || top.confidence < 0.5) return '';
  return payables.some((p) => p.accountId === top.payableAccountId) ? top.payableAccountId : '';
}

/** Secili tedarikci icin dogrulama. */
export function settleState(lineAmount: number, payable: Pick<PayableOption, 'openBalance'> | undefined): { valid: boolean; error?: string; remaining?: number } {
  if (!payable) return { valid: false, error: 'Tedarikçi seçin' };
  if (payable.openBalance <= 0) return { valid: false, error: 'Bu tedarikçinin açık borcu yok' };
  if (lineAmount > payable.openBalance) {
    return { valid: false, error: 'Ödeme, tedarikçinin açık borcunu aşıyor. Fatura öncesi ödemeyi Tedarikçiler sekmesinden avans olarak kaydedin veya borç kaydını kontrol edin.' };
  }
  return { valid: true, remaining: payable.openBalance - lineAmount };
}

/** Acik borca gore siralama (onerilen basta). */
export function sortPayables<T extends Pick<PayableOption, 'accountId' | 'openBalance' | 'name'>>(payables: readonly T[], suggestedId?: string): T[] {
  return [...payables].sort(
    (a, b) =>
      Number(b.accountId === suggestedId) - Number(a.accountId === suggestedId) || b.openBalance - a.openBalance || a.name.localeCompare(b.name, 'tr'),
  );
}

/** Elle tedarikci odemesi formu (Finans > Tedarikciler). */
export function payablePaymentState(input: { amount: number | null; openBalance: number; fundsAccountId: string; date: string }): { valid: boolean; error?: string } {
  if (!input.fundsAccountId) return { valid: false, error: 'Ödemenin çıkacağı kasa/banka hesabını seçin' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { valid: false, error: 'Tarih seçin' };
  if (input.amount === null || !Number.isSafeInteger(input.amount) || input.amount < 1) return { valid: false, error: 'Geçerli bir tutar girin' };
  if (input.amount > input.openBalance) return { valid: false, error: 'Tutar açık borcu aşamaz' };
  return { valid: true };
}
