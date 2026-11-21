import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type AuditFilters, type AuditScope, auditApi } from '@/lib/api/audit';
import { ApiError } from '@/lib/api/errors';
import { fetchMfaUser, findMfaUser, resetUserMfa } from '@/lib/api/mfa';
import { supportApi } from '@/lib/api/support';
import { type PageCheck, verifyPage } from '@/lib/audit/chain';
import { useAuth } from './useAuth';

const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

export const securityKeys = {
  audit: (scope: AuditScope, tenant: string | undefined, filters: AuditFilters) => ['audit', scope, tenant, filters] as const,
  integrity: (scope: AuditScope, tenant: string | undefined) => ['audit', 'integrity', scope, tenant] as const,
  mfaUser: (userId: string) => ['mfa', 'user', userId] as const,
  support: (apartmentId: string) => ['platform', 'support', apartmentId] as const,
};

/** Platform yoneticisi (destek modu disinda) platform zincirini, digerleri apartman zincirini okur. */
export function useAuditScope(): AuditScope {
  const { user } = useAuth();
  return user?.role === 'platform_admin' ? 'platform' : 'apartment';
}

/** Sayfali denetim kayitlari (en yeni once, "daha fazla yukle"). */
export function useAuditLog(filters: AuditFilters) {
  const scope = useAuditScope();
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: securityKeys.audit(scope, user?.apartmentId, filters),
    queryFn: ({ pageParam, signal }) => auditApi.page(scope, filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    retry,
    staleTime: 0,
  });
}

export function useAuditIntegrity() {
  const scope = useAuditScope();
  const { user } = useAuth();
  return useQuery({
    queryKey: securityKeys.integrity(scope, user?.apartmentId),
    queryFn: ({ signal }) => auditApi.integrity(scope, signal),
    retry,
    staleTime: 60_000,
  });
}

/** Yuklu kayitlarin SHA-256 zincirini tarayicida dogrular (kayit listesi degistikce). */
export function usePageVerification(entries: readonly Parameters<typeof verifyPage>[0][number][]) {
  const [check, setCheck] = useState<PageCheck>();
  const key = entries.map((e) => e.hash).join(',');
  useEffect(() => {
    let cancelled = false;
    if (entries.length === 0) {
      setCheck(undefined);
      return;
    }
    void verifyPage(entries)
      .then((result) => {
        if (!cancelled) setCheck(result);
      })
      .catch(() => {
        // WebCrypto yoksa (http) gosterge "dogrulanamadi" kalir; sunucu dogrulamasi esastir.
        if (!cancelled) setCheck(undefined);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kayitlar hash listesiyle temsil edilir
  }, [key]);
  return check;
}

export function useMfaUser(userId: string | undefined) {
  return useQuery({
    queryKey: securityKeys.mfaUser(userId ?? ''),
    queryFn: ({ signal }) => fetchMfaUser(userId as string, signal),
    enabled: !!userId,
    retry,
    staleTime: 0,
  });
}

/** Platform: e-postayla kullanici aramasi (arama dugmesiyle tetiklenir). */
export function useFindMfaUser(email: string | undefined) {
  return useQuery({
    queryKey: ['mfa', 'find', email ?? ''] as const,
    queryFn: ({ signal }) => findMfaUser(email as string, signal),
    enabled: !!email,
    retry,
    staleTime: 0,
  });
}

export function useResetMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason: string }) => resetUserMfa(userId, reason),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mfa'] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useSupportSessions(apartmentId: string | undefined) {
  return useQuery({
    queryKey: securityKeys.support(apartmentId ?? ''),
    queryFn: ({ signal }) => supportApi.list(apartmentId as string, signal).then((r) => r.items),
    enabled: !!apartmentId,
    retry,
  });
}

/** Destek oturumu acar ve destek moduna gecer. */
export function useStartSupport() {
  const { startSupport } = useAuth();
  return useMutation({
    mutationFn: async (input: { apartmentId: string; apartmentName: string; reason: string; durationMinutes: number }) => {
      const s = await supportApi.start({ apartmentId: input.apartmentId, reason: input.reason, durationMinutes: input.durationMinutes });
      return { ...s, apartmentName: input.apartmentName };
    },
    onSuccess: (s) => {
      startSupport({ apartmentId: s.apartmentId, apartmentName: s.apartmentName, sessionId: s.sessionId, header: s.header, expiresAt: s.expiresAt });
    },
  });
}

/** Destek oturumunu API'de bitirir ve moddan cikar (API hatasinda da mod kapanir). */
export function useEndSupport() {
  const { support, leaveSupport } = useAuth();
  return useMutation({
    mutationFn: async () => {
      if (!support) return;
      try {
        await supportApi.end(support.apartmentId, support.sessionId);
      } finally {
        leaveSupport();
      }
    },
  });
}
