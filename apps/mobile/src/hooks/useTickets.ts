import type { PhotoUpload, PortalCreateTicketInput } from '@bm/shared/api/portalTickets';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { portalTicketsApi } from '@/lib/api/portalTickets';
import { type PreparedPhoto, putToSignedUrl } from '@/lib/photos';
import { useServices } from '@/services';
import { portalKeys } from './usePortal';

/*
 * Sakin talepleri (web: hooks/usePortalTickets.ts). Anahtarlar portal kapsaminda (apartman +
 * kullanici); liste anahtari Ana Sayfa ozetiyle (useMyOpenTickets) ayni oldugundan bir islemden
 * sonra ikisi birlikte yenilenir. Uygulama one gelince PortalForegroundRefresh hepsini tazeler.
 */

export const ticketKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'tickets'] as const,
  list: (apt: string, user: string, status: string) => portalKeys.tickets(apt, user, status),
  detail: (apt: string, user: string, id: string) => [...portalKeys.all(apt, user), 'tickets', 'detail', id] as const,
  similar: (apt: string, user: string, category: string) => [...portalKeys.all(apt, user), 'tickets', 'similar', category] as const,
};

function useScope() {
  const { user } = useAuth();
  const { api, env } = useServices();
  const apt = user?.apartmentId ?? '';
  return { api, env, apt, userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!apt };
}

export function useMyTickets(status: string) {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: ticketKeys.list(apt, userId, status), queryFn: ({ signal }) => portalTicketsApi.list(api, status, signal), enabled });
}

export function useMyTicket(id: string | undefined) {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({ queryKey: ticketKeys.detail(apt, userId, id ?? ''), queryFn: ({ signal }) => portalTicketsApi.get(api, id ?? '', signal), enabled: enabled && !!id });
}

/** Ortak alanda benzer acik talep uyarisi (kategori secilince). */
export function useSimilarTickets(category: string | null) {
  const { api, apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: ticketKeys.similar(apt, userId, category ?? ''),
    queryFn: ({ signal }) => portalTicketsApi.similar(api, category ?? '', signal).then((r) => r.items),
    enabled: enabled && !!category,
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  const { apt, userId } = useScope();
  return () => qc.invalidateQueries({ queryKey: ticketKeys.all(apt, userId) });
}

export function useCreateMyTicket() {
  const { api } = useScope();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: PortalCreateTicketInput) => portalTicketsApi.create(api, input), onSuccess: invalidate });
}

export function useMyTicketActions(id: string) {
  const { api } = useScope();
  const invalidate = useInvalidate();
  const opts = { onSuccess: invalidate };
  return {
    comment: useMutation({ mutationFn: (v: { body: string; photos?: string[] }) => portalTicketsApi.comment(api, id, v), ...opts }),
    confirm: useMutation({ mutationFn: (v: { version: number; rating?: number; note?: string }) => portalTicketsApi.confirm(api, id, v), ...opts }),
    reopen: useMutation({ mutationFn: (v: { version: number; note: string }) => portalTicketsApi.reopen(api, id, v), ...opts }),
    cancel: useMutation({ mutationFn: (v: { version: number }) => portalTicketsApi.cancel(api, id, v), ...opts }),
  };
}

/**
 * Demo modunda (EXPO_PUBLIC_API_MODE=demo) imzali link sahtedir, PUT yapilmaz. Demo kodu yalnizca o
 * modda yuklenir (kosullu require; services.tsx'teki demo fetch ile ayni yaklasim).
 */
function demoPut(upload: PhotoUpload): Promise<string> {
  const demo = require('@/dev/demo/tickets') as typeof import('@/dev/demo/tickets');
  return demo.demoPut(upload);
}

/** Tek fotografi yukler: `upload-url` (tur + boyut) ve imzali linke PUT; yukleme kimligini dondurur. */
export function usePhotoUploader(): (photo: PreparedPhoto) => Promise<string> {
  const { api, env } = useScope();
  return useCallback(
    async (photo: PreparedPhoto) => {
      const upload = await portalTicketsApi.uploadUrl(api, { contentType: photo.type, size: photo.size });
      return env.apiMode === 'demo' ? demoPut(upload) : putToSignedUrl(upload, photo.blob);
    },
    [api, env.apiMode],
  );
}

/** Zaman cizelgesindeki fotografin imzali linki (5 dk; yalnizca acilinca istenir). */
export function useTicketPhotoLoader(ticketId: string) {
  const { api } = useScope();
  return useCallback((photoId: string) => portalTicketsApi.photo(api, ticketId, photoId), [api, ticketId]);
}
