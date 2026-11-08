/**
 * Para yardimcilari. Veritabani/API tutarlari KURUS cinsinden tam sayidir (1.500,50 TL -> 150050).
 * Kullanici girdisi kayan noktaya hic donusturulmeden metin olarak kurusa cevrilir.
 */

const formatter = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2 });

/** 150050 -> "₺1.500,50". Yalnizca gosterim (bolme sonucu yuvarlama hatasi tasimaz: 2 ondalik). */
export function formatTRY(kurus: number): string {
  return formatter.format(kurus / 100);
}

/** Isaretli gosterim: +₺1.500,50 / -₺300,00 */
export function formatSignedTRY(kurus: number): string {
  if (kurus === 0) return formatTRY(0);
  return `${kurus > 0 ? '+' : '−'}${formatTRY(Math.abs(kurus))}`;
}

/** Form alaninda duzenleme icin: 150050 -> "1500,50" */
export function kurusToInput(kurus: number): string {
  const abs = Math.abs(kurus);
  return `${kurus < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** API ust siniri ile ayni: 999.999.999,99 TL */
export const MAX_KURUS = 99_999_999_999;

/**
 * "1.500,50", "1500,5", "1500.50", "1 500", "₺1.500" -> kurus. Gecersiz/negatif/sifir -> null.
 * Kural: virgul varsa ondalik ayiraci virguldur (nokta binlik). Virgul yoksa ve nokta
 * sonrasinda 1-2 hane varsa nokta ondaliktir; aksi halde noktalar binlik ayiracidir.
 */
export function parseTRYToKurus(input: string): number | null {
  const text = input.replace(/\s|₺|TL/gi, '');
  if (!text || !/^[\d.,]+$/.test(text)) return null;

  let integer: string;
  let fraction = '';
  if (text.includes(',')) {
    const parts = text.split(',');
    if (parts.length !== 2) return null;
    integer = parts[0] ?? '';
    fraction = parts[1] ?? '';
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(integer)) return null;
    integer = integer.replaceAll('.', '');
  } else {
    const m = /^(\d+)\.(\d{1,2})$/.exec(text);
    if (m) {
      integer = m[1] ?? '';
      fraction = m[2] ?? '';
    } else {
      if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(text)) return null;
      integer = text.replaceAll('.', '');
    }
  }
  if (!/^\d*$/.test(fraction) || fraction.length > 2 || integer === '') return null;

  const kurus = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(kurus) || kurus < 1 || kurus > MAX_KURUS) return null;
  return kurus;
}
