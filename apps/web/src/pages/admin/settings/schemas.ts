import { z } from 'zod';
import type { DuesPlanKey, MonthlyDuesPlan, Site, UpdateSiteSettingsInput } from '@/lib/api/sites';
import { kurusToInput, parseTRYToKurus } from '@/lib/money';

/** Aidat tahakkukunun varsayilan gelir hesabi (API SYSTEM_ACCOUNTS.incomeDues). */
export const DEFAULT_INCOME_ACCOUNT = 'income-dues';

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
    /** Finans 2.4: gelir hesabi ('' = varsayilan aidat gelirleri). */
    planIncomeAccountId: z.string(),
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
      plan:
        amount === null
          ? null
          : {
              enabled: v.planEnabled,
              totalAmount: amount,
              distributionKey: v.planKey,
              liableParty: v.planParty,
              ...(v.planIncomeAccountId && v.planIncomeAccountId !== DEFAULT_INCOME_ACCOUNT ? { incomeAccountId: v.planIncomeAccountId } : {}),
            },
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
    planIncomeAccountId: plan?.incomeAccountId ?? DEFAULT_INCOME_ACCOUNT,
  };
}

/**
 * Plan kapatildiginda girilen degerler `enabled: false` ile saklanir (tekrar acinca kaybolmaz);
 * tutar hic girilmemisse plan kaldirilir (`null`).
 */
export function toUpdateInput(v: SettingsValues, version: number, current?: MonthlyDuesPlan): UpdateSiteSettingsInput {
  return {
    version,
    settings: {
      dueDayOfMonth: v.dueDayOfMonth,
      lateFeeMonthlyBasisPoints: v.lateFeeMonthlyBasisPoints,
      monthlyDuesPlan: v.plan && current?.budgetId && samePlan(v.plan, current) ? { ...v.plan, budgetId: current.budgetId } : v.plan,
    },
  };
}

/**
 * Finans 2.4: plan butceden uygulanmissa (budgetId) tutar, anahtar, taraf ve gelir hesabi
 * degismedikce bag korunur; elle degistirilen plan artik butceye bagli sayilmaz.
 */
function samePlan(a: MonthlyDuesPlan, b: MonthlyDuesPlan): boolean {
  return (
    a.totalAmount === b.totalAmount &&
    a.distributionKey === b.distributionKey &&
    a.liableParty === b.liableParty &&
    (a.incomeAccountId ?? DEFAULT_INCOME_ACCOUNT) === (b.incomeAccountId ?? DEFAULT_INCOME_ACCOUNT)
  );
}

export const SETTINGS_FIELD_MAP = {
  dueDayOfMonth: 'dueDayOfMonth',
  lateFeeMonthlyBasisPoints: 'lateFeeRate',
  monthlyDuesPlan: 'planAmount',
  totalAmount: 'planAmount',
  distributionKey: 'planKey',
  liableParty: 'planParty',
  'monthlyDuesPlan.incomeAccountId': 'planIncomeAccountId',
} as const;
