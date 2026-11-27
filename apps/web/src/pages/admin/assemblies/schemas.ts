import { z } from 'zod';
import {
  ASSEMBLY_KINDS,
  type Assembly,
  type AssemblyInput,
  type AttendanceInput,
  type AttendanceMode,
  DECISION_KINDS,
  type DecisionKind,
  MAJORITY_RULES,
  MAX_AGENDA_ITEMS,
  type MajorityRule,
  type MinutesInput,
  QUALIFIED_RULES,
  SECOND_MEETING_MAX_DAYS,
  type VoteChoice,
  itemKind,
  itemRule,
} from '@/lib/api/assemblyModel';
import { isoToIstanbulLocal, istanbulLocalToIso } from '@/lib/dates';

/** KMK m.29: ilk ve ikinci toplanti arasinda en az bu kadar gun (uyari). */
export const SECOND_MEETING_MIN_DAYS = 7;

const dayOf = (local: string) => local.slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const agendaRow = z.object({
  title: z.string(),
  decisionKind: z.enum(DECISION_KINDS),
  /** Yalnizca `custom` turunde secilir; hazir turde kanundan gelir. */
  majority: z.union([z.enum(MAJORITY_RULES), z.literal('')]),
});
export type AgendaRow = z.infer<typeof agendaRow>;
export const emptyAgendaRow = (title = ''): AgendaRow => ({ title, decisionKind: 'general', majority: '' });

/** Genel kurul formu: tarih <input type="datetime-local"> (Istanbul), gundem satirlari, ilk toplanti / ikinci toplanti plani. */
export function makeAssemblyFormSchema(firstMeetings: readonly Pick<Assembly, 'assemblyId' | 'scheduledAt'>[] = []) {
  return z
    .object({
      kind: z.enum(ASSEMBLY_KINDS),
      scheduledAt: z.string().min(1, 'Toplantı tarihini ve saatini seçin'),
      location: z.string().trim().max(300, 'Yer en fazla 300 karakter olabilir'),
      onlineUrl: z.string().trim().max(500, 'Bağlantı en fazla 500 karakter olabilir'),
      /** Bos: ilk toplanti. Dolu: yeter sayisizligi tutanaga gecmis ilk toplantinin ikinci toplantisi. */
      firstMeetingId: z.string(),
      /** Ilk toplantida cagriya yazilacak ikinci toplanti (bos: yok). Yer bos ise toplanti yeri kullanilir. */
      planAt: z.string(),
      planLocation: z.string().trim().max(300, 'Yer en fazla 300 karakter olabilir'),
      agenda: z.array(agendaRow),
    })
    .superRefine((v, ctx) => {
      if (!v.location && !v.onlineUrl) ctx.addIssue({ code: 'custom', path: ['location'], message: 'Toplantı yerini veya çevrim içi bağlantıyı girin' });
      if (v.onlineUrl && !/^https:\/\/\S+$/.test(v.onlineUrl)) ctx.addIssue({ code: 'custom', path: ['onlineUrl'], message: 'Bağlantı https:// ile başlamalıdır' });
      const items = v.agenda.map((a) => a.title.trim());
      if (items.length < 1 || items.length > MAX_AGENDA_ITEMS) ctx.addIssue({ code: 'custom', path: ['agenda'], message: `Gündem 1-${MAX_AGENDA_ITEMS} maddeden oluşmalı` });
      else if (items.some((a) => !a)) ctx.addIssue({ code: 'custom', path: ['agenda'], message: 'Boş gündem maddesi bırakmayın' });
      else if (items.some((a) => a.length > 300)) ctx.addIssue({ code: 'custom', path: ['agenda'], message: 'Gündem maddesi en fazla 300 karakter olabilir' });
      else if (v.agenda.some((a) => a.decisionKind === 'custom' && !a.majority)) ctx.addIssue({ code: 'custom', path: ['agenda'], message: 'Özel karar türündeki maddeler için gerekli çoğunluğu seçin' });
      const first = firstMeetings.find((a) => a.assemblyId === v.firstMeetingId);
      if (first && v.scheduledAt) {
        const firstLocal = isoToIstanbulLocal(first.scheduledAt);
        if (v.scheduledAt <= firstLocal) ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: 'İkinci toplantı ilk toplantıdan sonra olmalıdır' });
        else if (dayOf(v.scheduledAt) > addDays(dayOf(firstLocal), SECOND_MEETING_MAX_DAYS)) {
          ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: `İkinci toplantı ilk toplantıdan en geç ${SECOND_MEETING_MAX_DAYS} gün sonra yapılmalıdır (KMK m.30)` });
        }
      }
      if (!v.firstMeetingId && v.planAt && v.scheduledAt) {
        if (v.planAt <= v.scheduledAt) ctx.addIssue({ code: 'custom', path: ['planAt'], message: 'İkinci toplantı ilk toplantıdan sonra olmalıdır' });
        else if (dayOf(v.planAt) > addDays(dayOf(v.scheduledAt), SECOND_MEETING_MAX_DAYS)) {
          ctx.addIssue({ code: 'custom', path: ['planAt'], message: `İkinci toplantı ilk toplantıdan en geç ${SECOND_MEETING_MAX_DAYS} gün sonra yapılmalıdır (KMK m.30)` });
        }
      }
    });
}

