import { z } from 'zod';
import {
  ASSEMBLY_KINDS,
  type Assembly,
  type AssemblyInput,
  type AttendanceInput,
  type AttendanceMode,
  CONSENT_KINDS,
  CONSENT_RULES,
  type ConsentEntryInput,
  type ConsentInput,
  type ConsentKind,
  DECISION_KINDS,
  DECISION_PRESETS,
  type DecisionKind,
  MAJORITY_RULES,
  MAX_AGENDA_ITEMS,
  MAX_CANDIDATES,
  type MajorityRule,
  type MinutesInput,
  PERSON_RULES,
  QUALIFIED_RULES,
  type RescheduleInput,
  SECOND_MEETING_MAX_DAYS,
  SECOND_MEETING_MIN_DAYS,
  type ServiceAttemptInput,
  type ServiceMethod,
  type ServiceStatus,
  type VoteChoice,
  isElectionKind,
  itemKind,
  itemRule,
} from '@/lib/api/assemblyModel';
import { isoToIstanbulLocal, istanbulLocalToIso } from '@/lib/dates';

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
  /** Yalnizca yonetici / denetci seciminde: virgulle ayrilmis aday adlari (bos: adaysiz kabul / ret oylamasi). */
  candidates: z.string().optional(),
});
export type AgendaRow = z.infer<typeof agendaRow>;
export const emptyAgendaRow = (title = ''): AgendaRow => ({ title, decisionKind: 'general', majority: '', candidates: '' });

/** Aday adlari: virgul veya satir sonuyla ayrilir; bosluklar sadelesir. */
export const candidateNames = (text: string | undefined) =>
  (text ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/** Aday listesi kurali (API ile ayni): 2-150 karakter, en fazla 12, ayni ad iki kez yok. */
export function candidatesIssue(text: string | undefined): string | null {
  const names = candidateNames(text);
  if (names.length > MAX_CANDIDATES) return `Bir seçimde en fazla ${MAX_CANDIDATES} aday olabilir`;
  if (names.some((n) => n.length < 2 || n.length > 150)) return 'Aday adı 2-150 karakter olmalıdır';
  if (new Set(names.map((n) => n.toLocaleLowerCase('tr'))).size !== names.length) return 'Aynı aday iki kez girilemez';
  return null;
}

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
      else {
        const bad = v.agenda.map((a) => (isElectionKind(a.decisionKind) ? candidatesIssue(a.candidates) : null)).find(Boolean);
        if (bad) ctx.addIssue({ code: 'custom', path: ['agenda'], message: bad });
      }
      const first = firstMeetings.find((a) => a.assemblyId === v.firstMeetingId);
      if (first && v.scheduledAt) {
        const issue = secondMeetingGapIssue(isoToIstanbulLocal(first.scheduledAt), v.scheduledAt);
        if (issue) ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: issue });
      }
      if (!v.firstMeetingId && v.planAt && v.scheduledAt) {
        const issue = secondMeetingGapIssue(v.scheduledAt, v.planAt);
        if (issue) ctx.addIssue({ code: 'custom', path: ['planAt'], message: issue });
      }
    });
}

