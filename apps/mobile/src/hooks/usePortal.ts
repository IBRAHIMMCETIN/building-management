import { ApiError } from '@bm/shared/api/errors';
import type { NotificationPreferencesInput } from '@bm/shared/api/notificationPreferences';
import { PORTAL_OPEN_STATUSES } from '@bm/shared/api/tickets';
import type { SessionClaims } from '@bm/shared/auth/session';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthProvider';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { endpoints } from '@/lib/api/endpoints';
import { useServices } from '@/services';

/*
 * Sakin portali sorgulari (web: hooks/usePortal.ts, usePayments.ts, usePortalTickets.ts).
 * Anahtarlar apartman + kullanici + daire bazlidir; baglam degisince onbellek temizlenir.
 */
export const portalKeys = {
  all: (apt: string, user: string) => ['apartment', apt, 'portal', user] as const,
  summary: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'summary', unitId ?? 'auto'] as const,
  statement: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'statement', unitId ?? 'auto'] as const,
  announcements: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'announcements', unitId ?? 'auto'] as const,
  quote: (apt: string, user: string, unitId?: string) => [...portalKeys.all(apt, user), 'payment-quote', unitId ?? 'auto'] as const,
  tickets: (apt: string, user: string, status: string) => [...portalKeys.all(apt, user), 'tickets', 'list', status] as const,
};

export const accountKeys = {
  // Tercih kullanici genelidir; kapsam anahtarda yalnizca baglam degisiminde ekranin yeni sorguya baglanmasi icin.
  notifications: (claims: SessionClaims | null | undefined) => ['me', 'notification-preferences', claims?.sub, claims?.apartmentId, claims?.role] as const,
};

/** Daire secimi / uyelik yok gibi "beklenen" 4xx'ler tekrar denenmez (ekran secici gosterir). */
export const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

export function useScope() {
  const { user } = useAuth();
  const { unitId, ready } = usePortalUnit();
  const { api } = useServices();
  return {
    api,
    apt: user?.apartmentId ?? '',
    userId: user?.sub ?? '',
    unitId,
    enabled: ready && user?.role === 'resident' && !!user.apartmentId,
  };
}

export function useMySummary() {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({ queryKey: portalKeys.summary(apt, userId, unitId), queryFn: ({ signal }) => endpoints.mySummary(api, unitId, signal), enabled, retry });
}

export function useMyStatement() {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({ queryKey: portalKeys.statement(apt, userId, unitId), queryFn: ({ signal }) => endpoints.myStatement(api, unitId, signal), enabled, retry });
}

/** Sakinin dairesinin blogunu kapsayan, yayin penceresindeki duyurular (en yeni once). */
export function useMyAnnouncements() {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({
    queryKey: portalKeys.announcements(apt, userId, unitId),
    queryFn: ({ signal }) => endpoints.myAnnouncements(api, unitId, signal).then((r) => r.items),
    enabled,
    retry,
  });
}

/** Odenebilir tutar ve online odemenin acik olup olmadigi ("Online öde" dugmesi icin). */
export function usePaymentQuote() {
  const { api, apt, userId, unitId, enabled } = useScope();
  return useQuery({ queryKey: portalKeys.quote(apt, userId, unitId), queryFn: ({ signal }) => endpoints.paymentQuote(api, unitId, signal), enabled, retry });
}

/** Acik talepler (ana sayfa ozeti). */
export function useMyOpenTickets() {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: portalKeys.tickets(apt, userId, PORTAL_OPEN_STATUSES),
    queryFn: ({ signal }) => endpoints.myTickets(api, PORTAL_OPEN_STATUSES, signal),
    enabled,
    retry,
  });
}

/** Bildirim tercihleri kullanici geneldir (rol gerektirmez; web: useTeam.ts). */
export function useNotificationPreferences() {
  const { user } = useAuth();
  const { api } = useServices();
  return useQuery({
    queryKey: accountKeys.notifications(user),
    queryFn: ({ signal }) => endpoints.notificationPreferences(api, signal),
    enabled: !!user,
  });
}

/** Yalnizca DEGISEN alani gonderir; yanit onbellege yazilir. */
export function useSaveNotificationPreferences() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { api } = useServices();
  return useMutation({
    mutationFn: (input: NotificationPreferencesInput) => endpoints.saveNotificationPreferences(api, input),
    onSuccess: (data) => qc.setQueryData(accountKeys.notifications(user), data),
  });
}
