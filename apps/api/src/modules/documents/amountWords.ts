/**
 * Tutari Turkce yaziyla yazar (makbuzlar icin): 150050 -> "Bin beş yüz Türk lirası elli kuruş".
 * Girdi kurus cinsinden tam sayidir; kayan nokta kullanilmaz.
 * Kurallar: "bir yüz" ve "bir bin" denmez ("yüz", "bin"); "bir milyon" denir.
 */
const ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];
const SCALES = ['', 'bin', 'milyon', 'milyar', 'trilyon'];

function underThousand(n: number): string[] {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  const words: string[] = [];
  if (h > 0) {
    if (h > 1) words.push(ONES[h] as string);
    words.push('yüz');
  }
  if (t > 0) words.push(TENS[t] as string);
  if (o > 0) words.push(ONES[o] as string);
  return words;
}

export function integerInWordsTR(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Gecersiz sayi: ${value}`);
  if (value === 0) return 'sıfır';
  const groups: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 1000)) groups.push(n % 1000);
  if (groups.length > SCALES.length) throw new Error('Sayi cok buyuk');

  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as number;
    if (g === 0) continue;
    const scale = SCALES[i] as string;
    if (scale === 'bin' && g === 1) {
      words.push('bin');
      continue;
    }
    words.push(...underThousand(g));
    if (scale) words.push(scale);
  }
  return words.join(' ');
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase('tr') + s.slice(1);

export function amountInWordsTR(kurus: number): string {
  if (!Number.isSafeInteger(kurus) || kurus < 0) throw new Error(`Gecersiz tutar: ${kurus}`);
  const lira = Math.floor(kurus / 100);
  const k = kurus % 100;
  if (lira === 0 && k > 0) return capitalize(`${integerInWordsTR(k)} kuruş`);
  const text = `${integerInWordsTR(lira)} Türk lirası${k > 0 ? ` ${integerInWordsTR(k)} kuruş` : ''}`;
  return capitalize(text);
}