export const assemblyFormSchema = makeAssemblyFormSchema();
export type AssemblyForm = z.input<typeof assemblyFormSchema>;
export type AssemblyValues = z.output<typeof assemblyFormSchema>;
export const FORM_FIELDS = ['kind', 'scheduledAt', 'location', 'onlineUrl', 'firstMeetingId', 'agenda'] as const;

/** Ikinci toplanti plani ilk toplantidan 7 gunden kisa ise KMK m.29 uyarisi (engel degil). */
export function planGapWarning(v: Pick<AssemblyForm, 'scheduledAt' | 'planAt' | 'firstMeetingId'>): string | null {
  if (v.firstMeetingId || !v.planAt || !v.scheduledAt || v.planAt <= v.scheduledAt) return null;
  const gap = Math.round((Date.parse(`${dayOf(v.planAt)}T00:00:00Z`) - Date.parse(`${dayOf(v.scheduledAt)}T00:00:00Z`)) / 86_400_000);
  return gap < SECOND_MEETING_MIN_DAYS ? `KMK m.29: ilk ve ikinci toplantı arasında en az ${SECOND_MEETING_MIN_DAYS} gün olmalıdır (şu an ${gap} gün).` : null;
}

/** Varsayilan gundem: KMK uygulamasindaki olagan toplanti maddeleri. */
export function formDefaults(a?: Assembly): AssemblyForm {
  if (!a) {
    return {
      kind: 'ordinary',
      scheduledAt: '',
      location: '',
      onlineUrl: '',
      firstMeetingId: '',
      planAt: '',
      planLocation: '',
      agenda: [
        emptyAgendaRow('Açılış ve toplantı başkanlık divanının seçimi'),
        emptyAgendaRow('Yönetici ve denetçi raporlarının görüşülmesi'),
        { title: 'İşletme projesinin görüşülmesi', decisionKind: 'operating_budget', majority: '' },
        emptyAgendaRow('Dilek ve temenniler'),
      ],
    };
  }
  return {
    kind: a.kind,
    scheduledAt: isoToIstanbulLocal(a.scheduledAt),
    location: a.location ?? '',
    onlineUrl: a.onlineUrl ?? '',
    firstMeetingId: a.firstMeetingId ?? '',
    planAt: a.secondMeetingPlan ? isoToIstanbulLocal(a.secondMeetingPlan.scheduledAt) : '',
    planLocation: a.secondMeetingPlan?.location ?? '',
    agenda: a.agenda.map((i) => {
      const kind = itemKind(i);
      return { title: i.title, decisionKind: kind, majority: kind === 'custom' ? itemRule(i) : '' };
    }),
  };
}

/** Bos yer / baglanti / ilk toplanti / plan `null` ile temizlenir; gundem maddelerinin aciklamasi korunur. */
export function toInput(v: AssemblyValues, current?: Assembly): AssemblyInput {
  const location = v.location || null;
  const onlineUrl = v.onlineUrl || null;
  const plan =
    !v.firstMeetingId && v.planAt
      ? {
          scheduledAt: istanbulLocalToIso(v.planAt),
          ...(v.planLocation ? { location: v.planLocation } : location ? { location } : {}),
          ...(!v.planLocation && onlineUrl ? { onlineUrl } : {}),
        }
      : null;
  return {
    kind: v.kind,
    scheduledAt: istanbulLocalToIso(v.scheduledAt),
    location,
    onlineUrl,
    firstMeetingId: v.firstMeetingId || null,
    secondMeetingPlan: plan,
    agenda: v.agenda.map((row, i) => {
      const title = row.title.trim();
      const prev = current?.agenda[i];
      const kind: DecisionKind = row.decisionKind;
      return {
        title,
        ...(prev?.description && prev.title === title ? { description: prev.description } : {}),
        decisionKind: kind,
        ...(kind === 'custom' && row.majority ? { majority: row.majority as MajorityRule } : {}),
      };
    }),
  };
}

