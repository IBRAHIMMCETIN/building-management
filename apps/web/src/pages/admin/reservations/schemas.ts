import { z } from 'zod';
import type { Facility, FacilityInput } from '@/lib/api/reservations';
import { kurusToInput, parseTRYToKurus } from '@/lib/money';
import { WEEKDAYS } from '@/lib/reservations/model';

/*
 * Ortak alan formu. Sayisal alanlar metin olarak tutulur (bos alan hatasi Turkce), API'ye
 * gonderilirken sayiya cevrilir. Ucret TL metnidir ("150" / "150,50"), kurusa cevrilir.
 * API ile ayni kurallar: saatler :00/:30, kapanis > acilis, en uzun sure dilimin kati.
 */

const DEFAULT_DAY = { enabled: true, open: '09:00', close: '22:00' };
const clockMinutes = (v: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const intText = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${label} tam sayı olmalı`)
    .refine((v) => Number(v) >= min && Number(v) <= max, `${label} ${min}–${max} arasında olmalı`);

export const facilitySchema = z
  .object({
    name: z.string().trim().min(2, 'Ad en az 2 karakter olmalı').max(80, 'Ad en fazla 80 karakter olabilir'),
    description: z.string().trim().max(500, 'Açıklama en fazla 500 karakter olabilir'),
    capacity: intText('Kapasite', 1, 1000),
    days: z.array(z.object({ enabled: z.boolean(), open: z.string(), close: z.string() })).length(7),
    slotMinutes: z.string(),
    maxBookingMinutes: z.string(),
    advanceDays: intText('Rezervasyon penceresi', 0, 180),
    maxActivePerUnit: intText('Aktif rezervasyon sınırı', 1, 20),
    cancelNoticeHours: intText('İptal süresi', 0, 168),
    requiresApproval: z.boolean(),
    blockIds: z.array(z.string()),
    fee: z.string().trim(),
    incomeAccountId: z.string(),
  })
  .superRefine((v, ctx) => {
    const slot = Number(v.slotMinutes);
    const max = Number(v.maxBookingMinutes);
    if (!v.days.some((d) => d.enabled)) ctx.addIssue({ code: 'custom', path: ['days'], message: 'En az bir gün açık olmalı' });
    v.days.forEach((d, i) => {
      if (!d.enabled) return;
      const open = clockMinutes(d.open);
      const close = d.close === '00:00' ? 1440 : clockMinutes(d.close);
      const label = WEEKDAYS[i]?.label ?? '';
      if (Number.isNaN(open) || Number.isNaN(close) || open % 30 || close % 30) {
        ctx.addIssue({ code: 'custom', path: ['days'], message: `${label}: saatler :00 veya :30 olmalı` });
      } else if (close <= open) {
        ctx.addIssue({ code: 'custom', path: ['days'], message: `${label}: kapanış açılıştan sonra olmalı` });
      } else if (close - open < slot) {
        ctx.addIssue({ code: 'custom', path: ['days'], message: `${label}: açık kalma süresi en az bir dilim olmalı` });
      }
    });
    if (!(max >= slot && max % slot === 0)) ctx.addIssue({ code: 'custom', path: ['maxBookingMinutes'], message: 'En uzun süre dilim uzunluğunun katı olmalı' });
    if (v.fee && parseTRYToKurus(v.fee) === null) ctx.addIssue({ code: 'custom', path: ['fee'], message: 'Geçerli bir tutar girin (ör. 150 veya 150,50)' });
  });

export type FacilityForm = z.input<typeof facilitySchema>;
export type FacilityValues = z.output<typeof facilitySchema>;

export const FACILITY_FORM_FIELDS = ['name', 'description', 'capacity', 'days', 'slotMinutes', 'maxBookingMinutes', 'advanceDays', 'maxActivePerUnit', 'cancelNoticeHours', 'fee', 'incomeAccountId'] as const;

/** API alan adi -> form alani (400 + field). */
export const FACILITY_FIELD_MAP = { openingHours: 'days', feeKurus: 'fee' } as const;

export function facilityDefaults(f?: Facility): FacilityForm {
  if (!f) {
    return {
      name: '',
      description: '',
      capacity: '10',
      days: WEEKDAYS.map(() => ({ ...DEFAULT_DAY })),
      slotMinutes: '60',
      maxBookingMinutes: '120',
      advanceDays: '30',
      maxActivePerUnit: '1',
      cancelNoticeHours: '24',
      requiresApproval: false,
      blockIds: [],
      fee: '',
      incomeAccountId: '',
    };
  }
  return {
    name: f.name,
    description: f.description ?? '',
    capacity: String(f.capacity),
    days: WEEKDAYS.map(({ day }) => {
      const w = f.openingHours.find((h) => h.day === day);
      return w ? { enabled: true, open: w.open, close: w.close === '24:00' ? '00:00' : w.close } : { ...DEFAULT_DAY, enabled: false };
    }),
    slotMinutes: String(f.slotMinutes),
    maxBookingMinutes: String(f.maxBookingMinutes),
    advanceDays: String(f.advanceDays),
    maxActivePerUnit: String(f.maxActivePerUnit),
    cancelNoticeHours: String(f.cancelNoticeHours),
    requiresApproval: f.requiresApproval,
    blockIds: f.blockIds ?? [],
    fee: f.feeKurus ? kurusToInput(f.feeKurus) : '',
    incomeAccountId: f.incomeAccountId ?? '',
  };
}

/** Form -> API. Kapanis "00:00" gece yarisi demektir ("24:00"). Bos aciklama / blok / gelir hesabi temizlenir. */
export function toFacilityInput(v: FacilityValues): FacilityInput {
  const feeKurus = v.fee ? (parseTRYToKurus(v.fee) ?? 0) : 0;
  return {
    name: v.name,
    description: v.description || null,
    capacity: Number(v.capacity),
    openingHours: v.days.flatMap((d, i) => (d.enabled ? [{ day: i + 1, open: d.open, close: d.close === '00:00' ? '24:00' : d.close }] : [])),
    slotMinutes: Number(v.slotMinutes),
    maxBookingMinutes: Number(v.maxBookingMinutes),
    advanceDays: Number(v.advanceDays),
    maxActivePerUnit: Number(v.maxActivePerUnit),
    cancelNoticeHours: Number(v.cancelNoticeHours),
    requiresApproval: v.requiresApproval,
    blockIds: v.blockIds.length ? v.blockIds : null,
    feeKurus,
    incomeAccountId: feeKurus && v.incomeAccountId ? v.incomeAccountId : null,
  };
}

/** Secilen dilim uzunluguna gore en uzun sure secenekleri (en fazla 12 saat). */
export function maxDurationChoices(slotMinutes: number): number[] {
  const out: number[] = [];
  for (let m = slotMinutes; m <= 720; m += slotMinutes) out.push(m);
  return out;
}
