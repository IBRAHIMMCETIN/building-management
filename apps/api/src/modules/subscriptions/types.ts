import { skKey, tenantPk } from '../../config/dynamodb.js';
import type { IsoDate, IsoDateTime, TableKeys } from '../core/types.js';

/**
 * Abonelik / lisans (platform <-> apartman yonetimi). Online odemedeki platform komisyon
 * faturasindan (modules/payments/invoices.ts, `PLATFORM_INVOICE`) AYRI bir kayit ailesidir:
 * burada apartman yonetimi platformun kullanim bedelini oder.
 *
 * Kayit duzeni (tek tablo; silme yok, durum alanlari):
 *   Plan basi       PK = `PLAN#<code>`, SK = `PLAN`             GSI1PK = `PLAN_CATALOG`, GSI1SK = `<code>`
 *   Plan surumu     PK = `PLAN#<code>`, SK = `VERSION#<000001>` (degismez; her duzenleme yeni surum)
 *   Abonelik        PK = `APT#<apt>`,   SK = `SUBSCRIPTION`      GSI1PK = `SUBSCRIPTIONS`, GSI1SK = `<status>#<apt>`
 *   Fatura          PK = `APT#<apt>`,   SK = `SUBINV#<donemBasi>` GSI1PK = `SUBSCRIPTION_INVOICES`, GSI1SK = `<issueDate>#<apt>#<donemBasi>`
 *   Numara serisi   PK = `COUNTER#SUBINV`, SK = `<yil>` (`seq`; kosullu artirim, bosluksuz seri)
 *
 * Abonelik kaydi olmayan apartman `legacy` (Abonelik oncesi acilmis; tum ozellikler acik, limit yok).
 */

// ---------------------------------------------------------------------------
// Plan ozellikleri (modul anahtarlari)
// ---------------------------------------------------------------------------

export const PLAN_FEATURES = [
  'online_payment',
  'gate',
  'reservations',
  'polls_assemblies',
  'tenders',
  'equipment',
  'portfolio',
  'mobile_push',
  'bulk_jobs',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  online_payment: 'Online aidat ödemesi',
  gate: 'Güvenlik kapısı (QR, plaka, kurye)',
  reservations: 'Ortak alan rezervasyonu',
  polls_assemblies: 'Anket, oylama ve genel kurul',
  tenders: 'İhale / teklif toplama',
  equipment: 'Ekipman sicili',
  portfolio: 'Yönetim firması portföyü',
  mobile_push: 'Mobil bildirim (push)',
  bulk_jobs: 'Arka plan toplu işleri',
};

export type PlanFeatures = Record<PlanFeature, boolean>;

export const isPlanFeature = (v: unknown): v is PlanFeature => typeof v === 'string' && (PLAN_FEATURES as readonly string[]).includes(v);

