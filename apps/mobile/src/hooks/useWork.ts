import type { ReadingItemInput } from '@bm/shared/api/meterReadings';
import type { EstimateInput } from '@bm/shared/api/tickets';
import type { CompleteTaskInput } from '@bm/shared/api/work';
import type { TicketPriority, TransitionAction } from '@bm/shared/tickets/model';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { type TaskListQuery, type TicketListQuery, workEndpoints } from '@/lib/api/workEndpoints';
import { type LocalPhoto, type UploadDeps, uploadPhotos } from '@/lib/photos';
import { useServices } from '@/services';

/*
 * Bina gorevlisi "İşlerim" ve sayac okuma sorgulari (web: hooks/useTickets.ts, useMaintenance.ts,
 * useMeters.ts gorevli kismi). Anahtarlar apartman bazli: `['apartment', apt, 'work' | 'readings', ...]`.
 */
export const workKeys = {
  all: (apt: string) => ['apartment', apt, 'work'] as const,
  tickets: (apt: string, q: TicketListQuery) => [...workKeys.all(apt), 'tickets', q] as const,
  ticket: (apt: string, id: string) => [...workKeys.all(apt), 'ticket', id] as const,
  tasks: (apt: string, q: TaskListQuery) => [...workKeys.all(apt), 'tasks', q] as const,
  task: (apt: string, id: string) => [...workKeys.all(apt), 'task', id] as const,
  assignees: (apt: string) => [...workKeys.all(apt), 'assignees'] as const,
};

export const readingKeys = {
  all: (apt: string) => ['apartment', apt, 'readings'] as const,
  periods: (apt: string) => [...readingKeys.all(apt), 'periods'] as const,
  sheet: (apt: string, periodId: string) => [...readingKeys.all(apt), 'sheet', periodId] as const,
};

function useStaff() {
  const { user } = useAuth();
  const { api, rawFetch } = useServices();
  const apt = user?.apartmentId ?? '';
  return { api, rawFetch, apt, userId: user?.sub ?? '', enabled: !!apt && user?.role === 'building_staff' };
}

export function useStaffTickets(q: TicketListQuery) {
  const { api, apt, enabled } = useStaff();
  return useQuery({ queryKey: workKeys.tickets(apt, q), queryFn: ({ signal }) => workEndpoints.tickets(api, q, signal), enabled });
}

export function useStaffTasks(q: TaskListQuery) {
  const { api, apt, enabled } = useStaff();
  return useQuery({ queryKey: workKeys.tasks(apt, q), queryFn: ({ signal }) => workEndpoints.tasks(api, q, signal).then((r) => r.items), enabled });
}

export function useStaffTicket(id: string) {
  const { api, apt, enabled } = useStaff();
  return useQuery({ queryKey: workKeys.ticket(apt, id), queryFn: ({ signal }) => workEndpoints.ticket(api, id, signal), enabled: enabled && !!id });
}

export function useStaffTask(id: string) {
  const { api, apt, enabled } = useStaff();
  return useQuery({ queryKey: workKeys.task(apt, id), queryFn: ({ signal }) => workEndpoints.task(api, id, signal).then((r) => r.task), enabled: enabled && !!id });
}

/** Gorevli adlari (zaman cizelgesi ve tahmin notunda "kim"). Hata sessiz: ad yerine "Görevli". */
export function useAssigneeNames() {
  const { api, apt, enabled } = useStaff();
  const q = useQuery({ queryKey: workKeys.assignees(apt), queryFn: ({ signal }) => workEndpoints.assignees(api, signal).then((r) => r.items), enabled, staleTime: 5 * 60_000, retry: false });
  const map = new Map((q.data ?? []).map((a) => [a.userId, a.name]));
  return (userId: string | undefined) => (userId ? map.get(userId) : undefined);
}

/**
 * Daire ve blok etiketleri (web: tickets/shared.tsx useTicketLabels, meters/useMeterUnits): talep konumu
 * "A Blok · 7", sayac cizelgesinde blok filtresi. Yuklenmemisse / hatada daire no ya da kimlik kalir.
 */
export function useSiteLabels() {
  const { api, apt, enabled } = useStaff();
  const units = useQuery({ queryKey: [...workKeys.all(apt), 'units'], queryFn: ({ signal }) => workEndpoints.siteUnits(api, apt, signal).then((r) => r.items), enabled, staleTime: 10 * 60_000, retry: false });
  const blocks = useQuery({ queryKey: [...workKeys.all(apt), 'blocks'], queryFn: ({ signal }) => workEndpoints.siteBlocks(api, apt, signal).then((r) => r.items), enabled, staleTime: 10 * 60_000, retry: false });
  return useMemo(() => {
    const blockName = new Map((blocks.data ?? []).map((b) => [b.blockId, b.name]));
    const unitLabel = new Map(
      (units.data ?? []).map((u) => {
        const b = blockName.get(u.blockId);
        return [u.unitId, b ? `${b} · ${u.number}` : u.number];
      }),
    );
    return { unitLabel: (id: string) => unitLabel.get(id), blockName: (id: string) => blockName.get(id) };
  }, [units.data, blocks.data]);
}

