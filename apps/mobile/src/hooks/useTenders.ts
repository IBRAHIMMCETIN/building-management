import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { tendersApi } from '@/lib/api/tenders';
import { portalKeys, retry, useScope } from './usePortal';

/*
 * Sakin ihaleleri (web: hooks/useTenders.ts -> useMyTenders / useMyTender / useAskTenderQuestion).
 * Ihaleler apartman geneldir (daire parametresi yok); anahtar yine kullanici kapsamli.
 */
export const portalTenderKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'tenders'] as const,
  list: (apt: string, user: string) => [...portalTenderKeys.all(apt, user), 'list'] as const,
  detail: (apt: string, user: string, id: string) => [...portalTenderKeys.all(apt, user), 'detail', id] as const,
};

export function useMyTenders() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: portalTenderKeys.list(apt, userId), queryFn: ({ signal }) => tendersApi.list(api, signal).then((r) => r.items), enabled, retry });
}

export function useMyTender(id: string) {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: portalTenderKeys.detail(apt, userId, id),
    queryFn: ({ signal }) => tendersApi.get(api, id, signal).then((r) => r.tender),
    enabled: enabled && !!id,
    retry,
  });
}

/** Soru gonderme: yanit ayrintiya yazilir, liste ve ayrinti yeniden cekilir (web ile ayni). */
export function useAskTenderQuestion(id: string) {
  const { api, apt, userId } = useScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { idempotencyKey: string; body: string }) => tendersApi.comment(api, id, input),
    onSuccess: (r) => queryClient.setQueryData(portalTenderKeys.detail(apt, userId, r.tender.tenderId), r.tender),
    onSettled: () => queryClient.invalidateQueries({ queryKey: portalTenderKeys.all(apt, userId) }),
  });
}

/** RFC 4122 v4. Hermes'te `crypto.randomUUID` yok; `getRandomValues` (react-native-get-random-values) var. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Bir gonderim boyunca SABIT kalan idempotency anahtari (web: hooks/useIdempotencyKey.ts): ayni
 * sorunun tekrar gonderimi (cift dokunma, ag hatasi sonrasi yeniden deneme) ikinci kayit olusturmaz.
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return [key, renew];
}
