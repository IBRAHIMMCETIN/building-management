import { useCallback, useState } from 'react';

/**
 * Islem anahtari (API `idempotencyKey`). Benzersizlik yeterlidir, gizli degildir: `crypto.randomUUID`
 * varsa o, yoksa `getRandomValues` (Hermes'te polyfill ile), en son `Math.random` ile v4 bicimi.
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Bir islem girisi (form) boyunca SABIT kalan anahtar (web hooks/useIdempotencyKey.ts): ayni form
 * icinde tekrar gonderim (cift dokunma, ag hatasi sonrasi yeniden deneme) ayni anahtari kullanir; API
 * ikinci kayit olusturmaz. Yeni bir islem icin `renew()`.
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return [key, renew];
}
