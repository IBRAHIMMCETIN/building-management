import { z } from 'zod';
import type { Equipment, EquipmentInput } from '@/lib/api/equipment';
import { EQUIPMENT_CATEGORIES, INSPECTION_LABELS } from '@/lib/equipment/model';

/*
 * Ekipman formu. Tum alanlar metin olarak tutulur; bos alan API'ye `null` gider (duzenlemede
 * "temizle"). API ile ayni kurallar: ad 2-120, tarih YYYY-AA-GG, garanti bitisi kurulumdan,
 * sonraki kontrol son kontrolden once olamaz, telefon / e-posta bicimi.
 */

const date = z.string().trim().refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Tarih seçin');
const PHONE = /^[0-9+()\s-]{5,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const equipmentFormSchema = z
  .object({
    name: z.string().trim().min(2, 'Ad en az 2 karakter olmalı').max(120, 'Ad en fazla 120 karakter olabilir'),
    category: z.enum(EQUIPMENT_CATEGORIES),
    blockId: z.string(),
    location: z.string().trim().max(120, 'Konum en fazla 120 karakter olabilir'),
    brand: z.string().trim().max(80, 'Marka en fazla 80 karakter olabilir'),
    model: z.string().trim().max(80, 'Model en fazla 80 karakter olabilir'),
    serialNumber: z.string().trim().max(80, 'Seri no en fazla 80 karakter olabilir'),
    installDate: date,
    warrantyEndDate: date,
    supplierAccountId: z.string(),
    serviceName: z.string().trim().max(120, 'Firma adı en fazla 120 karakter olabilir'),
    servicePhone: z.string().trim().refine((v) => v === '' || PHONE.test(v), 'Geçerli bir telefon numarası girin'),
    serviceEmail: z.string().trim().refine((v) => v === '' || EMAIL.test(v), 'Geçerli bir e-posta adresi girin'),
    serviceContractEndDate: date,
    lastInspectionDate: date,
    nextInspectionDate: date,
    inspectionLabel: z.union([z.enum(INSPECTION_LABELS), z.literal('')]),
    notes: z.string().trim().max(2000, 'Not en fazla 2000 karakter olabilir'),
  })
  .superRefine((v, ctx) => {
    if (v.installDate && v.warrantyEndDate && v.warrantyEndDate < v.installDate) {
      ctx.addIssue({ code: 'custom', path: ['warrantyEndDate'], message: 'Garanti bitişi kurulum tarihinden önce olamaz' });
    }
    if (v.lastInspectionDate && v.nextInspectionDate && v.nextInspectionDate < v.lastInspectionDate) {
      ctx.addIssue({ code: 'custom', path: ['nextInspectionDate'], message: 'Sonraki kontrol son kontrolden önce olamaz' });
    }
    if (v.serviceName && v.serviceName.length < 2) ctx.addIssue({ code: 'custom', path: ['serviceName'], message: 'Firma adı en az 2 karakter olmalı' });
  });

export type EquipmentForm = z.input<typeof equipmentFormSchema>;
export type EquipmentValues = z.output<typeof equipmentFormSchema>;

export const EQUIPMENT_FORM_FIELDS = [
  'name',
  'category',
  'blockId',
  'location',
  'brand',
  'model',
  'serialNumber',
  'installDate',
  'warrantyEndDate',
  'supplierAccountId',
  'serviceName',
  'servicePhone',
  'serviceEmail',
  'serviceContractEndDate',
  'lastInspectionDate',
  'nextInspectionDate',
  'inspectionLabel',
  'notes',
] as const;

/** API alan adi -> form alani (400 + field). */
export const EQUIPMENT_FIELD_MAP = {
  'serviceCompany.supplierAccountId': 'supplierAccountId',
  'serviceCompany.name': 'serviceName',
  'serviceCompany.phone': 'servicePhone',
  'serviceCompany.email': 'serviceEmail',
} as const;

export function equipmentDefaults(e?: Equipment): EquipmentForm {
  return {
    name: e?.name ?? '',
    category: e?.category ?? 'elevator',
    blockId: e?.blockId ?? '',
    location: e?.location ?? '',
    brand: e?.brand ?? '',
    model: e?.model ?? '',
    serialNumber: e?.serialNumber ?? '',
    installDate: e?.installDate ?? '',
    warrantyEndDate: e?.warrantyEndDate ?? '',
    supplierAccountId: e?.serviceCompany?.supplierAccountId ?? '',
    serviceName: e?.serviceCompany?.name ?? '',
    servicePhone: e?.serviceCompany?.phone ?? '',
    serviceEmail: e?.serviceCompany?.email ?? '',
    serviceContractEndDate: e?.serviceContractEndDate ?? '',
    lastInspectionDate: e?.lastInspectionDate ?? '',
    nextInspectionDate: e?.nextInspectionDate ?? '',
    inspectionLabel: e?.inspectionLabel ?? '',
    notes: e?.notes ?? '',
  };
}

/** Form -> API. Bos alan `null` (kaydi temizler); servis firmasi bilgisi tamamen bossa `null`. */
export function toEquipmentInput(v: EquipmentValues): EquipmentInput {
  const orNull = (s: string) => s || null;
  const service = { supplierAccountId: orNull(v.supplierAccountId), name: orNull(v.serviceName), phone: orNull(v.servicePhone), email: orNull(v.serviceEmail) };
  return {
    name: v.name,
    category: v.category,
    blockId: orNull(v.blockId),
    location: orNull(v.location),
    brand: orNull(v.brand),
    model: orNull(v.model),
    serialNumber: orNull(v.serialNumber),
    installDate: orNull(v.installDate),
    warrantyEndDate: orNull(v.warrantyEndDate),
    serviceCompany: Object.values(service).some(Boolean) ? service : null,
    serviceContractEndDate: orNull(v.serviceContractEndDate),
    lastInspectionDate: orNull(v.lastInspectionDate),
    nextInspectionDate: orNull(v.nextInspectionDate),
    inspectionLabel: v.inspectionLabel || null,
    notes: orNull(v.notes),
  };
}
