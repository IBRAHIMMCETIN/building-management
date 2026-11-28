/**
 * Finans 2.2 sonrasi - tedarikci avansi: saf form kurallari ve etiketler (API ile ayni sinirlar;
 * nihai dogrulama API'dedir).
 */
import type { StatementCategory, SupplierAdvance, SupplierOpenItem } from '@/lib/api/supplierAdvances';
import { formatTRY } from '@/lib/money';
import { reasonError } from '@/lib/restructure/model';

export const ADVANCE_STATUS_LABELS: Record<SupplierAdvance['status'], string> = {
  open: 'Açık',
  applied: 'Mahsup edildi',
  reversed: 'İptal edildi',
};

export const ADVANCE_STATUS_TONES: Record<SupplierAdvance['status'], 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  applied: 'success',
  reversed: 'neutral',
};

export const STATEMENT_CATEGORY_LABELS: Record<StatementCategory, string> = {
  invoice: 'Fatura',
  payment: 'Ödeme',
  advance: 'Avans',
  advance_offset: 'Avans mahsubu',
  reversal: 'Ters kayıt',
  other: 'Diğer',
};

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Avans formu: kasa/banka secili, tarih bugun veya once, tutar > 0 ve hesap bakiyesini asmaz. */
export function advanceFormState(input: { amount: number | null; fundsAccountId: string; fundsBalance: number | undefined; date: string; today: string }): { valid: boolean; error?: string } {
  if (!input.fundsAccountId) return { valid: false, error: 'Ödemenin çıkacağı kasa/banka hesabını seçin' };
  if (!isDate(input.date)) return { valid: false, error: 'Tarih seçin' };
  if (input.date > input.today) return { valid: false, error: 'Avans tarihi bugünden sonra olamaz' };
  if (input.amount === null || !Number.isSafeInteger(input.amount) || input.amount < 1) return { valid: false, error: 'Geçerli bir tutar girin' };
  if (input.fundsBalance !== undefined && input.amount > input.fundsBalance) return { valid: false, error: `Hesap bakiyesi yetersiz (${formatTRY(input.fundsBalance)})` };
  return { valid: true };
}

export type AdvanceOffsetDraft = {
  /** Fatura secilmediyse kullanilan tutar (kurus; gecersiz girdi null): FIFO ile en eski faturalar kapanir. */
  amount: number | null;
  /** Secilen faturalar (sirayla, acik kalanlari kadar; son fatura kalan avansla kismi kapanabilir). */
  selected: string[];
  items: readonly SupplierOpenItem[];
  /** min(acik avans, acik borc). */
  maxAmount: number;
  advanceDate: string;
  date: string;
  today: string;
  reason: string;
};

export type AdvanceOffsetFormState = {
  valid: boolean;
  amount: number;
  settles?: { transactionId: string; amount: number }[];
  errors: { amount?: string; date?: string; reason?: string };
};

/** FIFO: `amount` tutarini karsilayan en eski acik faturalar (API ile ayni sira). */
export function fifoTargets(items: readonly SupplierOpenItem[], amount: number): SupplierOpenItem[] {
  const out: SupplierOpenItem[] = [];
  let left = amount;
  for (const i of items) {
    if (left <= 0) break;
    out.push(i);
    left -= i.open;
  }
  return out;
}

export function advanceOffsetFormState(d: AdvanceOffsetDraft): AdvanceOffsetFormState {
  const errors: AdvanceOffsetFormState['errors'] = {};
  const chosen = d.items.filter((i) => d.selected.includes(i.transactionId));
  let settles: { transactionId: string; amount: number }[] | undefined;
  if (chosen.length > 0) {
    settles = [];
    let left = d.maxAmount;
    for (const i of chosen) {
      if (left <= 0) break;
      const take = Math.min(i.open, left);
      settles.push({ transactionId: i.transactionId, amount: take });
      left -= take;
    }
  }
  const amount = settles ? settles.reduce((s, x) => s + x.amount, 0) : (d.amount ?? 0);
  if (d.maxAmount < 1) errors.amount = 'Açık avans veya açık fatura yok';
  else if (!settles && d.amount === null) errors.amount = 'Geçerli bir tutar girin';
  else if (amount < 1) errors.amount = 'Tutar sıfırdan büyük olmalı';
  else if (amount > d.maxAmount) errors.amount = `Tutar en fazla ${formatTRY(d.maxAmount)} olabilir (açık avans / açık borç)`;
  if (!isDate(d.date)) errors.date = 'Tarih seçin';
  else if (d.date > d.today) errors.date = 'Mahsup tarihi bugünden sonra olamaz';
  else if (d.date < d.advanceDate) errors.date = 'Mahsup tarihi avans tarihinden önce olamaz';
  else {
    // Kapanacak faturalar: secilenler veya (FIFO) tutari karsilayan en eski faturalar.
    const targets = settles ? chosen.filter((i) => settles?.some((s) => s.transactionId === i.transactionId)) : fifoTargets(d.items, amount);
    const latest = targets.reduce<string | undefined>((m, i) => (!m || i.date > m ? i.date : m), undefined);
    if (latest && d.date < latest) errors.date = 'Mahsup tarihi mahsup edilen faturanın tarihinden önce olamaz';
  }
  const reason = reasonError(d.reason);
  if (reason) errors.reason = reason;
  return { valid: Object.keys(errors).length === 0, amount, ...(settles ? { settles } : {}), errors };
}
