/* Misafir gecisi formu: API kurallarinin istemci kopyasi (asil dogrulama API'de). */

const DAY_MS = 86_400_000;
const daySpan = (from: string, until: string) => Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

export type PassFormInput = {
  guestName: string;
  validFrom: string;
  /** Bos: yalnizca gelis gunu. */
  validUntil: string;
  /** Istanbul bugunu (YYYY-MM-DD). */
  today: string;
  maxPassDays: number;
  maxPassLeadDays: number;
};

/** Ilk hata metni; gecerliyse `undefined`. */
export function passFormError(f: PassFormInput): string | undefined {
  if (f.guestName.trim().length < 2) return 'Misafirin adını yazın (en az 2 karakter).';
  if (!f.validFrom) return 'Geliş tarihini seçin.';
  if (f.validFrom < f.today) return 'Geçiş bugünden önce başlayamaz.';
  if (daySpan(f.today, f.validFrom) - 1 > f.maxPassLeadDays) return `Geçiş en fazla ${f.maxPassLeadDays} gün sonrası için oluşturulabilir.`;
  if (f.validUntil && f.validUntil < f.validFrom) return 'Son gün geliş tarihinden önce olamaz.';
  if (f.validUntil && daySpan(f.validFrom, f.validUntil) > f.maxPassDays) return `Bir geçiş en fazla ${f.maxPassDays} gün geçerli olabilir.`;
  return undefined;
}
