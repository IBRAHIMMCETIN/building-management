import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CreateMeterInput,
  type CreatePeriodInput,
  type ImportRowInput,
  type ReadingItemInput,
  type RetireInput,
  type SwapInput,
  type TemplateInput,
  metersApi,
} from '@/lib/api/meters';
import type { Role } from '@/types/roles';
import type { BulkJob } from '@/lib/api/bulkJobs';
import { useAuth } from './useAuth';
import { financeKeys } from './useFinance';

/** API rol listeleriyle ayni (apps/api/src/modules/meters/common.ts). */
export const METER_MANAGE: readonly Role[] = ['apartment_manager', 'management_company'];
export const METER_READ: readonly Role[] = [...METER_MANAGE, 'observer'];
export const READING_WRITE: readonly Role[] = [...METER_MANAGE, 'building_staff'];
export const READING_READ: readonly Role[] = [...METER_READ, 'building_staff'];

export function useMeterPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  const has = (list: readonly Role[]) => !!role && list.includes(role);
  return {
    apartmentId: user?.apartmentId ?? '',
    canRead: has(METER_READ),
    canManage: has(METER_MANAGE),
    canReadReadings: has(READING_READ),
    canWriteReadings: has(READING_WRITE),
  };
}

/** Anahtarlar apartmana gore ayrilir (baglam degisince baska apartmanin verisi gorunmez). */
export const meterKeys = {
  all: (apt: string) => ['apartment', apt, 'meters'] as const,
  meters: (apt: string, q: object) => ['apartment', apt, 'meters', 'list', q] as const,
  meter: (apt: string, id: string) => ['apartment', apt, 'meters', 'meter', id] as const,
  templates: (apt: string, archived: boolean) => ['apartment', apt, 'meters', 'templates', archived] as const,
  presets: (apt: string) => ['apartment', apt, 'meters', 'presets'] as const,
  expenses: (apt: string) => ['apartment', apt, 'meters', 'expenses'] as const,
  periods: (apt: string, status: string) => ['apartment', apt, 'meters', 'periods', status] as const,
  period: (apt: string, id: string) => ['apartment', apt, 'meters', 'period', id] as const,
  sheet: (apt: string, id: string) => ['apartment', apt, 'meters', 'sheet', id] as const,
  openReading: (apt: string) => ['apartment', apt, 'meters', 'reading-periods'] as const,
  lines: (apt: string, id: string) => ['apartment', apt, 'meters', 'lines', id] as const,
  reversePreview: (apt: string, id: string) => ['apartment', apt, 'meters', 'reverse-preview', id] as const,
  consumption: (apt: string, unitId: string) => ['apartment', apt, 'portal', 'consumption', unitId] as const,
};

function useInvalidate() {
  const qc = useQueryClient();
  const { apartmentId } = useMeterPermissions();
  return () => qc.invalidateQueries({ queryKey: meterKeys.all(apartmentId) });
}

// --- Sicil -----------------------------------------------------------------

export function useMeters(q: { unitId?: string; status?: string; kind?: string } = {}) {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.meters(apartmentId, q),
    queryFn: ({ signal }) => metersApi.listMeters(q, signal).then((r) => r.items),
    enabled: !!apartmentId && canRead,
  });
}

export function useMeterDetail(meterId: string | null) {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.meter(apartmentId, meterId ?? ''),
    queryFn: ({ signal }) => metersApi.getMeter(meterId ?? '', signal),
    enabled: !!apartmentId && canRead && !!meterId,
  });
}

export function useCreateMeter() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreateMeterInput) => metersApi.createMeter(input), onSuccess: invalidate });
}

export function useSwapMeter() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: SwapInput) => metersApi.createSwap(input), onSuccess: invalidate });
}

export function useRetireMeter() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ meterId, input }: { meterId: string; input: RetireInput }) => metersApi.retireMeter(meterId, input),
    onSuccess: invalidate,
  });
}

// --- Sablon ----------------------------------------------------------------

export function useTemplates(includeArchived = false) {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.templates(apartmentId, includeArchived),
    queryFn: ({ signal }) => metersApi.listTemplates(includeArchived, signal).then((r) => r.items),
    enabled: !!apartmentId && canRead,
  });
}