/** KMK m.29/3 ve m.30: ikinci toplanti ilk toplantidan sonra, en az 7 en fazla 15 takvim gunu sonra (API ile ayni). */
export function secondMeetingGapIssue(firstLocal: string, secondLocal: string): string | null {
  if (secondLocal <= firstLocal) return 'İkinci toplantı ilk toplantıdan sonra olmalıdır';
  const gap = Math.round((Date.parse(`${dayOf(secondLocal)}T00:00:00Z`) - Date.parse(`${dayOf(firstLocal)}T00:00:00Z`)) / 86_400_000);
  if (gap < SECOND_MEETING_MIN_DAYS) return `İlk ve ikinci toplantı arasında en az ${SECOND_MEETING_MIN_DAYS} gün olmalıdır (KMK m.29/3; şu an ${gap} gün)`;
  if (dayOf(secondLocal) > addDays(dayOf(firstLocal), SECOND_MEETING_MAX_DAYS)) return `İkinci toplantı ilk toplantıdan en geç ${SECOND_MEETING_MAX_DAYS} gün sonra yapılmalıdır (KMK m.30)`;
  return null;
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
      planAt: '',
      planLocation: '',
      agenda: [
        emptyAgendaRow('Açılış ve toplantı başkanlık divanının seçimi'),
        emptyAgendaRow('Yönetici ve denetçi raporlarının görüşülmesi'),
        { title: 'İşletme projesinin görüşülmesi', decisionKind: 'operating_budget', majority: '', candidates: '' },
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
      return { title: i.title, decisionKind: kind, majority: kind === 'custom' ? itemRule(i) : '', candidates: (i.candidates ?? []).map((c) => c.name).join(', ') };
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
      const names = isElectionKind(kind) ? candidateNames(row.candidates) : [];
      // Ayni adli adayin kisi baglantisi (varsa) korunur.
      const prevUser = new Map((prev?.candidates ?? []).filter((c) => c.userId).map((c) => [c.name, c.userId as string]));
      return {
        title,
        ...(prev?.description && prev.title === title ? { description: prev.description } : {}),
        decisionKind: kind,
        ...(kind === 'custom' && row.majority ? { majority: row.majority as MajorityRule } : {}),
        ...(names.length ? { candidates: names.map((name) => ({ name, ...(prevUser.get(name) ? { userId: prevUser.get(name) } : {}) })) } : {}),
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
 * katilan bolumlere de yazilir (kisinin tek oyu vardir; KMK m.31). Kisi sayimli kurallarda ayni
 * kat malikine dusen (ayni `personKey`) bolumler de birlikte isaretlenir (API ayni kurali dogrular).
 */
export function setUnitVote<C extends string = VoteChoice>(
  votes: Record<string, C | ''>,
  units: readonly { unitId: string; voterKey?: string; personKey?: string }[],
  unitId: string,
  choice: C | '',
  rule: MajorityRule = 'attendees',
): Record<string, C | ''> {
  const byPerson = PERSON_RULES.includes(rule);
  const next = { ...votes };
  // Ayni kimlige baglanan bolumler zincirleme birlesir (oy kimligi ve kisi kimligi).
  const group = new Set([unitId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of units) {
      if (group.has(u.unitId)) continue;
      const linked = units.some((g) => group.has(g.unitId) && ((g.voterKey && g.voterKey === u.voterKey) || (byPerson && g.personKey && g.personKey === u.personKey)));
      if (linked) {
        group.add(u.unitId);
        grew = true;
      }
    }
  }
  for (const id of group) next[id] = choice;
  return next;
}

/** Duzeltme formunun on dolumu: son kaydin bolum oylari (bolum bazinda giriste). */
export const prefillUnitVotes = (unitVotes: Record<string, VoteChoice> | undefined): Record<string, VoteChoice | ''> => ({ ...(unitVotes ?? {}) });

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

/** Secim pusulasi: bos secimler (oy kullanmadi) atilir; deger aday kimligi veya `abstain`. */
export const ballotsInput = (ballots: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(ballots).filter(([, v]) => v !== ''));

/**
 * Erteleme / yer degisikligi girisi -> API govdesi (yalnizca degisen alanlar). Tarih Istanbul yerel
 * (`datetime-local`). Sorun varsa `issue`.
 */
export function rescheduleInput(
  a: Pick<Assembly, 'version' | 'scheduledAt' | 'location' | 'onlineUrl' | 'secondMeetingPlan'>,
  v: { reason: string; scheduledAt: string; location: string; onlineUrl: string; secondAt?: string; secondLocation?: string },
  nowMs: number = Date.now(),
): { input: RescheduleInput } | { issue: string } {
  const reason = v.reason.trim();
  if (reason.length < 3) return { issue: 'Gerekçe en az 3 karakter olmalı' };
  if (!v.scheduledAt) return { issue: 'Toplantı tarihini ve saatini seçin' };
  const scheduledAt = istanbulLocalToIso(v.scheduledAt);
  if (Date.parse(scheduledAt) <= nowMs) return { issue: 'Yeni toplantı zamanı gelecekte olmalıdır' };
  const location = v.location.trim();
  const onlineUrl = v.onlineUrl.trim();
  if (!location && !onlineUrl) return { issue: 'Toplantı yerini veya çevrim içi bağlantıyı girin' };
  if (onlineUrl && !/^https:\/\/\S+$/.test(onlineUrl)) return { issue: 'Bağlantı https:// ile başlamalıdır' };
  const timeChanged = Date.parse(scheduledAt) !== Date.parse(a.scheduledAt);
  const locChanged = location !== (a.location ?? '');
  const urlChanged = onlineUrl !== (a.onlineUrl ?? '');
  // Ilk cagrida bildirilen ikinci toplanti (KMK m.29/3) tarih degisince yeniden bildirilir.
  let plan: RescheduleInput['secondMeetingPlan'];
  if (a.secondMeetingPlan) {
    if (!v.secondAt) {
      if (timeChanged) return { issue: 'İlk toplantının tarihi değişince ikinci toplantının tarihini de yeniden girin (KMK m.29/3)' };
    } else {
      const secondAt = istanbulLocalToIso(v.secondAt);
      const secondLocation = (v.secondLocation ?? '').trim() || location;
      const gap = secondMeetingGapIssue(v.scheduledAt, v.secondAt);
      if (gap) return { issue: gap };
      if (Date.parse(secondAt) !== Date.parse(a.secondMeetingPlan.scheduledAt) || secondLocation !== (a.secondMeetingPlan.location ?? '')) plan = { scheduledAt: secondAt, ...(secondLocation ? { location: secondLocation } : {}) };
    }
  }
  if (!timeChanged && !locChanged && !urlChanged && !plan) return { issue: 'Tarih, yer veya çevrim içi bağlantıdan en az biri değişmeli' };
  return {
    input: {
      version: a.version,
      reason,
      ...(timeChanged ? { scheduledAt } : {}),
      ...(locChanged ? { location: location || null } : {}),
      ...(urlChanged ? { onlineUrl: onlineUrl || null } : {}),
      ...(plan ? { secondMeetingPlan: plan } : {}),
    },
  };
}

/**
 * Tebligat denemesi girisi -> API govdesi. Taahhutlu mektupta gonderi no zorunlu; tarih bugunden ve
 * toplanti gununden sonra olamaz (API ile ayni).
 */
export function serviceAttemptInput(
  v: { version: number; method: ServiceMethod; sentOn: string; referenceNo: string; status: ServiceStatus | ''; statusOn: string; note: string },
  limits: { today: string; rollDate: string },
): { input: ServiceAttemptInput } | { issue: string } {
  if (!v.sentOn) return { issue: 'Tarihi girin' };
  if (v.sentOn > limits.today) return { issue: 'Tarih bugünden sonra olamaz' };
  if (v.sentOn > limits.rollDate) return { issue: 'Gönderim tarihi toplantı gününden sonra olamaz' };
  const referenceNo = v.referenceNo.trim();
  if (v.method === 'registered_mail' && !referenceNo) return { issue: 'Taahhütlü mektupta gönderi (barkod) numarasını girin' };
  if (v.statusOn && (v.statusOn > limits.today || v.statusOn < v.sentOn)) return { issue: 'Teslim / iade tarihi gönderimden önce veya bugünden sonra olamaz' };
  return {
    input: {
      version: v.version,
      method: v.method,
      sentOn: v.sentOn,
      ...(referenceNo ? { referenceNo } : {}),
      ...(v.status ? { status: v.status } : {}),
      ...(v.status && v.status !== 'pending' && v.statusOn ? { statusOn: v.statusOn } : {}),
      ...(v.note.trim() ? { note: v.note.trim() } : {}),
    },
  };
}

/** Yazili riza talebi formu: ozel turde cogunluk secilir (katilanlarin oy coklugu yok). */
export const consentFormSchema = z
  .object({
    title: z.string().trim().min(3, 'Başlık en az 3 karakter olmalı').max(300, 'Başlık en fazla 300 karakter olabilir'),
    description: z.string().trim().max(2000, 'Açıklama en fazla 2000 karakter olabilir'),
    decisionKind: z.enum(CONSENT_KINDS),
    majority: z.union([z.enum(MAJORITY_RULES), z.literal('')]),
  })
  .superRefine((v, ctx) => {
    if (v.decisionKind === 'custom' && (!v.majority || !CONSENT_RULES.includes(v.majority))) ctx.addIssue({ code: 'custom', path: ['majority'], message: 'Gerekli çoğunluğu seçin' });
  });
export type ConsentForm = z.input<typeof consentFormSchema>;
export type ConsentValues = z.output<typeof consentFormSchema>;
export const CONSENT_FORM_FIELDS = ['title', 'description', 'decisionKind', 'majority'] as const;
export const consentDefaults = (): ConsentForm => ({ title: '', description: '', decisionKind: 'common_area_change', majority: '' });
export const toConsentInput = (v: ConsentValues): ConsentInput => ({
  title: v.title,
  ...(v.description ? { description: v.description } : {}),
  decisionKind: v.decisionKind as ConsentKind,
  ...(v.decisionKind === 'custom' && v.majority ? { majority: v.majority as MajorityRule } : {}),
});
/** Turun cogunlugu (formda gosterilir): hazir turde kanundan, ozelde secilen. */
export const consentRule = (kind: ConsentKind, custom: MajorityRule | ''): MajorityRule | undefined => (kind === 'custom' ? custom || undefined : DECISION_PRESETS[kind].rule);

/**
 * Riza kaydi girisi -> API govdesi. Hisseli bolumde imzalayan paydas, kayitli bolumde duzeltme
 * gerekcesi, "Diger" yontemde aciklama zorunlu; imza tarihi bugunden sonra olamaz.
 */
export function consentEntryInput(
  v: {
    choice: ConsentEntryInput['choice'];
    signedOn: string;
    method: ConsentEntryInput['method'];
    methodNote: string;
    signerUserId: string;
    correctionReason: string;
    /** Butun paydaslarin imzasi gereken turde isaretlenen paydaslar. */
    signerUserIds?: string[];
  },
  ctx: { coOwned: boolean; recorded: boolean; today: string; openedOn?: string; allCoOwners?: boolean; owners?: string[] },
): { input: ConsentEntryInput } | { issue: string } {
  if (!v.signedOn) return { issue: 'İmza tarihini girin' };
  if (v.signedOn > ctx.today) return { issue: 'İmza tarihi bugünden sonra olamaz' };
  if (ctx.openedOn && v.signedOn < ctx.openedOn) return { issue: 'İmza tarihi talebin açıldığı günden önce olamaz' };
  // Tasarruf niteliginde oybirligi (m.45, m.44, m.24/2): hisseli bolumde rizaya butun paydaslar imza atar.
  const everyone = ctx.coOwned && ctx.allCoOwners && v.choice === 'consent';
  if (everyone) {
    const picked = v.signerUserIds ?? [];
    if (!(ctx.owners ?? []).every((u) => picked.includes(u))) return { issue: 'Bu karar türünde hisseli bölümün bütün paydaşları imzalamalıdır' };
  } else if (ctx.coOwned && !v.signerUserId) return { issue: 'Hisseli bölümde rızayı veren paydaşı (temsilci) seçin' };
  if (v.method === 'other' && !v.methodNote.trim()) return { issue: '"Diğer" yöntemde açıklama girin' };
  if (ctx.recorded && v.correctionReason.trim().length < 3) return { issue: 'Kayıtlı bölüm için düzeltme gerekçesi en az 3 karakter olmalı' };
  return {
    input: {
      choice: v.choice,
      signedOn: v.signedOn,
      method: v.method,
      ...(v.method === 'other' ? { methodNote: v.methodNote.trim() } : {}),
      ...(everyone ? { signerUserIds: [...(v.signerUserIds ?? [])] } : v.signerUserId ? { signerUserId: v.signerUserId } : {}),
      ...(ctx.recorded ? { correctionReason: v.correctionReason.trim() } : {}),
    },
  };
}
