import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type QuoteInput, type Tender, type TenderInput, portalTendersApi, tendersApi } from '@/lib/api/tenders';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { portalKeys } from './usePortal';
import { unitKeys } from './useUnits';

/** API rol listeleriyle ayni (tenders/routes.ts). */
const READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE: readonly Role[] = ['apartment_manager', 'management_company'];

export function useTenderPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  return { canRead: !!role && READ.includes(role), canWrite: !!role && WRITE.includes(role) };
}

export const tenderKeys = {
  all: (apt: string) => [...unitKeys.apartment(apt), 'tenders'] as const,
  list: (apt: string) => [...tenderKeys.all(apt), 'list'] as const,
  detail: (apt: string, id: string) => [...tenderKeys.all(apt), 'detail', id] as const,
};

function useApt() {
  const { user } = useAuth();
  const { canRead } = useTenderPermissions();
  return { apt: user?.apartmentId ?? '', enabled: !!user?.apartmentId && canRead };
}

export function useTenders() {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: tenderKeys.list(apt), queryFn: ({ signal }) => tendersApi.list(signal).then((r) => r.items), enabled });
}

export function useTender(id: string | undefined) {
  const { apt, enabled } = useApt();
  return useQuery({ queryKey: tenderKeys.detail(apt, id ?? ''), queryFn: ({ signal }) => tendersApi.get(id ?? '', signal).then((r) => r.tender), enabled: enabled && !!id });
}

/** Yazim sonrasi ayrinti yanitla guncellenir; liste ve (409 sonrasi) ayrinti yeniden cekilir. */
function useTenderWrite<V>(fn: (v: V) => Promise<{ tender: Tender }>) {
  const { apt } = useApt();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => qc.setQueryData(tenderKeys.detail(apt, r.tender.tenderId), r.tender),
    onSettled: () => qc.invalidateQueries({ queryKey: tenderKeys.all(apt) }),
  });
}

export function useSaveTender() {
  return useTenderWrite((v: { id?: string; version?: number; idempotencyKey: string; input: TenderInput }) =>
    v.id && v.version !== undefined ? tendersApi.update(v.id, { ...v.input, version: v.version }) : tendersApi.create({ ...v.input, idempotencyKey: v.idempotencyKey }),
  );
}

export function useTenderActions() {
  return {
    collect: useTenderWrite((v: { id: string; version: number }) => tendersApi.collect(v.id, { version: v.version })),
    publish: useTenderWrite((v: { id: string; version: number; shortfallReason?: string }) =>
      tendersApi.publish(v.id, { version: v.version, ...(v.shortfallReason ? { shortfallReason: v.shortfallReason } : {}) }),
    ),
    decide: useTenderWrite((v: { id: string; version: number; quoteId: string; reason: string; reference?: string }) =>
      tendersApi.decide(v.id, { version: v.version, quoteId: v.quoteId, reason: v.reason, ...(v.reference ? { reference: v.reference } : {}) }),
    ),
    cancel: useTenderWrite((v: { id: string; version: number; reason: string }) => tendersApi.cancel(v.id, { version: v.version, reason: v.reason })),
    withdrawQuote: useTenderWrite((v: { id: string; quoteId: string; version: number; reason: string }) => tendersApi.withdrawQuote(v.id, v.quoteId, { version: v.version, reason: v.reason })),
    comment: useTenderWrite((v: { id: string; idempotencyKey: string; body: string }) => tendersApi.comment(v.id, { idempotencyKey: v.idempotencyKey, body: v.body })),
  };
}

export function useSaveQuote() {
  return useTenderWrite((v: { tenderId: string; quoteId?: string; version: number; idempotencyKey: string; input: QuoteInput }) =>
    v.quoteId ? tendersApi.updateQuote(v.tenderId, v.quoteId, { ...v.input, version: v.version }) : tendersApi.addQuote(v.tenderId, { ...v.input, idempotencyKey: v.idempotencyKey }),
  );
}

// ---------------------------------------------------------------------------
// Sakin portali
// ---------------------------------------------------------------------------

function usePortalScope() {
  const { user } = useAuth();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!user.apartmentId };
}

export const portalTenderKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'tenders'] as const,
  list: (apt: string, user: string) => [...portalTenderKeys.all(apt, user), 'list'] as const,
  detail: (apt: string, user: string, id: string) => [...portalTenderKeys.all(apt, user), 'detail', id] as const,
};

export function useMyTenders() {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({ queryKey: portalTenderKeys.list(apt, userId), queryFn: ({ signal }) => portalTendersApi.list(signal).then((r) => r.items), enabled });
}

export function useMyTender(id: string | undefined) {
  const { apt, userId, enabled } = usePortalScope();
  return useQuery({
    queryKey: portalTenderKeys.detail(apt, userId, id ?? ''),
    queryFn: ({ signal }) => portalTendersApi.get(id ?? '', signal).then((r) => r.tender),
    enabled: enabled && !!id,
  });
}

export function useAskTenderQuestion() {
  const qc = useQueryClient();
  const { apt, userId } = usePortalScope();
  return useMutation({
    mutationFn: (v: { id: string; idempotencyKey: string; body: string }) => portalTendersApi.comment(v.id, { idempotencyKey: v.idempotencyKey, body: v.body }),
    onSuccess: (r) => qc.setQueryData(portalTenderKeys.detail(apt, userId, r.tender.tenderId), r.tender),
    onSettled: () => qc.invalidateQueries({ queryKey: portalTenderKeys.all(apt, userId) }),
  });
}