export function useTemplatePresets() {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.presets(apartmentId),
    queryFn: ({ signal }) => metersApi.presets(signal).then((r) => r.items),
    enabled: !!apartmentId && canRead,
    staleTime: 5 * 60_000,
  });
}

export function useSaveTemplate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ templateId, input }: { templateId?: string; input: TemplateInput & { version?: number } }) =>
      templateId ? metersApi.updateTemplate(templateId, { ...input, version: input.version ?? 0 }) : metersApi.createTemplate(input),
    onSuccess: invalidate,
  });
}

export function useTemplateAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ action, templateId, version }: { action: 'default' | 'archive'; templateId: string; version: number }) =>
      action === 'default' ? metersApi.setDefaultTemplate(templateId) : metersApi.archiveTemplate(templateId, version),
    onSuccess: invalidate,
  });
}

// --- Donem -----------------------------------------------------------------

export function useExpenseOptions(enabled = true) {
  const { apartmentId, canManage } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.expenses(apartmentId),
    queryFn: ({ signal }) => metersApi.expenseOptions(signal).then((r) => r.items),
    enabled: !!apartmentId && canManage && enabled,
  });
}

export function usePeriods(status = 'all') {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.periods(apartmentId, status),
    queryFn: ({ signal }) => metersApi.listPeriods(status, signal).then((r) => r.items),
    enabled: !!apartmentId && canRead,
  });
}

export function usePeriod(periodId: string | null) {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.period(apartmentId, periodId ?? ''),
    queryFn: ({ signal }) => metersApi.getPeriod(periodId ?? '', signal),
    enabled: !!apartmentId && canRead && !!periodId,
  });
}

export function useCreatePeriod() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: CreatePeriodInput) => metersApi.createPeriod(input), onSuccess: invalidate });
}

export function useCancelPeriod() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ periodId, version, reason }: { periodId: string; version: number; reason: string }) => metersApi.cancelPeriod(periodId, version, reason),
    onSuccess: invalidate,
  });
}

/** Onizleme yazar (donem `calculated` olur) ama defter degismez; sonuc bilesende tutulur. */
export function useCalculatePeriod() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (periodId: string) => metersApi.calculate(periodId), onSuccess: invalidate });
}

export function useApprovePeriod() {
  const qc = useQueryClient();
  const { apartmentId } = useMeterPermissions();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ periodId, calcHash }: { periodId: string; calcHash: string }) => metersApi.approve(periodId, calcHash),
    onSettled: () => {
      invalidate();
      // Tahakkuk deftere yazildi: finans ekranlari da tazelenir.
      qc.invalidateQueries({ queryKey: financeKeys.all(apartmentId) });
    },
  });
}

/**
 * Buyuk donem onayinin arka plan isi: onay karti ile "tahakkuk suruyor" karti arasinda paylasilir
 * (donem `calculated` -> `posting` -> `posted` gecerken kart degisse de ilerleme kaybolmaz).
 */
/**
 * Donemin arka plan isi (buyuk donem onayi / geri almasi). Is 202 yanitiyla eklenir; donem
 * `posting` / `reversing` / `posted` durumundaysa (sayfa yenilendi, baska sekmeden baslatildi) sunucudan
 * `GET /periods/:id/job` ile bulunur ve ilerleme kaldigi yerden izlenir.
 */
export function usePeriodJob(periodId: string, status?: string) {
  const qc = useQueryClient();
  const { apartmentId, canRead } = useMeterPermissions();
  const key = ['bulk-job', 'meter-period', apartmentId, periodId] as const;
  // `posted`: baslatilmis ama worker'in henuz almadigi geri alma isi de bulunur (P1-c).
  const active = status === 'posting' || status === 'reversing' || status === 'posted';
  const { data } = useQuery<BulkJob | null>({
    queryKey: key,
    queryFn: async ({ signal }) => (await metersApi.periodJob(periodId, signal)).job,
    enabled: active && !!apartmentId && !!periodId && canRead,
    initialData: null,
    initialDataUpdatedAt: 0,
    staleTime: 30_000,
  });
  const set = (job: BulkJob | null) => qc.setQueryData(key, job);
  return [data ?? null, set] as const;
}