/** Tum ozellikler acik (legacy abonelik ve sinirsiz planlar). */
export const allFeatures = (): PlanFeatures => Object.fromEntries(PLAN_FEATURES.map((f) => [f, true])) as PlanFeatures;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const PRICING_MODELS = ['flat', 'per_unit', 'tiered'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export type PriceTier = {
  /** Bu kademenin ust siniri (bolum); null = sinirsiz (son kademe). */
  maxUnits: number | null;
  monthlyKurus: number;
  annualKurus: number;
};

/**
 * Fiyatlar KDV HARIC kurus. `flat`: sabit bedel; `per_unit`: sabit bedel + bolum basi bedel x
 * bolum sayisi (donem basindaki anlik goruntu); `tiered`: bolum sayisinin girdigi ilk kademe.
 */
export type PlanPricing = {
  model: PricingModel;
  monthlyKurus: number;
  annualKurus: number;
  perUnitMonthlyKurus?: number;
  perUnitAnnualKurus?: number;
  tiers?: PriceTier[];
  /** KDV orani, baz puan (2000 = %20). */
  vatRateBps: number;
};

export type PlanLimits = {
  /** Aktif bagimsiz bolum siniri; null = sinirsiz. */
  maxUnits: number | null;
  /** Aktif ekip kullanicisi (yonetici, firma, denetci, gorevli, guvenlik) siniri; null = sinirsiz. */
  maxStaffUsers: number | null;
};

export const PLAN_STATUSES = ['active', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Planin icerigi (surumle birlikte degismez). */
export type PlanContent = {
  code: string;
  name: string;
  description?: string;
  pricing: PlanPricing;
  features: PlanFeatures;
  limits: PlanLimits;
  /** Deneme suresi (gun); 0 = deneme yok. */
  trialDays: number;
  /** true: ornek / yer tutucu plan (fiyatlar is karari degil). */
  placeholder?: boolean;
};

export type PlanVersion = TableKeys &
  PlanContent & {
    entityType: 'PLAN_VERSION';
    planVersion: number;
    createdAt: IsoDateTime;
    createdBy: string;
    reason?: string;
  };

export type PlanHead = TableKeys &
  PlanContent & {
    entityType: 'PLAN';
    status: PlanStatus;
    /** Guncel icerik surumu (abonelikler anlik goruntu olarak saklar). */
    planVersion: number;
    idempotencyKey?: string;
    createdAt: IsoDateTime;
    createdBy: string;
    updatedAt: IsoDateTime;
    updatedBy: string;
    /** Kayit surumu (iyimser kilit). */
    version: number;
    GSI1PK: string;
    GSI1SK: string;
  };

export const PLAN_CATALOG_PK = 'PLAN_CATALOG';
export const PLAN_CODE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export const planKeys = {
  head: (code: string): TableKeys => ({ PK: `PLAN#${code}`, SK: 'PLAN' }),
  version: (code: string, v: number): TableKeys => ({ PK: `PLAN#${code}`, SK: `VERSION#${String(v).padStart(6, '0')}` }),
};

// ---------------------------------------------------------------------------
// Abonelik
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** Salt okunur durumlar: yazimlar engellenir (temel islemler haric; bkz. entitlements.ts). */
export const READ_ONLY_STATUSES: readonly SubscriptionStatus[] = ['suspended', 'cancelled'];

export const DEFAULT_TRIAL_DAYS = 30;
/** Vadesi gecmis faturada `past_due` -> `suspended` icin beklenen gun. */
export const DEFAULT_GRACE_DAYS = 14;
/** Fatura kesim gunu + odeme suresi = son odeme gunu. */
export const DEFAULT_PAYMENT_TERM_DAYS = 10;

/** Abonelikteki plan anlik goruntusu (plan sonradan degisse de bu abonelik bunu kullanir). */
export type PlanSnapshot = Pick<PlanContent, 'code' | 'name' | 'pricing' | 'features' | 'limits'> & { planVersion: number };

export type Subscription = TableKeys & {
  entityType: 'SUBSCRIPTION';
  apartmentId: string;
  status: SubscriptionStatus;
  plan: PlanSnapshot;
  billingPeriod: BillingPeriod;
  /** Deneme: baslangic ve son gun (dahil). */
  trialStartedAt?: IsoDate;
  trialEndsAt?: IsoDate;
  /** Donem tabani (ilk donem basi); donemler bundan ay/yil eklenerek kayma olmadan turetilir. */
  billingAnchor?: IsoDate;
  /** 0'dan baslayan donem sirasi. */
  periodIndex?: number;
  currentPeriodStart?: IsoDate;
  /** Donemin son gunu (dahil). */
  currentPeriodEnd?: IsoDate;
  /** Son donem basindaki aktif bolum sayisi (bolum basi fiyat ve kullanim). */
  unitCountSnapshot: number;
  graceDays: number;
  paymentTermDays: number;
  /** Gecikmenin tespit edildigi gun (`past_due` baslangici; ek sure buradan sayilir). */
  pastDueSince?: IsoDate;
  suspendedAt?: IsoDate;
  /** `non_payment`: odeme gelince kendiliginden acilir; `manual`: yalnizca platform acar. */
  suspendedReason?: 'non_payment' | 'manual';
  cancelledAt?: IsoDate;
  /** Deneme bitis bildirimleri (olay bir kez; deneme uzatilinca sifirlanir). */
  notices?: { trial7?: IsoDate; trial1?: IsoDate };
  lastRunOn?: IsoDate;
  statusChangedAt: IsoDateTime;
  idempotencyKey?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
  GSI1PK: string;
  GSI1SK: string;
};

export const SUBSCRIPTIONS_PK = 'SUBSCRIPTIONS';

export const subscriptionKeys = (apartmentId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: 'SUBSCRIPTION' });
export const subscriptionGsi = (status: SubscriptionStatus, apartmentId: string) => ({ GSI1PK: SUBSCRIPTIONS_PK, GSI1SK: `${status}#${apartmentId}` });

// ---------------------------------------------------------------------------
// Fatura
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = ['issued', 'paid', 'void'] as const;
export type SubscriptionInvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'online', 'other'] as const;
export type InvoicePaymentMethod = (typeof PAYMENT_METHODS)[number];

export type InvoiceLine = { description: string; quantity: number; unitPriceKurus: number; amountKurus: number };

export type SubscriptionInvoice = TableKeys & {
  entityType: 'SUBSCRIPTION_INVOICE';
  apartmentId: string;
  /** `<donemBasi>` (YYYY-MM-DD; apartman icinde tekil). */
  invoiceId: string;
  /** `YNS-<yil>-<000001>` (platform geneli bosluksuz seri). */
  invoiceNumber: string;
  siteName: string;
  status: SubscriptionInvoiceStatus;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  billingPeriod: BillingPeriod;
  planCode: string;
  planVersion: number;
  planName: string;
  unitCount: number;
  lines: InvoiceLine[];
  netKurus: number;
  vatRateBps: number;
  vatKurus: number;
  totalKurus: number;
  issueDate: IsoDate;
  dueDate: IsoDate;
  paidOn?: IsoDate;
  paymentReference?: string;
  paymentMethod?: InvoicePaymentMethod;
  paymentNote?: string;
  paidBy?: string;
  voidReason?: string;
  voidedBy?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
  GSI1PK: string;
  GSI1SK: string;
};

export const SUBSCRIPTION_INVOICES_PK = 'SUBSCRIPTION_INVOICES';
export const INVOICE_NUMBER_PREFIX = 'YNS';

export const invoiceKeys = (apartmentId: string, invoiceId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('SUBINV', invoiceId) });
export const invoiceGsi = (issueDate: IsoDate, apartmentId: string, invoiceId: string) => ({
  GSI1PK: SUBSCRIPTION_INVOICES_PK,
  GSI1SK: `${issueDate}#${apartmentId}#${invoiceId}`,
});
export const counterKeys = (year: string): TableKeys => ({ PK: 'COUNTER#SUBINV', SK: year });

export const formatInvoiceNumber = (year: string, seq: number) => `${INVOICE_NUMBER_PREFIX}-${year}-${String(seq).padStart(6, '0')}`;
