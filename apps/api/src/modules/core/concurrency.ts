/**
 * Sinirli eszamanlilikla eslem: en fazla `limit` is ayni anda calisir, sonuc sirasi girdi
 * sirasiyla aynidir. Bir is hata verirse yeni is baslatilmaz ve ilk hata firlatilir (calisan
 * isler tamamlanir; yarim kalan toplu islemler idempotent oldugu icin guvenle tekrarlanir).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const lane = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
  if (failed) throw firstError;
  return results;
}
