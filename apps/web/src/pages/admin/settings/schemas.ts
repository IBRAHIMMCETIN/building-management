import { z } from 'zod';
import type { DuesPlanKey, Site, UpdateSiteSettingsInput } from '@/lib/api/sites';
import { kurusToInput, parseTRYToKurus } from '@/lib/money';

/** KMK m.20: aylik %5. */
export const STATUTORY_LATE_FEE_BP = 500;

/**
 * "5" | "5,5" | "2,25" | "%5" -> baz puan (500 | 550 | 225). En fazla 2 ondalik, 0-100.
 * Kayan nokta kullanilmaz.
 */
export function parsePercentToBasisPoints(input: string): number | null {
  const text = input.replace(/\s|%/g, '').replace('.', ',');
  const m = /^(\d{1,3})(?:,(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp > 10_000 ? null : bp;
}

/** 500 -> "5", 550 -> "5,5", 225 -> "2,25" */
export function basisPointsToInput(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}

export const settingsSchema = z
  .object({
    dueDayOfMonth: z.string().trim(),
    lateFeeRate: z.string().trim(),
    planEnabled: z.boolean(),
    planAmount: z.string().trim(),
    planKey: z.enum(['equal', 'area', 'land_share']),
    planParty: z.enum(['occupant', 'owner']),
  })
  .transform((v, ctx) => {
    const day = /^\d{1,2}$/.test(v.dueDayOfMonth) ? Number(v.dueDayOfMonth) : Number.NaN;
    if (!(day >= 1 && day <= 28)) {
      ctx.addIssue({ code: 'custom', path: ['dueDayOfMonth'], message: '1 ile 28 arasında bir gün girin.' });
    }
    const bp = parsePercentToBasisPoints(v.lateFeeRate);
    if (bp === null) {
      ctx.addIssue({ code: 'custom', path: ['lateFeeRate'], message: 'Oran geçersiz. Örnek: 5 veya 2,5 (en fazla %100).' });
    }
    const amount = v.planAmount === '' ? null : parseTRYToKurus(v.planAmount);
    if (v.planEnabled && amount === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['planAmount'],
        message: v.planAmount === '' ? 'Aylık toplam tutar gerekli.' : 'Tutar geçersiz. Örnek: 15.000,00',
      });
    }
    return {
      dueDayOfMonth: day,
      lateFeeMonthlyBasisPoints: bp ?? 0,
      plan: amount === null ? null : { enabled: v.planEnabled, totalAmount: amount, distributionKey: v.planKey, liableParty: v.planParty },
    };
  });

export type SettingsForm = z.input<typeof settingsSchema>;
export type SettingsValues = z.output<typeof settingsSchema>;

export function formDefaults(site: Site): SettingsForm {
  const plan = site.settings.monthlyDuesPlan;
  return {
    dueDayOfMonth: String(site.settings.dueDayOfMonth),
    lateFeeRate: basisPointsToInput(site.settings.lateFeeMonthlyBasisPoints),
    planEnabled: plan?.enabled ?? false,
    planAmount: plan ? kurusToInput(plan.totalAmount) : '',
    planKey: (plan?.distributionKey ?? 'equal') as DuesPlanKey,
    planParty: plan?.liableParty ?? 'occupant',
  };
}

/**
 * Plan kapatildiginda girilen degerler `enabled: false` ile saklanir (tekrar acinca kaybolmaz);
 * tutar hic girilmemisse plan kaldirilir (`null`).
 */
export function toUpdateInput(v: SettingsValues, version: number): UpdateSiteSettingsInput {
  return {
    version,
    settings: {
      dueDayOfMonth: v.dueDayOfMonth,
      lateFeeMonthlyBasisPoints: v.lateFeeMonthlyBasisPoints,
      monthlyDuesPlan: v.plan,
    },
  };
}

export const SETTINGS_FIELD_MAP = {
  dueDayOfMonth: 'dueDayOfMonth',
  lateFeeMonthlyBasisPoints: 'lateFeeRate',
  monthlyDuesPlan: 'planAmount',
  totalAmount: 'planAmount',
  distributionKey: 'planKey',
  liableParty: 'planParty',
} as const;