/**
 * Katilim girisi -> API govdesi; eksikse null (Kaydet kapali). Hisseli bolumde asaleten ve vekaleten
 * katilimda paydaslarin temsilcisi zorunlu (oy KMK m.31 siniri icin o kisiye yazilir).
 */
export function attendanceInput(s: { mode: AttendanceMode; coOwned: boolean; attendee: string; proxyUserId: string; proxyName: string }): AttendanceInput | null {
  if (s.mode === 'absent') return { mode: 'absent' };
  if (s.coOwned && !s.attendee) return null;
  const rep = s.attendee ? { attendeeUserId: s.attendee } : {};
  if (s.mode === 'present') return { mode: 'present', ...rep };
  if (s.proxyUserId) return { mode: 'proxy', ...rep, proxyUserId: s.proxyUserId };
  return s.proxyName.trim().length >= 3 ? { mode: 'proxy', ...rep, proxyName: s.proxyName.trim() } : null;
}

/** Gundem sayimi: tam sayilar, toplam katilan (KMK m.31 sinirli) oyu asamaz; API de dogrular. */
export function tallyIssue(t: { yes: number; no: number; abstain: number }, presentVotes: number): string | null {
  if ([t.yes, t.no, t.abstain].some((n) => !Number.isInteger(n) || n < 0)) return 'Oy sayıları sıfır veya pozitif tam sayı olmalı';
  if (t.yes + t.no + t.abstain > presentVotes) return `Toplam, katılan oy sayısını (${presentVotes}) aşamaz`;
  return null;
}

/** Nitelikli cogunluk mu (bolum bazinda oy zorunlu)? */
export const needsUnitVotes = (rule: MajorityRule) => QUALIFIED_RULES.includes(rule);

/**
 * Bolum bazinda oy: secilen bolumun oyu, ayni kisinin oyunu kullandigi (ayni `voterKey`) tum
 * katilan bolumlere de yazilir (kisinin tek oyu vardir; KMK m.31).
 */
export function setUnitVote(votes: Record<string, VoteChoice | ''>, units: readonly { unitId: string; voterKey?: string }[], unitId: string, choice: VoteChoice | ''): Record<string, VoteChoice | ''> {
  const key = units.find((u) => u.unitId === unitId)?.voterKey;
  const next = { ...votes };
  for (const u of units) if (u.unitId === unitId || (key && u.voterKey === key)) next[u.unitId] = choice;
  return next;
}

/** Ad listesi <-> virgullu metin (yazman, oy toplayici). */
export const namesText = (names: readonly string[] | undefined) => (names ?? []).join(', ');
const splitNames = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/**
 * Tutanak girisi -> API govdesi; adlar 2-150 karakter, yazman / oy toplayici en fazla 3 kisi degilse
 * null (Kaydet kapali). Bos baskan `null` ile temizlenir; bos notlar gonderilmez.
 */
export function minutesInput(s: { version: number; chair: string; clerks: string; counters: string; notes: Record<string, string>; general: string }): MinutesInput | null {
  const chair = s.chair.trim().replace(/\s+/g, ' ');
  const clerks = splitNames(s.clerks);
  const voteCounters = splitNames(s.counters);
  const bad = (n: string) => n.length < 2 || n.length > 150;
  if ((chair && bad(chair)) || clerks.length > 3 || voteCounters.length > 3 || [...clerks, ...voteCounters].some(bad)) return null;
  const notes = Object.fromEntries(Object.entries(s.notes).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
  return { version: s.version, chair: chair || null, clerks, voteCounters, notes, generalNotes: s.general.trim() };
}

/** Bos secimler atilir (oy kullanmadi). */
export const unitVotesInput = (votes: Record<string, VoteChoice | ''>): Record<string, VoteChoice> =>
  Object.fromEntries(Object.entries(votes).filter((e): e is [string, VoteChoice] => e[1] !== ''));
