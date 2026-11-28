/**
 * Abonelik ekranlarinin saf yardimcilari (platform sayfalari, Ayarlar > Abonelik, ust bant).
 * API: apps/api/src/modules/subscriptions.
 */
import type {
  BillingPeriod,
  InvoicePaymentMethod,
  Plan,
  PlanFeature,
  PlanInput,
  PlanPricing,
  PricingModel,
  SubscriptionAction,
  SubscriptionInvoiceStatus,
  SubscriptionListStatus,
  SubscriptionStatusView,
} from '@/lib/api/subscriptions';
import { PLAN_FEATURES } from '@/lib/api/subscriptions';
import { FEATURE_LABELS as CATALOG_LABELS } from '@/lib/features/catalog';
import { formatDate } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';

type Tone = 'neutral' | 'success' | 'warning' | 'accent' | 'danger';

export const STATUS_LABELS: Record<SubscriptionListStatus, string> = {
  legacy: 'Abonelik öncesi',
  trial: 'Deneme',
  active: 'Aktif',
  past_due: 'Ödemesi gecikmiş',
  suspended: 'Askıda',
  cancelled: 'Sona erdi',
};

export const STATUS_TONES: Record<SubscriptionListStatus, Tone> = {
  legacy: 'neutral',
  trial: 'accent',
  active: 'success',
  past_due: 'warning',
  suspended: 'danger',
  cancelled: 'danger',
};

export const PLAN_STATUS_LABELS: Record<'active' | 'archived', string> = { active: 'Aktif', archived: 'Arşiv' };
export const PLAN_STATUS_TONES: Record<'active' | 'archived', Tone> = { active: 'success', archived: 'neutral' };

export const INVOICE_STATUS_LABELS: Record<SubscriptionInvoiceStatus, string> = { issued: 'Ödeme bekliyor', paid: 'Ödendi', void: 'İptal' };
export const INVOICE_STATUS_TONES: Record<SubscriptionInvoiceStatus, Tone> = { issued: 'warning', paid: 'success', void: 'neutral' };

export const PERIOD_LABELS: Record<BillingPeriod, string> = { monthly: 'Aylık', annual: 'Yıllık' };
export const MODEL_LABELS: Record<PricingModel, string> = { flat: 'Sabit bedel', per_unit: 'Bölüm başı', tiered: 'Kademeli' };
export const METHOD_LABELS: Record<InvoicePaymentMethod, string> = { bank_transfer: 'Havale / EFT', cash: 'Nakit', online: 'Online ödeme', other: 'Diğer' };

/** Plan modulu etiketleri: Adim 1 katalogunun etiketleri (tek kaynak). */
export const FEATURE_LABELS: Record<PlanFeature, string> = CATALOG_LABELS;

export const ACTION_LABELS: Record<SubscriptionAction, string> = {
  extend_trial: 'Denemeyi uzat',
  activate: 'Denemeyi bitir, ilk dönemi başlat',
  suspend: 'Askıya al (salt okunur)',
  cancel: 'Sona erdir',
  reactivate: 'Yeniden aç',
};

/** API ile ayni: hangi durumda hangi islem (apps/api/.../machine.ts ACTION_ALLOWED_FROM). */
const ALLOWED: Record<SubscriptionAction, readonly SubscriptionListStatus[]> = {
  extend_trial: ['trial'],
  activate: ['trial'],
  suspend: ['trial', 'active', 'past_due'],
  cancel: ['trial', 'active', 'past_due', 'suspended'],
  reactivate: ['suspended', 'cancelled'],
};

export const actionsFor = (status: SubscriptionListStatus): SubscriptionAction[] =>
  (Object.keys(ALLOWED) as SubscriptionAction[]).filter((a) => ALLOWED[a].includes(status));

