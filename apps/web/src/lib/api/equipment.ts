import { z } from 'zod';
import { DOCUMENT_KINDS, EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES, EXPIRY_KINDS, type EquipmentCategory, type EquipmentDocumentKind, INSPECTION_LABELS, type InspectionLabel } from '@/lib/equipment/model';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import { ApiError } from './errors';

/*
 * Ariza & bakim v2 - ekipman sicili (apps/api/src/modules/equipment):
 *   /api/equipment   yonetim yazar; denetci ve bina gorevlisi okur (gorevli masraf ve servis
 *                    sozlesmesi belgesini gormez). Silme yok: durum `retired`, belge `archived`.
 * Belgeler private S3: imzali PUT ile yuklenir, imzali GET (5 dk) ile acilir. Tutarlar kurus.
 */

const expiryItem = z.object({
  equipmentId: z.string(),
  name: z.string(),
  kind: z.enum(EXPIRY_KINDS),
  date: z.string(),
  expired: z.boolean(),
  daysLeft: z.number().int(),
});
export type ExpiryItem = z.infer<typeof expiryItem>;

const equipmentDocument = z.object({
  documentId: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  validUntil: z.string().optional(),
  uploadedAt: z.string(),
  uploadedBy: z.string(),
  status: z.enum(['active', 'archived']),
  archivedAt: z.string().optional(),
});
export type EquipmentDocument = z.infer<typeof equipmentDocument>;

export const equipmentSchema = z.object({
  equipmentId: z.string(),
  name: z.string(),
  category: z.enum(EQUIPMENT_CATEGORIES),
  blockId: z.string().optional(),
  location: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  installDate: z.string().optional(),
  warrantyEndDate: z.string().optional(),
  serviceCompany: z.object({ supplierAccountId: z.string().optional(), name: z.string().optional(), phone: z.string().optional(), email: z.string().optional() }).optional(),
  serviceContractEndDate: z.string().optional(),
  lastInspectionDate: z.string().optional(),
  nextInspectionDate: z.string().optional(),
  inspectionLabel: z.enum(INSPECTION_LABELS).optional(),
  notes: z.string().optional(),
  status: z.enum(EQUIPMENT_STATUSES),
  statusNote: z.string().optional(),
  documents: z.array(equipmentDocument).default([]),
  documentCount: z.number().int().default(0),
  expiry: z.array(expiryItem).default([]),
  canEdit: z.boolean().default(false),
  updatedAt: z.string().optional(),
  version: z.number().int(),
});
export type Equipment = z.infer<typeof equipmentSchema>;

export const equipmentListSchema = z.object({
  items: z.array(equipmentSchema),
  total: z.number().int(),
  nextCursor: z.string().optional(),
  expiringCount: z.number().int().default(0),
});

const costItem = z.object({ date: z.string(), amount: z.number().int(), description: z.string(), expenseId: z.string(), reversed: z.boolean() });

export const historyItemSchema = z.object({
  kind: z.enum(['ticket', 'maintenance']),
  id: z.string(),
  date: z.string(),
  title: z.string(),
  status: z.string(),
  number: z.string().optional(),
  dueDate: z.string().optional(),
  upcoming: z.boolean().optional(),
  overdue: z.boolean().optional(),
  estimate: z.number().int().optional(),
  cost: z.number().int().optional(),
  costItems: z.array(costItem).optional(),
});
export type HistoryItem = z.infer<typeof historyItemSchema>;

export const historySchema = z.object({
  equipmentId: z.string(),
  years: z.number().int().optional(),
  name: z.string(),
  items: z.array(historyItemSchema),
  counts: z.object({ tickets: z.number().int(), openTickets: z.number().int(), maintenance: z.number().int(), maintenanceDone: z.number().int() }),
  templates: z.array(z.object({ templateId: z.string(), name: z.string() }).loose()).default([]),
  /** Yalnizca yonetim ve denetci. */
  costs: z
    .object({
      total: z.number().int(),
      ticket: z.number().int(),
      maintenance: z.number().int(),
      byYear: z.array(z.object({ year: z.string(), total: z.number().int(), ticket: z.number().int(), maintenance: z.number().int(), count: z.number().int() })),
    })
    .optional(),
});
export type EquipmentHistory = z.infer<typeof historySchema>;