/**
 * Performans: taslak / hesaplanmis buyuk donemin onizleme isi (`meter_calculation`). Sayfa yenilense
 * de suren is (veya donemin guncel hesabini uretmis son is) `/job` ile bulunur; onay isinden ayri tutulur.
 */
export function useCalculationJob(periodId: string, status: string) {
  const qc = useQueryClient();
  const { apartmentId, canManage } = useMeterPermissions();
  const key = ['bulk-job', 'meter-calc', apartmentId, periodId] as const;
  const { data } = useQuery<BulkJob | null>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const job = (await metersApi.periodJob(periodId, signal)).job;
      return job?.kind === 'meter_calculation' ? job : null;
    },
    enabled: (status === 'draft' || status === 'calculated') && !!apartmentId && !!periodId && canManage,
    initialData: null,
    initialDataUpdatedAt: 0,
    staleTime: 30_000,
  });
  const set = (job: BulkJob | null) => qc.setQueryData(key, job);
  return [data ?? null, set] as const;
}

/** Biten onizleme isinin sonucu (senkron onizlemeyle ayni govde). */
export function useCalculationResult() {
  return useMutation({ mutationFn: ({ periodId, jobId }: { periodId: string; jobId: string }) => metersApi.calculation(periodId, jobId) });
}

/** Arka plan isi bitince sayac ve finans ekranlari tazelenir. */
export function useRefreshAfterPosting() {
  const qc = useQueryClient();
  const { apartmentId } = useMeterPermissions();
  return () => {
    void qc.invalidateQueries({ queryKey: meterKeys.all(apartmentId) });
    void qc.invalidateQueries({ queryKey: financeKeys.all(apartmentId) });
  };
}

export function usePeriodLines(periodId: string | null, enabled = true) {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.lines(apartmentId, periodId ?? ''),
    queryFn: ({ signal }) => metersApi.lines(periodId ?? '', signal),
    enabled: !!apartmentId && canRead && !!periodId && enabled,
  });
}

export function useReversePreview(periodId: string | null, enabled = true) {
  const { apartmentId, canRead } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.reversePreview(apartmentId, periodId ?? ''),
    queryFn: ({ signal }) => metersApi.reversePreview(periodId ?? '', signal),
    enabled: !!apartmentId && canRead && !!periodId && enabled,
  });
}

export function useReversePeriod() {
  const qc = useQueryClient();
  const { apartmentId } = useMeterPermissions();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ periodId, ...input }: { periodId: string; idempotencyKey: string; reason: string; notify?: boolean }) => metersApi.reverse(periodId, input),
    onSettled: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: financeKeys.all(apartmentId) });
    },
  });
}

export function useCreateCorrection() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (periodId: string) => metersApi.correction(periodId), onSuccess: invalidate });
}

// --- Okuma -----------------------------------------------------------------

export function useOpenReadingPeriods() {
  const { apartmentId, canReadReadings } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.openReading(apartmentId),
    queryFn: ({ signal }) => metersApi.openReadingPeriods(signal).then((r) => r.items),
    enabled: !!apartmentId && canReadReadings,
  });
}

export function useReadingSheet(periodId: string | null) {
  const { apartmentId, canReadReadings } = useMeterPermissions();
  return useQuery({
    queryKey: meterKeys.sheet(apartmentId, periodId ?? ''),
    queryFn: ({ signal }) => metersApi.sheet(periodId ?? '', signal),
    enabled: !!apartmentId && canReadReadings && !!periodId,
  });
}

export function useSaveReadings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ periodId, items }: { periodId: string; items: ReadingItemInput[] }) => metersApi.saveReadings(periodId, items),
    onSuccess: invalidate,
  });
}

export function useImportReadings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ periodId, rows, dryRun }: { periodId: string; rows: ImportRowInput[]; dryRun: boolean }) => metersApi.importReadings(periodId, rows, dryRun),
    onSuccess: (_data, vars) => {
      if (!vars.dryRun) invalidate();
    },
  });
}

// --- Sakin portali ---------------------------------------------------------

export function useMyConsumption(unitId: string | undefined) {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  return useQuery({
    queryKey: meterKeys.consumption(apt, unitId ?? ''),
    queryFn: ({ signal }) => metersApi.myConsumption(unitId ?? '', signal),
    enabled: !!apt && user?.role === 'resident' && !!unitId,
  });
}
