import { useCallback, useState } from 'react';

const newKey = () => crypto.randomUUID();

/**
 * Bir islem girisi (modal) boyunca SABIT kalan idempotency anahtari. Ayni form icinde
 * tekrar gonderim (cift tiklama, ag hatasi sonrasi yeniden deneme) ayni anahtari kullanir;
 * API ikinci kayit olusturmaz. Yeni bir islem icin `renew()` cagrilir.
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(newKey);
  const renew = useCallback(() => setKey(newKey()), []);
  return [key, renew];
}
