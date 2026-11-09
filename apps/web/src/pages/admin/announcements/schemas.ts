import { z } from 'zod';
import type { Announcement, CreateAnnouncementInput, UpdateAnnouncementInput } from '@/lib/api/announcements';
import { isoToIstanbulLocal, istanbulLocalToIso, nowIstanbulLocal } from '@/lib/dates';

/*
 * Duyuru formu. Zamanlar <input type="datetime-local"> degeri ("2026-11-10T09:00", Istanbul
 * saati) olarak tutulur ve API'ye saat dilimli ISO olarak gider. Ayni bicimdeki iki deger
 * metin olarak karsilastirilabilir.
 */

export const TIMINGS = ['now', 'scheduled'] as const;

export function makeAnnouncementSchema(now: () => Date = () => new Date()) {
  return z
    .object({
      title: z.string().trim().min(1, 'Başlık zorunludur').max(150, 'Başlık en fazla 150 karakter olabilir'),
      body: z.string().trim().min(1, 'Duyuru metni zorunludur').max(5000, 'Metin en fazla 5000 karakter olabilir'),
      blockIds: z.array(z.string()),
      timing: z.enum(TIMINGS),
      publishAt: z.string(),
      expiresAt: z.string(),
    })
    .superRefine((v, ctx) => {
      const current = nowIstanbulLocal(now());
      if (v.timing === 'scheduled') {
        if (!v.publishAt) {
          ctx.addIssue({ code: 'custom', path: ['publishAt'], message: 'Yayın zamanını seçin' });
          return;
        }
        if (v.publishAt <= current) {
          ctx.addIssue({ code: 'custom', path: ['publishAt'], message: 'Planlı yayın zamanı ileri bir tarih olmalıdır' });
        }
      }
      if (v.expiresAt) {
        const start = v.timing === 'scheduled' && v.publishAt ? v.publishAt : current;
        if (v.expiresAt <= start) {
          ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Bitiş zamanı yayın zamanından sonra olmalıdır' });
        }
      }
    });
}

export const announcementSchema = makeAnnouncementSchema();
export type AnnouncementForm = z.input<typeof announcementSchema>;
export type AnnouncementValues = z.output<typeof announcementSchema>;

export const FORM_FIELDS = ['title', 'body', 'blockIds', 'publishAt', 'expiresAt'] as const;

/** Duzenlenen taslagin yayin zamani 1 dakikadan daha ilerideyse "planli" sayilir. */
export function formDefaults(a?: Announcement, now: Date = new Date()): AnnouncementForm {
  if (!a) return { title: '', body: '', blockIds: [], timing: 'now', publishAt: '', expiresAt: '' };
  const scheduled = Date.parse(a.publishAt) > now.getTime() + 60_000;
  return {
    title: a.title,
    body: a.body,
    blockIds: a.blockIds ?? [],
    timing: scheduled ? 'scheduled' : 'now',
    publishAt: scheduled ? isoToIstanbulLocal(a.publishAt) : '',
    expiresAt: a.expiresAt ? isoToIstanbulLocal(a.expiresAt) : '',
  };
}

/** Bos alanlar gonderilmez; "hemen" secilirse yayin zamani onay ani olur. */
export function toCreateInput(v: AnnouncementValues): CreateAnnouncementInput {
  return {
    title: v.title,
    body: v.body,
    blockIds: v.blockIds.length ? v.blockIds : undefined,
    publishAt: v.timing === 'scheduled' ? istanbulLocalToIso(v.publishAt) : undefined,
    expiresAt: v.expiresAt ? istanbulLocalToIso(v.expiresAt) : undefined,
  };
}

/** Guncellemede bos alan `null` ile temizlenir; "hemen" -> simdi (onayda zaten simdiye cekilir). */
export function toUpdateInput(v: AnnouncementValues, version: number, now: Date = new Date()): UpdateAnnouncementInput {
  return {
    version,
    title: v.title,
    body: v.body,
    blockIds: v.blockIds.length ? v.blockIds : null,
    publishAt: v.timing === 'scheduled' ? istanbulLocalToIso(v.publishAt) : now.toISOString(),
    expiresAt: v.expiresAt ? istanbulLocalToIso(v.expiresAt) : null,
  };
}
