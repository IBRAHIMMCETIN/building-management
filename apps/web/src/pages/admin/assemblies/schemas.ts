import { z } from 'zod';
import { ASSEMBLY_KINDS, type Assembly, type AssemblyInput, MAX_AGENDA_ITEMS, SECOND_MEETING_MAX_DAYS } from '@/lib/api/assemblyModel';
import { isoToIstanbulLocal, istanbulLocalToIso } from '@/lib/dates';

/** Genel kurul formu: tarih <input type="datetime-local"> (Istanbul), gundem satirlari, ilk toplanti secimi. */
export function makeAssemblyFormSchema(firstMeetings: readonly Pick<Assembly, 'assemblyId' | 'scheduledAt'>[] = []) {
  return z
    .object({
      kind: z.enum(ASSEMBLY_KINDS),
      scheduledAt: z.string().min(1, 'Toplantı tarihini ve saatini seçin'),
      location: z.string().trim().max(300, 'Yer en fazla 300 karakter olabilir'),
      onlineUrl: z.string().trim().max(500, 'Bağlantı en fazla 500 karakter olabilir'),
      /** Bos: ilk toplanti. Dolu: yeter sayisizligi tutanaga gecmis ilk toplantinin ikinci toplantisi. */
      firstMeetingId: z.string(),
      agenda: z.array(z.string()),
    })
    .superRefine((v, ctx) => {
      if (!v.location && !v.onlineUrl) ctx.addIssue({ code: 'custom', path: ['location'], message: 'Toplantı yerini veya çevrim içi bağlantıyı girin' });
      if (v.onlineUrl && !/^https:\/\/\S+$/.test(v.onlineUrl)) ctx.addIssue({ code: 'custom', path: ['onlineUrl'], message: 'Bağlantı https:// ile başlamalıdır' });
      const items = v.agenda.map((a) => a.trim());
      if (items.length < 1 || items.length > MAX_AGENDA_ITEMS) ctx.addIssue({ code: 'custom', path: ['agenda'], message: `Gündem 1-${MAX_AGENDA_ITEMS} maddeden oluşmalı` });
      else if (items.some((a) => !a)) ctx.addIssue({ code: 'custom', path: ['agenda'], message: 'Boş gündem maddesi bırakmayın' });
      else if (items.some((a) => a.length > 300)) ctx.addIssue({ code: 'custom', path: ['agenda'], message: 'Gündem maddesi en fazla 300 karakter olabilir' });
      const first = firstMeetings.find((a) => a.assemblyId === v.firstMeetingId);
      if (first && v.scheduledAt) {
        const firstLocal = isoToIstanbulLocal(first.scheduledAt);
        const limit = new Date(`${firstLocal.slice(0, 10)}T00:00:00Z`);
        limit.setUTCDate(limit.getUTCDate() + SECOND_MEETING_MAX_DAYS);
        if (v.scheduledAt <= firstLocal) ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: 'İkinci toplantı ilk toplantıdan sonra olmalıdır' });
        else if (v.scheduledAt.slice(0, 10) > limit.toISOString().slice(0, 10)) {
          ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: `İkinci toplantı ilk toplantıdan en geç ${SECOND_MEETING_MAX_DAYS} gün sonra yapılmalıdır (KMK m.30)` });
        }
      }
    });
}

export const assemblyFormSchema = makeAssemblyFormSchema();
export type AssemblyForm = z.input<typeof assemblyFormSchema>;
export type AssemblyValues = z.output<typeof assemblyFormSchema>;
export const FORM_FIELDS = ['kind', 'scheduledAt', 'location', 'onlineUrl', 'firstMeetingId', 'agenda'] as const;

/** Varsayilan gundem: KMK uygulamasindaki olagan toplanti maddeleri. */
export function formDefaults(a?: Assembly): AssemblyForm {
  if (!a) {
    return {
      kind: 'ordinary',
      scheduledAt: '',
      location: '',
      onlineUrl: '',
      firstMeetingId: '',
      agenda: ['Açılış ve toplantı başkanlık divanının seçimi', 'Yönetici ve denetçi raporlarının görüşülmesi', 'İşletme projesinin görüşülmesi', 'Dilek ve temenniler'],
    };
  }
  return {
    kind: a.kind,
    scheduledAt: isoToIstanbulLocal(a.scheduledAt),
    location: a.location ?? '',
    onlineUrl: a.onlineUrl ?? '',
    firstMeetingId: a.firstMeetingId ?? '',
    agenda: a.agenda.map((i) => i.title),
  };
}

/** Bos yer / baglanti / ilk toplanti `null` ile temizlenir; gundem maddelerinin aciklamasi korunur. */
export function toInput(v: AssemblyValues, current?: Assembly): AssemblyInput {
  return {
    kind: v.kind,
    scheduledAt: istanbulLocalToIso(v.scheduledAt),
    location: v.location || null,
    onlineUrl: v.onlineUrl || null,
    firstMeetingId: v.firstMeetingId || null,
    agenda: v.agenda.map((title, i) => {
      const prev = current?.agenda[i];
      return prev?.description && prev.title === title.trim() ? { title: title.trim(), description: prev.description } : { title: title.trim() };
    }),
  };
}

/** Gundem sayimi: tam sayilar, toplam katilan (KMK m.31 sinirli) oyu asamaz; API de dogrular. */
export function tallyIssue(t: { yes: number; no: number; abstain: number }, presentVotes: number): string | null {
  if ([t.yes, t.no, t.abstain].some((n) => !Number.isInteger(n) || n < 0)) return 'Oy sayıları sıfır veya pozitif tam sayı olmalı';
  if (t.yes + t.no + t.abstain > presentVotes) return `Toplam, katılan oy sayısını (${presentVotes}) aşamaz`;
  return null;
}
