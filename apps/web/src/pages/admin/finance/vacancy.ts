/** "A · 1, A · 2 ve 3 daire daha" (en fazla `max` ad). */
export function unitListText<T>(units: readonly T[], label: (u: T) => string, max = 5): string {
  const head = units.slice(0, max).map(label).join(', ');
  return units.length > max ? `${head} ve ${units.length - max} daire daha` : head;
}

type U = { blockId: string; number: string };

/**
 * Bos daire kurali notlari (yalnizca sakin tarafi tahakkukunda API doldurur):
 * malike yazilacak bolumler ve uyelik kaydi olmadigi icin kuralin uygulanamadigi bolumler.
 */
export function vacancyNotes(p: { vacant: readonly U[]; unknownOccupancy: readonly U[] }, label: (u: U) => string): string[] {
  const out: string[] = [];
  if (p.vacant.length) out.push(`${p.vacant.length} boş daire kat malikine yazılacak: ${unitListText(p.vacant, label)}`);
  if (p.unknownOccupancy.length) {
    out.push(`${p.unknownOccupancy.length} dairede sakin/malik kaydı yok, sakin carisine yazılacak: ${unitListText(p.unknownOccupancy, label)}`);
  }
  return out;
}