/** Talep / bakim fotografi yukleyicisi (imzali link + PUT). */
function usePhotoUpload(kind: 'ticket' | 'task') {
  const { api, rawFetch } = useStaff();
  return (photos: readonly LocalPhoto[]) => {
    const deps: UploadDeps = {
      put: rawFetch,
      request: async (input) => {
        const r = kind === 'ticket' ? await workEndpoints.ticketPhotoUpload(api, input) : await workEndpoints.taskPhotoUpload(api, input);
        return { id: r.uploadId, uploadUrl: r.uploadUrl, headers: r.headers };
      },
    };
    return uploadPhotos(photos, deps);
  };
}

export function useTicketActions(id: string) {
  const { api, apt, userId } = useStaff();
  const qc = useQueryClient();
  const upload = usePhotoUpload('ticket');
  const opts = { onSettled: () => qc.invalidateQueries({ queryKey: workKeys.all(apt) }) };
  return {
    claim: useMutation({ mutationFn: (version: number) => workEndpoints.assignTicket(api, id, { version, assigneeId: userId }), ...opts }),
    transition: useMutation({
      mutationFn: async (v: { version: number; action: TransitionAction; note?: string; photos?: readonly LocalPhoto[] }) => {
        const photos = v.photos?.length ? await upload(v.photos) : [];
        return workEndpoints.transitionTicket(api, id, { version: v.version, action: v.action, ...(v.note ? { note: v.note } : {}), ...(photos.length ? { photos } : {}) });
      },
      ...opts,
    }),
    comment: useMutation({
      mutationFn: async (v: { body: string; visibility: 'public' | 'internal'; photos?: readonly LocalPhoto[] }) => {
        const photos = v.photos?.length ? await upload(v.photos) : [];
        return workEndpoints.commentTicket(api, id, { body: v.body, visibility: v.visibility, ...(photos.length ? { photos } : {}) });
      },
      ...opts,
    }),
    estimate: useMutation({ mutationFn: (v: EstimateInput) => workEndpoints.estimateTicket(api, id, v), ...opts }),
  };
}

export function useTaskActions(id: string) {
  const { api, apt, userId } = useStaff();
  const qc = useQueryClient();
  const upload = usePhotoUpload('task');
  const opts = { onSettled: () => qc.invalidateQueries({ queryKey: workKeys.all(apt) }) };
  return {
    claim: useMutation({ mutationFn: (version: number) => workEndpoints.assignTask(api, id, { version, assigneeId: userId }), ...opts }),
    start: useMutation({ mutationFn: (version: number) => workEndpoints.startTask(api, id, version), ...opts }),
    complete: useMutation({
      mutationFn: async (v: Omit<CompleteTaskInput, 'photos'> & { photos?: readonly LocalPhoto[] }) => {
        const photos = v.photos?.length ? await upload(v.photos) : [];
        return workEndpoints.completeTask(api, id, { version: v.version, checklistResults: v.checklistResults, ...(v.note ? { note: v.note } : {}), ...(photos.length ? { photos } : {}) });
      },
      ...opts,
    }),
    skip: useMutation({ mutationFn: (v: { version: number; reason: string }) => workEndpoints.skipTask(api, id, v), ...opts }),
    estimate: useMutation({ mutationFn: (v: EstimateInput) => workEndpoints.estimateTask(api, id, v), ...opts }),
    openTicket: useMutation({ mutationFn: (v: { idempotencyKey: string; title?: string; priority?: TicketPriority }) => workEndpoints.taskTicket(api, id, v), ...opts }),
  };
}

// ---------------------------------------------------------------------------
// Sayac okuma
// ---------------------------------------------------------------------------

export function useReadingPeriods() {
  const { api, apt, enabled } = useStaff();
  return useQuery({ queryKey: readingKeys.periods(apt), queryFn: ({ signal }) => workEndpoints.readingPeriods(api, signal).then((r) => r.items), enabled });
}

export function useReadingSheet(periodId: string | null) {
  const { api, apt, enabled } = useStaff();
  return useQuery({ queryKey: readingKeys.sheet(apt, periodId ?? ''), queryFn: ({ signal }) => workEndpoints.readingSheet(api, periodId ?? '', signal), enabled: enabled && !!periodId });
}

/** Tek sayac kaydi (+ istege bagli fotograf kaniti); basaridan sonra cizelge tazelenir. */
export function useSaveReading(periodId: string) {
  const { api, rawFetch, apt } = useStaff();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { meterId: string; endIndex: number; note?: string; photo?: LocalPhoto }) => {
      let photoKey: string | undefined;
      if (v.photo) {
        const [key] = await uploadPhotos([v.photo], {
          put: rawFetch,
          request: async (input) => {
            const r = await workEndpoints.readingPhotoUpload(api, periodId, v.meterId, input);
            return { id: r.photoKey, uploadUrl: r.uploadUrl, headers: r.headers };
          },
        });
        photoKey = key;
      }
      const item: ReadingItemInput = { meterId: v.meterId, endIndex: v.endIndex, ...(v.note ? { note: v.note } : {}), ...(photoKey ? { photoKey } : {}) };
      return workEndpoints.saveReadings(api, periodId, [item]);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: readingKeys.all(apt) }),
  });
}
