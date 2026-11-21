/**
 * Online tahsilat komisyonu (Online Odeme v2 · P1). Saf fonksiyonlar, I/O yok; tum tutarlar kurus.
 *
 * Karar (21.11.2026, Secenek A): komisyonu APARTMAN YONETIMI oder. Sakin borcunu net oder; sakine
 * hicbir ek ucret yansitilmaz (5464 s. Kanun m.17). Toplam komisyon = platform payi (%0,75) +
 * tahmini POS maliyeti (sozlesmedeki sabit oran). Bu tutar alt uye isyerine aktarilacak tutardan
 * (`subMerchantPrice`) dusulur ve apartman defterine "Online Tahsilat Komisyon Gideri" olarak yazilir.
 * Saglayicinin gercek komisyonu odeme sonrasi mutabakat kaydina islenir (tahmin ile fark platformun
 * marji/kaybidir; apartmanin defteri degismez).
 *
 * Yuvarlama:
 *  - platform payi asagi (apartman lehine),
 *  - POS tahmini yukari (platform saglayici komisyonunu karsilayamaz duruma dusmesin),
 *  - sabit POS ucreti islem basina bir kez (ilk sepet kalemine) yuklenir.
 */
import { type Kurus, toKurus } from '../core/types.js';
import { ValidationError } from '../core/validation.js';

/** Platform payi varsayilani: %0,75 (75 baz puan). */
export const DEFAULT_PLATFORM_FEE_BASIS_POINTS = 75;
/** POS orani ust siniri (%10): yanlis yapilandirmaya karsi. */
export const MAX_POS_RATE_BASIS_POINTS = 1_000;
/** Sabit POS ucreti ust siniri (50 TL). */
export const MAX_POS_FIXED_FEE_KURUS = 5_000;

export type FeePolicy = {
  /** Platform payi (baz puan; 75 = %0,75). */
  platformBasisPoints: number;
  /** Saglayici sozlesme orani (baz puan; 249 = %2,49). */
  posRateBasisPoints: number;
  /** Islem basina sabit saglayici ucreti (kurus; 25 = 0,25 TL). */
  posFixedFeeKurus: number;
};

export const ZERO_FEES: FeePolicy = { platformBasisPoints: 0, posRateBasisPoints: 0, posFixedFeeKurus: 0 };

export type ItemSplit = {
  amount: Kurus;
  platformFee: Kurus;
  posEstimate: Kurus;
  /** Apartmanin IBAN'ina aktarilacak tutar. */
  subMerchantPrice: Kurus;
};

export type SplitResult = {
  items: ItemSplit[];
  amount: Kurus;
  platformFee: Kurus;
  posEstimate: Kurus;
  /** Apartmanin komisyon gideri = platformFee + posEstimate. */
  commission: Kurus;
  subMerchantTotal: Kurus;
};

const floorBps = (amount: number, bps: number) => (bps <= 0 ? 0 : Number((BigInt(amount) * BigInt(bps)) / 10_000n));
const ceilBps = (amount: number, bps: number) =>
  bps <= 0 ? 0 : Number((BigInt(amount) * BigInt(bps) + 9_999n) / 10_000n);

export function assertFeePolicy(p: FeePolicy): void {
  const int = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!int(p.platformBasisPoints, 2_000)) throw new ValidationError('platformBasisPoints 0-2000 olmali', 'platformFeeBasisPoints');
  if (!int(p.posRateBasisPoints, MAX_POS_RATE_BASIS_POINTS)) {
    throw new ValidationError(`posRateBasisPoints 0-${MAX_POS_RATE_BASIS_POINTS} olmali`, 'posRateBasisPoints');
  }
  if (!int(p.posFixedFeeKurus, MAX_POS_FIXED_FEE_KURUS)) {
    throw new ValidationError(`posFixedFeeKurus 0-${MAX_POS_FIXED_FEE_KURUS} olmali`, 'posFixedFeeKurus');
  }
}

/**
 * Sepet kalemleri (alt cari basina tutar) icin komisyon ayrimi. Sakinin odedigi tutar
 * degismez (`amount`). Bir kalemde aktarilacak tutar 1 kurustan az kaliyorsa odeme reddedilir.
 */
export function computeSplit(amounts: readonly number[], policy: FeePolicy): SplitResult {
  assertFeePolicy(policy);
  const items: ItemSplit[] = amounts.map((amount, i) => {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ValidationError('Kalem tutari pozitif kurus olmali', 'amount');
    const platformFee = floorBps(amount, policy.platformBasisPoints);
    const posEstimate = ceilBps(amount, policy.posRateBasisPoints) + (i === 0 ? policy.posFixedFeeKurus : 0);
    const subMerchantPrice = amount - platformFee - posEstimate;
    if (subMerchantPrice < 1) {
      throw new ValidationError('Tutar online ödeme için çok düşük; lütfen yönetiminize başvurun', 'amount');
    }
    return {
      amount: toKurus(amount),
      platformFee: toKurus(platformFee),
      posEstimate: toKurus(posEstimate),
      subMerchantPrice: toKurus(subMerchantPrice),
    };
  });
  const sum = (k: keyof ItemSplit) => items.reduce((s, it) => s + it[k], 0);
  return {
    items,
    amount: toKurus(sum('amount')),
    platformFee: toKurus(sum('platformFee')),
    posEstimate: toKurus(sum('posEstimate')),
    commission: toKurus(sum('platformFee') + sum('posEstimate')),
    subMerchantTotal: toKurus(sum('subMerchantPrice')),
  };
}

/**
 * Ortam varsayilanlari (saglayici sozlesmesi): PAYMENTS_POS_RATE_BPS, PAYMENTS_POS_FIXED_FEE_KURUS.
 * Tanimsizsa 0 (yerel/sahte saglayici); gecersiz deger baslangicta hata verir.
 */
export function loadPosDefaults(env: NodeJS.ProcessEnv = process.env): Pick<FeePolicy, 'posRateBasisPoints' | 'posFixedFeeKurus'> {
  const read = (key: string, max: number) => {
    const raw = env[key]?.trim();
    if (!raw) return 0;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${key} gecersiz: "${raw}" (0-${max} tam sayi)`);
    return v;
  };
  return {
    posRateBasisPoints: read('PAYMENTS_POS_RATE_BPS', MAX_POS_RATE_BASIS_POINTS),
    posFixedFeeKurus: read('PAYMENTS_POS_FIXED_FEE_KURUS', MAX_POS_FIXED_FEE_KURUS),
  };
}

/** Hesap ayari (varsa) ortam varsayilanini gecersiz kilar. */
export function feePolicyOf(
  account: { platformFeeBasisPoints: number; posRateBasisPoints?: number; posFixedFeeKurus?: number },
  defaults: Pick<FeePolicy, 'posRateBasisPoints' | 'posFixedFeeKurus'>,
): FeePolicy {
  return {
    platformBasisPoints: account.platformFeeBasisPoints,
    posRateBasisPoints: account.posRateBasisPoints ?? defaults.posRateBasisPoints,
    posFixedFeeKurus: account.posFixedFeeKurus ?? defaults.posFixedFeeKurus,
  };
}