/** "%20" (baz puan). */
export const vatText = (bps: number) => `%${(bps / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;

/** Fiyat ozeti (KDV haric): "250,00 ₺ + bölüm başı 12,00 ₺ / ay". */
export function priceSummary(p: PlanPricing, period: BillingPeriod = 'monthly'): string {
  const annual = period === 'annual';
  const suffix = annual ? '/ yıl' : '/ ay';
  if (p.model === 'tiered') {
    const tiers = p.tiers ?? [];
    if (tiers.length === 0) return '—';
    const first = tiers[0]!;
    return `${formatTRY(annual ? first.annualKurus : first.monthlyKurus)} ${suffix}’dan başlayan ${tiers.length} kademe`;
  }
  const base = annual ? p.annualKurus : p.monthlyKurus;
  const per = annual ? p.perUnitAnnualKurus : p.perUnitMonthlyKurus;
  if (p.model === 'per_unit') {
    const perText = `bölüm başı ${formatTRY(per ?? 0)}`;
    return base > 0 ? `${formatTRY(base)} + ${perText} ${suffix}` : `${perText} ${suffix}`;
  }
  return base > 0 ? `${formatTRY(base)} ${suffix}` : 'Ücretsiz';
}

export const includedFeatures = (features: Record<string, boolean>) => PLAN_FEATURES.filter((f) => features[f] === true);

/** "12 / 100" veya "12 (sınırsız)". */
export const usageText = (used: number, max: number | null) => (max === null ? `${used} (sınırsız)` : `${used} / ${max}`);

// ---------------------------------------------------------------------------
// Ust bant
// ---------------------------------------------------------------------------

export type BannerState =
  | { tone: 'neutral'; title: string; text: string }
  | { tone: 'warning'; title: string; text: string }
  | { tone: 'danger'; title: string; text: string };

/** Denemenin son 7 gunu, gecikme ve salt okunur durumlar; digerlerinde bant yok. */
export function bannerFor(s: SubscriptionStatusView | undefined): BannerState | null {
  if (!s || s.legacy) return null;
  if (s.status === 'trial' && s.daysLeft !== undefined && s.daysLeft <= 7) {
    const when = s.daysLeft <= 0 ? 'bugün' : s.daysLeft === 1 ? 'yarın' : `${s.daysLeft} gün sonra`;
    return { tone: 'neutral', title: 'Deneme süreniz bitiyor:', text: `${when}${s.trialEndsAt ? ` (${formatDate(s.trialEndsAt)})` : ''}. Bitince ilk dönem faturası kesilir.` };
  }
  if (s.status === 'past_due') {
    return {
      tone: 'warning',
      title: 'Abonelik ödemeniz gecikti.',
      text: s.suspendOn ? `Ödeme alınmazsa hesap ${formatDate(s.suspendOn)} tarihinde salt okunur olur.` : 'Ödeme alınmazsa hesap salt okunur olur.',
    };
  }
  if (s.status === 'suspended' || s.status === 'cancelled') {
    return {
      tone: 'danger',
      title: s.status === 'suspended' ? 'Aboneliğiniz askıda; hesap salt okunur.' : 'Aboneliğiniz sona erdi; hesap salt okunur.',
      text: 'Kayıtları görüntüleyebilir ve dışa aktarabilirsiniz; sakinlerin ödemeleri alınmaya devam eder.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan formu (tutarlar metin olarak; kuruşa kayan nokta olmadan cevrilir)
// ---------------------------------------------------------------------------

export type TierDraft = { maxUnits: string; monthly: string; annual: string };

export type PlanDraft = {
  code: string;
  name: string;
  description: string;
  model: PricingModel;
  monthly: string;
  annual: string;
  perUnitMonthly: string;
  perUnitAnnual: string;
  tiers: TierDraft[];
  vatPercent: string;
  features: Record<PlanFeature, boolean>;
  maxUnits: string;
  maxStaffUsers: string;
  trialDays: string;
};

const money = (k: number | undefined) => (k ? kurusToInput(k) : '0');

export function emptyPlanDraft(): PlanDraft {
  return {
    code: '',
    name: '',
    description: '',
    model: 'flat',
    monthly: '',
    annual: '',
    perUnitMonthly: '',
    perUnitAnnual: '',
    tiers: [{ maxUnits: '', monthly: '', annual: '' }],
    vatPercent: '20',
    features: Object.fromEntries(PLAN_FEATURES.map((f) => [f, false])) as Record<PlanFeature, boolean>,
    maxUnits: '',
    maxStaffUsers: '',
    trialDays: '30',
  };
}

export function draftFromPlan(p: Plan): PlanDraft {
  return {
    code: p.code,
    name: p.name,
    description: p.description ?? '',
    model: p.pricing.model,
    monthly: money(p.pricing.monthlyKurus),
    annual: money(p.pricing.annualKurus),
    perUnitMonthly: money(p.pricing.perUnitMonthlyKurus),
    perUnitAnnual: money(p.pricing.perUnitAnnualKurus),
    tiers: (p.pricing.tiers ?? []).map((t) => ({ maxUnits: t.maxUnits === null ? '' : String(t.maxUnits), monthly: money(t.monthlyKurus), annual: money(t.annualKurus) })),
    vatPercent: String(p.pricing.vatRateBps / 100).replace('.', ','),
    features: Object.fromEntries(PLAN_FEATURES.map((f) => [f, p.features[f] === true])) as Record<PlanFeature, boolean>,
    maxUnits: p.limits.maxUnits === null ? '' : String(p.limits.maxUnits),
    maxStaffUsers: p.limits.maxStaffUsers === null ? '' : String(p.limits.maxStaffUsers),
    trialDays: String(p.trialDays),
  };
}

export type PlanDraftErrors = Partial<Record<keyof PlanDraft | 'tiers', string>>;

const amount = (text: string): number | null => (text.trim() === '' ? 0 : parseTRYToKurus(text, { allowZero: true }));
const optionalInt = (text: string, max: number): number | null | undefined => {
  const t = text.trim();
  if (!t) return null;
  return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= max ? Number(t) : undefined;
};

/** Taslak -> API girdisi; hatali alanlar ayrica doner (hata varsa girdi yok). */
export function planInputFromDraft(d: PlanDraft): { input?: PlanInput & { code: string }; errors: PlanDraftErrors } {
  const errors: PlanDraftErrors = {};
  const code = d.code.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) errors.code = 'Kod 2-32 karakter: küçük harf, rakam, - ve _.';
  const name = d.name.trim();
  if (name.length < 2 || name.length > 80) errors.name = 'Ad 2-80 karakter olmalı.';
  const vat = /^\d{1,3}([.,]\d{1,2})?$/.test(d.vatPercent.trim()) ? Math.round(Number(d.vatPercent.trim().replace(',', '.')) * 100) : NaN;
  if (!Number.isInteger(vat) || vat < 0 || vat > 10_000) errors.vatPercent = 'KDV oranı 0-100 arası olmalı.';
  const trial = /^\d+$/.test(d.trialDays.trim()) ? Number(d.trialDays.trim()) : NaN;
  if (!Number.isInteger(trial) || trial < 0 || trial > 90) errors.trialDays = 'Deneme 0-90 gün olmalı.';
  const maxUnits = optionalInt(d.maxUnits, 100_000);
  if (maxUnits === undefined) errors.maxUnits = 'Boş (sınırsız) veya 1-100.000 arası tam sayı.';
  const maxStaffUsers = optionalInt(d.maxStaffUsers, 10_000);
  if (maxStaffUsers === undefined) errors.maxStaffUsers = 'Boş (sınırsız) veya 1-10.000 arası tam sayı.';

  const monthly = amount(d.monthly);
  const annual = amount(d.annual);
  if (d.model !== 'tiered') {
    if (monthly === null) errors.monthly = 'Geçerli bir tutar girin (ör. 250,00).';
    if (annual === null) errors.annual = 'Geçerli bir tutar girin (ör. 2.500,00).';
  }
  let pricing: PlanPricing | undefined;
  if (d.model === 'per_unit') {
    const pm = amount(d.perUnitMonthly);
    const pa = amount(d.perUnitAnnual);
    if (pm === null) errors.perUnitMonthly = 'Geçerli bir tutar girin.';
    if (pa === null) errors.perUnitAnnual = 'Geçerli bir tutar girin.';
    if (pm !== null && pa !== null && monthly !== null && annual !== null) {
      pricing = { model: 'per_unit', monthlyKurus: monthly, annualKurus: annual, perUnitMonthlyKurus: pm, perUnitAnnualKurus: pa, vatRateBps: vat };
    }
  } else if (d.model === 'tiered') {
    const tiers = d.tiers.map((t, i) => ({
      maxUnits: i === d.tiers.length - 1 && t.maxUnits.trim() === '' ? null : optionalInt(t.maxUnits, 100_000),
      monthlyKurus: amount(t.monthly),
      annualKurus: amount(t.annual),
    }));
    const bad = tiers.some((t, i) => t.monthlyKurus === null || t.annualKurus === null || t.maxUnits === undefined || (t.maxUnits === null && i !== tiers.length - 1));
    const ascending = tiers.every((t, i) => i === 0 || t.maxUnits === null || t.maxUnits === undefined || (tiers[i - 1]!.maxUnits ?? Infinity) < t.maxUnits);
    if (tiers.length === 0 || bad || !ascending) {
      errors.tiers = 'Her kademede tutarları girin; bölüm sınırları artan olmalı, yalnızca son kademe boş (sınırsız) olabilir.';
    } else {
      pricing = { model: 'tiered', monthlyKurus: 0, annualKurus: 0, vatRateBps: vat, tiers: tiers as { maxUnits: number | null; monthlyKurus: number; annualKurus: number }[] };
    }
  } else if (monthly !== null && annual !== null) {
    pricing = { model: 'flat', monthlyKurus: monthly, annualKurus: annual, vatRateBps: vat };
  }
  if (Object.keys(errors).length > 0 || !pricing) return { errors };
  return {
    input: {
      code,
      name,
      ...(d.description.trim() ? { description: d.description.trim() } : {}),
      pricing,
      features: d.features,
      limits: { maxUnits: maxUnits ?? null, maxStaffUsers: maxStaffUsers ?? null },
      trialDays: trial,
    },
    errors,
  };
}
