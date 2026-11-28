import { useCallback, useState } from 'react';

/*
 * Tekrar korumali yazimlar (kurye kaydi, gecis giris / cikisi, elle kapi kaydi) icin istemci anahtari
 * (web: hooks/useIdempotencyKey.ts). Ayni anahtarla yeniden gonderim (ag kesintisi, cift dokunma)
 * sunucuda ayni sonucu dondurur; basaridan sonra yeni anahtar alinir.
 */

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(bytes);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** UUID v4 bicimli rastgele anahtar. */
export function newIdempotencyKey(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** [anahtar, yenile]: basarili yazimdan (veya formu sifirlayinca) sonra `renew()`. */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return [key, renew];
}
