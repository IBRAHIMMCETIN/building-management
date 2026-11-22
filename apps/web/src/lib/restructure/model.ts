/**
 * Finans 2.2 - avans mahsubu ve borc yapilandirma: saf form kurallari ve etiketler (API ile
 * ayni sinirlar; nihai dogrulama API'dedir).
 */
import type { OffsetRequestStatus, OpenItem, PlanDisplayStatus, PlanRule } from '@/lib/api/restructure';
import { formatTRY } from '@/lib/money';

export const MAX_INSTALLMENTS = 60;
export const DEFAULT_RULE: PlanRule = { consecutive: 2, total: 3, graceDays: 7, autoAccelerate: false };

export const PLAN_STATUS_LABELS: Record<PlanDisplayStatus, string> = {
  active: 'Aktif',
  accelerated: 'Muaccel',
  completed: 'Tamamlandı',
  cancelled: 'İptal edildi',
};

export const PLAN_STATUS_TONES: Record<PlanDisplayStatus, 'accent' | 'danger' | 'success' | 'neutral'> = {
  active: 'accent',
  accelerated: 'danger',
  completed: 'success',
  cancelled: 'neutral',
};

export const ACCELERATION_MODE_LABELS = { manual: 'Yönetici onayıyla muaccel', auto: 'Otomatik muaccel', pull_forward: 'Erken kapama' } as const;

export const OFFSET_REQUEST_STATUS_LABELS: Record<OffsetRequestStatus, string> = {
  pending: 'Onay bekliyor',
  approved: 'Onaylandı',
  rejected: 'Reddedildi',
};

export const OFFSET_REQUEST_STATUS_TONES: Record<OffsetRequestStatus, 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

/** Gerekce: API kurali (en az 5 karakter). */
export function reasonError(reason: string): string | undefined {
  return reason.trim().length < 5 ? 'Gerekçe en az 5 karakter olmalı' : undefined;
}

// ---------------------------------------------------------------------------
// Avans mahsubu
// ---------------------------------------------------------------------------

export type OffsetDraft = {
  /** Kurus; gecersiz girdi null. */
  amount: number | null;
  maxAmount: number;
  /** Kalem secimi (hedefli mahsup): secilen kalemlerin kalan tutarlari kapatilir. */
  selected: string[];
  items: readonly OpenItem[];
  consentRequired: boolean;
  consent: boolean;
  consentNote: string;
  reason: string;
};

export type OffsetFormState = {
  valid: boolean;
  /** Gonderilecek tutar (kalem secildiyse kalemlerin toplami). */
  amount: number;
  settles?: { chargeId: string; amount: number }[];
  errors: { amount?: string; consent?: string; reason?: string };
};

/** Mahsup formu: tutar <= serbest avans ve acik borc; farkli kisiye muvafakat + aciklama. */
export function offsetFormState(d: OffsetDraft): OffsetFormState {
  const errors: OffsetFormState['errors'] = {};
  const chosen = d.items.filter((i) => d.selected.includes(i.chargeId));
  const settles = chosen.length > 0 ? chosen.map((i) => ({ chargeId: i.chargeId, amount: i.remaining })) : undefined;
  const amount = settles ? settles.reduce((s, x) => s + x.amount, 0) : (d.amount ?? 0);
  if (d.maxAmount < 1) errors.amount = 'Kaynakta serbest avans veya hedefte açık borç yok';
  else if (!settles && d.amount === null) errors.amount = 'Geçerli bir tutar girin';
  else if (amount < 1) errors.amount = 'Tutar sıfırdan büyük olmalı';
  else if (amount > d.maxAmount) errors.amount = `Tutar en fazla ${formatTRY(d.maxAmount)} olabilir (serbest avans / açık borç)`;
  if (d.consentRequired) {
    if (!d.consent) errors.consent = 'Farklı kişiler arası mahsup için muvafakat beyanı gerekli';
    else if (d.consentNote.trim().length < 5) errors.consent = 'Muvafakat açıklaması en az 5 karakter olmalı';
  }
  const reason = reasonError(d.reason);
  if (reason) errors.reason = reason;
  return { valid: Object.keys(errors).length === 0, amount, ...(settles ? { settles } : {}), errors };
}

// ---------------------------------------------------------------------------
// Borc yapilandirma
// ---------------------------------------------------------------------------

/** `first` gununden `i` ay sonrasi; ay sonu kisa aya cekilir (API ile ayni). */
export function addMonths(first: string, i: number): string {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1 + i;
  const d = Number(first.slice(8, 10));
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Kurus kaybi olmadan esit bolme; artan kuruslar ilk taksitlere (API ile ayni). */
export function splitEven(total: number, n: number): number[] {
  if (n < 1) return [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export function ruleErrors(rule: PlanRule): Partial<Record<keyof PlanRule, string>> {
  const e: Partial<Record<keyof PlanRule, string>> = {};
  const int = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
  if (!int(rule.consecutive, 1, 12)) e.consecutive = '1-12 arası olmalı';
  if (!int(rule.total, 1, MAX_INSTALLMENTS)) e.total = `1-${MAX_INSTALLMENTS} arası olmalı`;
  else if (int(rule.consecutive, 1, 12) && rule.consecutive > rule.total) e.consecutive = 'Toplam eşikten büyük olamaz';
  if (!int(rule.graceDays, 0, 90)) e.graceDays = '0-90 gün arası olmalı';
  return e;
}

export type PlanDraft = {
  selected: string[];
  installments: number;
  firstDueDate: string;
  today: string;
  rule: PlanRule;
};

/** Taksit adimi hatalari (API sinirlari: 1-60 taksit, ilk vade bugun..12 ay). */
export function planDraftErrors(d: PlanDraft): { selected?: string; installments?: string; firstDueDate?: string; rule?: string } {
  const e: ReturnType<typeof planDraftErrors> = {};
  if (d.selected.length === 0) e.selected = 'En az bir kalem seçin';
  if (!Number.isInteger(d.installments) || d.installments < 1 || d.installments > MAX_INSTALLMENTS) e.installments = `Taksit sayısı 1-${MAX_INSTALLMENTS} arası olmalı`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.firstDueDate)) e.firstDueDate = 'İlk vade tarihini seçin';
  else if (d.firstDueDate < d.today) e.firstDueDate = 'İlk vade bugünden önce olamaz';
  else if (d.firstDueDate > addMonths(d.today, 12)) e.firstDueDate = 'İlk vade en fazla 12 ay sonra olabilir';
  if (Object.keys(ruleErrors(d.rule)).length > 0) e.rule = 'Muacceliyet eşiklerini kontrol edin';
  return e;
}

/** Varsayilan ilk vade: bir ay sonrasi. */
export const defaultFirstDueDate = (today: string) => addMonths(today, 1);

/** Taksit listesinde siradaki odenecek taksit ve geciken sayisi. */
export function installmentSummary(items: readonly { no: number; dueDate: string; remaining: number; overdue: boolean }[]) {
  const open = items.filter((i) => i.remaining > 0);
  return { next: open[0], overdueCount: open.filter((i) => i.overdue).length, openCount: open.length };
}

export function ruleText(rule: Pick<PlanRule, 'consecutive' | 'total' | 'graceDays'> & { autoAccelerate?: boolean }): string {
  const base = `${rule.consecutive} ardışık veya toplam ${rule.total} taksit, vadeden ${rule.graceDays} gün sonra hâlâ ödenmemişse plan muaccel olabilir`;
  return rule.autoAccelerate === undefined ? base : `${base} (${rule.autoAccelerate ? 'otomatik' : 'yönetici onayıyla'})`;
}
