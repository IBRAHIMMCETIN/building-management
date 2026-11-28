import { type Obj, ValidationError, asObject, optString, reqEnum, reqString } from '../core/validation.js';
import {
  DEFAULT_TRIAL_DAYS,
  PLAN_CODE,
  PLAN_FEATURES,
  PRICING_MODELS,
  type PlanContent,
  type PlanFeatures,
  type PlanLimits,
  type PlanPricing,
  type PriceTier,
  allFeatures,
} from './types.js';

/** Plan icerigi dogrulamasi (olusturma ve yeni surum). */

const MAX_KURUS = 100_000_000_000; // 1 milyar TL
const DEFAULT_VAT_BPS = 2000;

function kurus(o: Obj, key: string, required = true): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${key} zorunludur (kuruş, tam sayı)`, key);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_KURUS) throw new ValidationError(`${key} 0 veya pozitif tam sayı (kuruş) olmalıdır`, key);
  return v;
}

function limit(o: Obj, key: string, max: number): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) throw new ValidationError(`${key} 1-${max} arası tam sayı veya boş (sınırsız) olmalıdır`, key);
  return v;
}

function parseTiers(raw: unknown): PriceTier[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) throw new ValidationError('Kademeli fiyatta 1-10 kademe girilmelidir', 'pricing.tiers');
  const tiers = raw.map((t, i) => {
    const o = asObject(t, `pricing.tiers[${i}]`);
    return { maxUnits: limit(o, 'maxUnits', 100_000), monthlyKurus: kurus(o, 'monthlyKurus') as number, annualKurus: kurus(o, 'annualKurus') as number };
  });
  tiers.forEach((t, i) => {
    if (t.maxUnits === null && i !== tiers.length - 1) throw new ValidationError('Sınırsız kademe yalnızca sonuncusu olabilir', 'pricing.tiers');
    const prev = tiers[i - 1];
    if (prev && t.maxUnits !== null && prev.maxUnits !== null && t.maxUnits <= prev.maxUnits) {
      throw new ValidationError('Kademelerin bölüm sınırları artan sırada olmalıdır', 'pricing.tiers');
    }
  });
  return tiers;
}

export function parsePricing(raw: unknown): PlanPricing {
  const o = asObject(raw, 'pricing');
  const model = reqEnum(o, 'model', PRICING_MODELS);
  const vat = o.vatRateBps === undefined ? DEFAULT_VAT_BPS : o.vatRateBps;
  if (typeof vat !== 'number' || !Number.isSafeInteger(vat) || vat < 0 || vat > 10_000) throw new ValidationError('vatRateBps 0-10000 (baz puan; 2000 = %20) olmalıdır', 'pricing.vatRateBps');
  const pricing: PlanPricing = {
    model,
    monthlyKurus: kurus(o, 'monthlyKurus', model !== 'tiered') ?? 0,
    annualKurus: kurus(o, 'annualKurus', model !== 'tiered') ?? 0,
    vatRateBps: vat,
  };
  if (model === 'per_unit') {
    pricing.perUnitMonthlyKurus = kurus(o, 'perUnitMonthlyKurus') as number;
    pricing.perUnitAnnualKurus = kurus(o, 'perUnitAnnualKurus') as number;
  }
  if (model === 'tiered') pricing.tiers = parseTiers(o.tiers);
  return pricing;
}

export function parseFeatures(raw: unknown): PlanFeatures {
  const o = raw === undefined ? {} : asObject(raw, 'features');
  for (const k of Object.keys(o)) {
    if (!(PLAN_FEATURES as readonly string[]).includes(k)) throw new ValidationError(`Bilinmeyen plan özelliği: ${k}`, 'features');
    if (typeof o[k] !== 'boolean') throw new ValidationError(`${k} için true/false gerekli`, 'features');
  }
  return Object.fromEntries(PLAN_FEATURES.map((f) => [f, o[f] === true])) as PlanFeatures;
}

export function parseLimits(raw: unknown): PlanLimits {
  const o = raw === undefined ? {} : asObject(raw, 'limits');
  return { maxUnits: limit(o, 'maxUnits', 100_000), maxStaffUsers: limit(o, 'maxStaffUsers', 10_000) };
}

/** `code` yalnizca olusturmada okunur; surumde mevcut kod korunur. */
export function parsePlanContent(input: unknown, code?: string): PlanContent {
  const o = asObject(input);
  const planCode = code ?? reqString(o, 'code', 32, 2).toLowerCase();
  if (!PLAN_CODE.test(planCode)) throw new ValidationError('code 2-32 karakter: küçük harf, rakam, - ve _', 'code');
  const trial = o.trialDays === undefined ? DEFAULT_TRIAL_DAYS : o.trialDays;
  if (typeof trial !== 'number' || !Number.isSafeInteger(trial) || trial < 0 || trial > 90) throw new ValidationError('trialDays 0-90 gün olmalıdır', 'trialDays');
  const description = optString(o, 'description', 300);
  return {
    code: planCode,
    name: reqString(o, 'name', 80, 2),
    ...(description ? { description } : {}),
    pricing: parsePricing(o.pricing),
    features: parseFeatures(o.features),
    limits: parseLimits(o.limits),
    trialDays: trial,
  };
}

const none = (): PlanFeatures => Object.fromEntries(PLAN_FEATURES.map((f) => [f, false])) as PlanFeatures;

/**
 * ORNEK / YER TUTUCU planlar (`placeholder: true`). Fiyatlar is karari DEGILDIR; sahibi
 * belirleyene kadar platform ekranindan duzenlenir (her duzenleme yeni surum). README'de not.
 * Fiyatlar KDV haric kurus; KDV %20.
 */
export const PLACEHOLDER_PLANS: readonly PlanContent[] = [
  {
    code: 'pilot',
    name: 'Pilot (ücretsiz)',
    description: 'Pilot siteler: tüm modüller açık, sınır yok, fatura kesilmez.',
    pricing: { model: 'flat', monthlyKurus: 0, annualKurus: 0, vatRateBps: 2000 },
    features: allFeatures(),
    limits: { maxUnits: null, maxStaffUsers: null },
    trialDays: 0,
    placeholder: true,
  },
  {
    code: 'temel',
    name: 'Temel',
    description: 'Küçük apartmanlar: aidat, tahsilat, duyuru, arıza; online ödeme ve mobil bildirim.',
    pricing: { model: 'per_unit', monthlyKurus: 0, annualKurus: 0, perUnitMonthlyKurus: 1_500, perUnitAnnualKurus: 15_000, vatRateBps: 2000 },
    features: { ...none(), 'payments.online': true, 'channels.push': true },
    limits: { maxUnits: 100, maxStaffUsers: 5 },
    trialDays: DEFAULT_TRIAL_DAYS,
    placeholder: true,
  },
  {
    code: 'standart',
    name: 'Standart',
    description: 'Siteler: Temel + güvenlik kapısı, rezervasyon, oylama / genel kurul, ekipman, toplu işler.',
    pricing: { model: 'per_unit', monthlyKurus: 25_000, annualKurus: 250_000, perUnitMonthlyKurus: 1_200, perUnitAnnualKurus: 12_000, vatRateBps: 2000 },
    features: { ...none(), 'payments.online': true, 'channels.push': true, 'modules.gate': true, 'modules.reservations': true, 'modules.pollsAssemblies': true, 'modules.equipment': true, 'modules.bulkJobs': true },
    limits: { maxUnits: 500, maxStaffUsers: 15 },
    trialDays: DEFAULT_TRIAL_DAYS,
    placeholder: true,
  },
  {
    code: 'profesyonel',
    name: 'Profesyonel',
    description: 'Büyük siteler ve yönetim firmaları: tüm modüller, ihale ve portföy dahil.',
    pricing: {
      model: 'tiered',
      monthlyKurus: 0,
      annualKurus: 0,
      tiers: [
        { maxUnits: 250, monthlyKurus: 150_000, annualKurus: 1_500_000 },
        { maxUnits: 1000, monthlyKurus: 350_000, annualKurus: 3_500_000 },
        { maxUnits: null, monthlyKurus: 600_000, annualKurus: 6_000_000 },
      ],
      vatRateBps: 2000,
    },
    features: allFeatures(),
    limits: { maxUnits: null, maxStaffUsers: null },
    trialDays: DEFAULT_TRIAL_DAYS,
    placeholder: true,
  },
];
