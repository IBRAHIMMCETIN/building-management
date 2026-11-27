import { z } from 'zod';
import { type CreatePollInput, MAX_OPTIONS, MIN_OPTIONS, POLL_AUDIENCES, POLL_WEIGHTINGS, type Poll, type UpdatePollInput } from '@/lib/api/pollModel';
import { isoToIstanbulLocal, istanbulLocalToIso, nowIstanbulLocal } from '@/lib/dates';

/*
 * Oylama formu. Zamanlar <input type="datetime-local"> degeri ("2026-11-10T09:00", Istanbul
 * saati) olarak tutulur ve API'ye saat dilimli ISO olarak gider; ayni bicimdeki iki deger metin
 * olarak karsilastirilabilir (duyuru formuyla ayni kural).
 */

export const TIMINGS = ['now', 'scheduled'] as const;

export function makePollSchema(now: () => Date = () => new Date()) {
  return z
    .object({
      title: z.string().trim().min(1, 'Soru / başlık zorunludur').max(150, 'Başlık en fazla 150 karakter olabilir'),
      description: z.string().trim().max(2000, 'Açıklama en fazla 2000 karakter olabilir'),
      options: z.array(z.string()),
      audience: z.enum(POLL_AUDIENCES),
      weighting: z.enum(POLL_WEIGHTINGS),
      secret: z.boolean(),
      resultsVisibleBeforeClose: z.boolean(),
      timing: z.enum(TIMINGS),
      opensAt: z.string(),
      closesAt: z.string(),
    })
    .superRefine((v, ctx) => {
      const labels = v.options.map((o) => o.trim());
      if (labels.some((l) => !l)) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Boş seçenek bırakmayın' });
      else if (labels.some((l) => l.length > 200)) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Seçenek en fazla 200 karakter olabilir' });
      else if (labels.length < MIN_OPTIONS || labels.length > MAX_OPTIONS) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: `En az ${MIN_OPTIONS}, en fazla ${MAX_OPTIONS} seçenek girin` });
      } else if (new Set(labels.map((l) => l.toLocaleLowerCase('tr'))).size !== labels.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Aynı seçenek iki kez yazılmış' });
      }
      if (v.secret && v.resultsVisibleBeforeClose) {
        ctx.addIssue({ code: 'custom', path: ['resultsVisibleBeforeClose'], message: 'Gizli oylamada sonuçlar oylama bitmeden gösterilemez' });
      }
      const current = nowIstanbulLocal(now());
      if (v.timing === 'scheduled') {
        if (!v.opensAt) {
          ctx.addIssue({ code: 'custom', path: ['opensAt'], message: 'Başlangıç zamanını seçin' });
          return;
        }
        if (v.opensAt <= current) ctx.addIssue({ code: 'custom', path: ['opensAt'], message: 'Planlı başlangıç ileri bir tarih olmalıdır' });
      }
      if (!v.closesAt) {
        ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'Bitiş zamanını seçin' });
        return;
      }
      const start = v.timing === 'scheduled' && v.opensAt ? v.opensAt : current;
      if (v.closesAt <= start) ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'Bitiş zamanı başlangıçtan sonra olmalıdır' });
    });
}

export const pollFormSchema = makePollSchema();
export type PollForm = z.input<typeof pollFormSchema>;
export type PollValues = z.output<typeof pollFormSchema>;

export const FORM_FIELDS = ['title', 'description', 'options', 'audience', 'weighting', 'resultsVisibleBeforeClose', 'opensAt', 'closesAt'] as const;

/** Varsayilanlar: kat malikleri, bolum basina bir oy, gizli oylama, ara sonuc kapali. */
export function formDefaults(p?: Poll, now: Date = new Date()): PollForm {
  if (!p) {
    return {
      title: '',
      description: '',
      options: ['', ''],
      audience: 'owners',
      weighting: 'per_unit',
      secret: true,
      resultsVisibleBeforeClose: false,
      timing: 'now',
      opensAt: '',
      closesAt: '',
    };
  }
  const scheduled = Date.parse(p.opensAt) > now.getTime() + 60_000;
  return {
    title: p.title,
    description: p.description ?? '',
    options: p.options.map((o) => o.label),
    audience: p.audience,
    weighting: p.weighting,
    secret: p.secret,
    resultsVisibleBeforeClose: p.resultsVisibleBeforeClose,
    timing: scheduled ? 'scheduled' : 'now',
    opensAt: scheduled ? isoToIstanbulLocal(p.opensAt) : '',
    closesAt: isoToIstanbulLocal(p.closesAt),
  };
}

const common = (v: PollValues) => ({
  title: v.title,
  options: v.options.map((o) => o.trim()),
  audience: v.audience,
  weighting: v.weighting,
  secret: v.secret,
  resultsVisibleBeforeClose: v.secret ? false : v.resultsVisibleBeforeClose,
  closesAt: istanbulLocalToIso(v.closesAt),
});

/** Bos aciklama gonderilmez; "hemen" secilirse baslangic yayin ani olur. */
export function toCreateInput(v: PollValues): CreatePollInput {
  return {
    ...common(v),
    description: v.description || undefined,
    opensAt: v.timing === 'scheduled' ? istanbulLocalToIso(v.opensAt) : undefined,
  };
}

/** Guncellemede bos aciklama `null` ile temizlenir; "hemen" -> yayin ani (`opensAt: null`). */
export function toUpdateInput(v: PollValues, version: number): UpdatePollInput {
  return {
    ...common(v),
    version,
    description: v.description || null,
    opensAt: v.timing === 'scheduled' ? istanbulLocalToIso(v.opensAt) : null,
  };
}

/** Erken kapatma gerekcesi (API: 3-500 karakter). */
export const closeReasonSchema = z.object({
  reason: z.string().trim().min(3, 'Kapatma gerekçesi en az 3 karakter olmalıdır').max(500, 'Gerekçe en fazla 500 karakter olabilir'),
});