const uploadSchema = z.object({ uploadId: z.string(), fileName: z.string(), uploadUrl: z.string(), headers: z.record(z.string(), z.string()).default({}) });

export type EquipmentInput = {
  name?: string;
  category?: EquipmentCategory;
  blockId?: string | null;
  location?: string | null;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  installDate?: string | null;
  warrantyEndDate?: string | null;
  serviceCompany?: { supplierAccountId?: string | null; name?: string | null; phone?: string | null; email?: string | null } | null;
  serviceContractEndDate?: string | null;
  lastInspectionDate?: string | null;
  nextInspectionDate?: string | null;
  inspectionLabel?: InspectionLabel | null;
  notes?: string | null;
};

export type EquipmentListQuery = {
  q?: string;
  category?: string;
  status?: string;
  blockId?: string;
  warrantyWithin?: string;
  expiring?: 'true';
  /** Virgulle en fazla 100 kimlik (ad cozumleme; durumdan bagimsiz `status: 'all'` ile). */
  ids?: string;
  cursor?: string;
  limit?: number;
};

const enc = encodeURIComponent;
const E = '/api/equipment';
const one = z.object({ equipment: equipmentSchema });

export const equipmentApi = {
  list: (q: EquipmentListQuery = {}, signal?: AbortSignal) => apiClient.get(E, { query: q, signal, schema: equipmentListSchema }),
  expiring: (days = 30, signal?: AbortSignal) => apiClient.get(`${E}/expiring`, { query: { days }, signal, schema: z.object({ days: z.number().int(), items: z.array(expiryItem) }) }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${E}/${enc(id)}`, { signal, schema: one }),
  history: (id: string, signal?: AbortSignal) => apiClient.get(`${E}/${enc(id)}/history`, { signal, schema: historySchema }),
  create: (input: EquipmentInput) => apiClient.post(E, input, { schema: one }),
  update: (id: string, input: EquipmentInput & { version: number }) => apiClient.put(`${E}/${enc(id)}`, input, { schema: one }),
  setStatus: (id: string, input: { version: number; status: Equipment['status']; note?: string }) => apiClient.post(`${E}/${enc(id)}/status`, input, { schema: one.extend({ linkedTemplates: z.array(z.object({ templateId: z.string(), name: z.string() })).default([]), warning: z.string().optional() }) }),
  document: (id: string, documentId: string) => apiClient.get(`${E}/${enc(id)}/documents/${enc(documentId)}`, { schema: signedDownloadSchema }),
  archiveDocument: (id: string, documentId: string, version: number) =>
    apiClient.post(`${E}/${enc(id)}/documents/${enc(documentId)}/archive`, { version }, { schema: one }),
  /**
   * Belgeyi tarayicidan dogrudan S3'e yukler (API'den gecmez), sonra ekipmana surumle ekler.
   * Yukleme anahtari kullaniciya baglidir; ekleme yapilmazsa gecici dosya 1 gunde silinir.
   */
  async addDocument(id: string, input: { version: number; file: File; kind: EquipmentDocumentKind; title?: string; validUntil?: string }) {
    const upload = await apiClient.post(`${E}/documents/upload-url`, { fileName: input.file.name, contentType: input.file.type, size: input.file.size }, { schema: uploadSchema });
    let res: Response;
    try {
      res = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: input.file });
    } catch {
      throw new ApiError(0, { error: 'upload_failed', message: 'Belge yüklenemedi: bağlantı hatası.' });
    }
    if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Belge yüklenemedi (${res.status}).` });
    return apiClient.post(
      `${E}/${enc(id)}/documents`,
      {
        version: input.version,
        uploadId: upload.uploadId,
        fileName: upload.fileName,
        kind: input.kind,
        ...(input.title ? { title: input.title } : {}),
        ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      },
      { schema: one.extend({ document: equipmentDocument }) },
    );
  },
};
