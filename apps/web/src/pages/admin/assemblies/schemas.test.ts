import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { navItemsFor } from '@/layouts/adminNav';
import { type Assembly, type Quorum, assemblyDetailSchema, firstMeetingCandidates, quorumSchema, quorumText } from '@/lib/api/assemblyModel';
import { actionLabel } from '@/lib/audit/labels';
import {
  type AgendaRow,
  assemblyFormSchema,
  attendanceInput,
  ballotsInput,
  candidateNames,
  candidatesIssue,
  consentEntryInput,
  consentFormSchema,
  consentRule,
  formDefaults,
  makeAssemblyFormSchema,
  minutesInput,
  rescheduleInput,
  secondMeetingGapIssue,
  serviceAttemptInput,
  setUnitVote,
  tallyIssue,
  toConsentInput,
  toInput,
  unitVotesInput,
} from './schemas';

const row = (title: string, decisionKind: AgendaRow['decisionKind'] = 'general', majority: AgendaRow['majority'] = '', candidates = '') => ({ title, decisionKind, majority, candidates });
const valid = { kind: 'ordinary' as const, scheduledAt: '2026-12-15T19:00', location: ' Toplantı salonu ', onlineUrl: '', firstMeetingId: '', planAt: '', planLocation: '', agenda: [row(' Açılış '), row('Bütçe')] };

const assembly = (over: Partial<Assembly> = {}): Assembly => ({
  assemblyId: 'asm1',
  kind: 'ordinary',
  secondMeeting: false,
  scheduledAt: '2026-12-15T16:00:00.000Z',
  location: 'Salon',
  rollDate: '2026-12-15',
  agenda: [{ itemId: 'a1', title: 'Bütçe', description: '2027 işletme projesi' }],
  status: 'planned',
  createdAt: '2026-11-27T09:00:00.000Z',
  version: 2,
  ...over,
});

const quorum = (over: Partial<Quorum> = {}): Quorum => ({
  totalUnits: 4,
  presentUnits: 3,
  proxyUnits: 0,
  totalOwners: 4,
  presentOwners: 3,
  ownersBps: 7500,
  totalVotes: 4,
  presentVotes: 3,
  voteCap: 1,
  cappedOwners: 0,
  landShareComputable: true,
  reasons: ['Katılanların arsa payı toplamın yarısından fazla değil'],
  totalLandShare: { numerator: '1000', denominator: '1000' },
  presentLandShare: { numerator: '300', denominator: '1000' },
  landShareBps: 3000,
  ownersMajority: true,
  landShareMajority: false,
  secondMeeting: false,
  met: false,
  decisionThreshold: 2,
  warnings: [],
  ...over,
});

describe('genel kurul formu', () => {
  it('metinleri kirpar, Istanbul saatini ISO ya cevirir, bos baglanti null olur', () => {
    expect(toInput(assemblyFormSchema.parse(valid))).toEqual({
      kind: 'ordinary',
      scheduledAt: '2026-12-15T19:00:00+03:00',
      location: 'Toplantı salonu',
      onlineUrl: null,
      firstMeetingId: null,
      secondMeetingPlan: null,
      agenda: [{ title: 'Açılış', decisionKind: 'general' }, { title: 'Bütçe', decisionKind: 'general' }],
    });
  });

  it('duzenlemede ayni baslikli maddenin aciklamasi korunur', () => {
    const a = assembly();
    const form = formDefaults(a);
    expect(form).toMatchObject({ scheduledAt: '2026-12-15T19:00', agenda: [row('Bütçe')] });
    expect(toInput(assemblyFormSchema.parse(form), a).agenda).toEqual([{ title: 'Bütçe', description: '2027 işletme projesi', decisionKind: 'general' }]);
  });

  it.each([
    ['yer ve baglanti yok', { location: '', onlineUrl: '' }, 'location'],
    ['http baglanti', { onlineUrl: 'http://x.example' }, 'onlineUrl'],
    ['bos madde', { agenda: [row('Açılış'), row(' ')] }, 'agenda'],
    ['ozel turde cogunluk yok', { agenda: [row('Plan', 'custom')] }, 'agenda'],
    ['ikinci toplanti plani once', { planAt: '2026-12-15T18:00' }, 'planAt'],
    ['ikinci toplanti plani 15 gunden sonra', { planAt: '2026-12-31T19:00' }, 'planAt'],
    ['gundem yok', { agenda: [] }, 'agenda'],
    ['tarih yok', { scheduledAt: '' }, 'scheduledAt'],
  ])('reddedilir: %s', (_l, over, field) => {
    const r = assemblyFormSchema.safeParse({ ...valid, ...over });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(field);
  });

  it('ikinci toplanti: ilk toplantidan sonra ve en gec 15 gun icinde; adaylar yeter sayisizligi tutanakta olanlar', () => {
    const first = assembly({ assemblyId: 'f1', scheduledAt: '2026-12-15T16:00:00.000Z', quorumRecord: { met: false, presentOwners: 1, totalOwners: 4, presentVotes: 1, totalVotes: 4, noAttendance: false, recordedAt: '2026-12-15T17:00:00.000Z' } });
    const schema = makeAssemblyFormSchema([first]);
    const at = (scheduledAt: string) => schema.safeParse({ ...valid, firstMeetingId: 'f1', scheduledAt });
    expect(at('2026-12-30T19:00').success).toBe(true);
    expect(at('2026-12-31T10:00').error?.issues[0]?.message).toContain('en geç 15 gün');
    expect(at('2026-12-15T18:00').error?.issues[0]?.message).toContain('ilk toplantıdan sonra');
    expect(toInput(at('2026-12-30T19:00').data!).firstMeetingId).toBe('f1');
    const met = assembly({ assemblyId: 'm1', quorumRecord: { met: true, presentOwners: 3, totalOwners: 4, presentVotes: 3, totalVotes: 4, noAttendance: false, recordedAt: '2026-12-15T17:00:00.000Z' } });
    expect(firstMeetingCandidates([first, met, assembly({ assemblyId: 'x' }), assembly({ assemblyId: 's', secondMeeting: true, quorumRecord: first.quorumRecord })]).map((a) => a.assemblyId)).toEqual(['f1']);
    expect(firstMeetingCandidates([first], 'f1')).toEqual([]);
  });

  it('katilim girisi: hisseli bolumde temsilci paydas zorunlu (asaleten ve vekaleten)', () => {
    const base = { coOwned: true, attendee: '', proxyUserId: '', proxyName: '' };
    expect(attendanceInput({ ...base, mode: 'present' })).toBeNull();
    expect(attendanceInput({ ...base, mode: 'proxy', proxyUserId: 'p1' })).toBeNull();
    expect(attendanceInput({ ...base, mode: 'present', attendee: 'a' })).toEqual({ mode: 'present', attendeeUserId: 'a' });
    expect(attendanceInput({ ...base, mode: 'proxy', attendee: 'a', proxyUserId: 'p1' })).toEqual({ mode: 'proxy', attendeeUserId: 'a', proxyUserId: 'p1' });
    expect(attendanceInput({ ...base, coOwned: false, mode: 'proxy', proxyName: '  Ali Demir ' })).toEqual({ mode: 'proxy', proxyName: 'Ali Demir' });
    expect(attendanceInput({ ...base, coOwned: false, mode: 'proxy', proxyName: 'Al' })).toBeNull();
    expect(attendanceInput({ ...base, mode: 'absent' })).toEqual({ mode: 'absent' });
  });

  it('sayim: toplam katilani asamaz, negatif / kesirli olamaz', () => {
    expect(tallyIssue({ yes: 2, no: 1, abstain: 0 }, 3)).toBeNull();
    expect(tallyIssue({ yes: 3, no: 1, abstain: 0 }, 3)).toContain('(3)');
    expect(tallyIssue({ yes: -1, no: 0, abstain: 0 }, 3)).not.toBeNull();
    expect(tallyIssue({ yes: 1.5, no: 0, abstain: 0 }, 3)).not.toBeNull();
  });
});

describe('genel kurul modeli', () => {
  it('yeter sayi metni: eksik olcutu adlandirir; ikinci toplanti', () => {
    expect(quorumText(quorum())).toBe('Toplantı yeter sayısı sağlanmadı: Katılanların arsa payı toplamın yarısından fazla değil. Gündem sayımı kaydedilemez.');
    expect(quorumText(quorum({ landShareComputable: false, reasons: ['1 bölümün arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor, yeter sayı sağlanmış sayılmaz'] }))).toContain('hesaplanamıyor');
    expect(quorumText(quorum({ met: true, landShareMajority: true }))).toContain('sağlandı');
    expect(quorumText(quorum({ secondMeeting: true, met: true }))).toContain('aranmaz');
  });

  it('ayrinti semasi ve menu / denetim etiketleri', () => {
    const d = assemblyDetailSchema.parse({ assembly: assembly(), rollFrozen: true, quorum: quorum(), units: [{ unitId: 'u1', blockId: 'b1', number: '1', owners: [{ userId: 'x', name: 'Ali' }], attendance: { mode: 'proxy', proxy: { userId: 'p1', name: 'Vekil' }, recordedAt: '2026-12-15T16:30:00.000Z', version: 1 }, warnings: [] }] });
    expect(d.units[0]?.attendance?.proxy).toEqual({ userId: 'p1', name: 'Vekil' });
    // Yeter sayinin sayi olcutu kat maliki (kisi): eski bolum bazli alanlarla gelen yanit reddedilir.
    const { totalOwners: _t, presentOwners: _p, ...legacy } = quorum();
    expect(() => quorumSchema.parse({ ...legacy, unitsMajority: true })).toThrow();
    expect(quorumSchema.parse(quorum({ voteCap: 2, cappedOwners: 1 })).voteCap).toBe(2);
    for (const role of ['apartment_manager', 'management_company', 'observer'] as const) expect(navItemsFor(role).map((n) => n.to)).toContain('/admin/assemblies');
    expect(navItemsFor('building_staff').map((n) => n.to)).not.toContain('/admin/assemblies');
    expect(actionLabel('assembly.tally')).toBe('Genel kurul gündem sayımı kaydedildi');
    expect(actionLabel('poll.close')).toBe('Oylama erken kapatıldı');
    expect(actionLabel('assembly.tally_correction')).toBe('Genel kurul kararı düzeltildi (yeni kayıt)');
    expect(actionLabel('assembly.call_resend')).toBe('Genel kurul çağrısı yeniden gönderildi');
  });

  it('ayrinti: eski yanit (kararsiz / cagrisiz) varsayilanlarla okunur; kesinlesmis toplanti adayi olur', () => {
    const d = assemblyDetailSchema.parse({ assembly: assembly(), rollFrozen: false, quorum: quorum(), units: [] });
    expect(d).toMatchObject({ decisions: [], warnings: [], callOutdated: false });
    const held = assembly({ assemblyId: 'h', status: 'held', quorumRecord: { met: false, presentOwners: 1, totalOwners: 4, presentVotes: 1, totalVotes: 4, noAttendance: false, recordedAt: '2026-12-15T17:00:00.000Z' } });
    expect(firstMeetingCandidates([held, assembly({ assemblyId: 'c', status: 'cancelled', quorumRecord: held.quorumRecord })]).map((a) => a.assemblyId)).toEqual(['h']);
  });
});

describe('genel kurul devami: karar turu, ikinci toplanti plani, bolum bazinda oy, tutanak', () => {
  it('karar turu: hazir turde cogunluk gonderilmez (kanundan), ozel turde secilen cogunluk gider; duzenlemede geri okunur', () => {
    const v = assemblyFormSchema.parse({ ...valid, agenda: [row('Yönetici', 'manager_election'), row('Aidat maddesi', 'custom', 'four_fifths_persons_and_land')] });
    expect(toInput(v).agenda).toEqual([
      { title: 'Yönetici', decisionKind: 'manager_election' },
      { title: 'Aidat maddesi', decisionKind: 'custom', majority: 'four_fifths_persons_and_land' },
    ]);
    const a = assembly({ agenda: [{ itemId: 'a1', title: 'X', decisionKind: 'custom', majority: 'unanimous' }, { itemId: 'a2', title: 'Y', decisionKind: 'use_change', majority: 'unanimous' }, { itemId: 'a3', title: 'Eski' }] });
    expect(formDefaults(a).agenda).toEqual([row('X', 'custom', 'unanimous'), row('Y', 'use_change'), row('Eski')]);
  });

  it('ikinci toplanti plani: yeri bossa toplanti yeri; ikinci toplantida plan gonderilmez; 7 gunden kisa ise uyari', () => {
    const v = assemblyFormSchema.parse({ ...valid, planAt: '2026-12-29T19:00' });
    expect(toInput(v).secondMeetingPlan).toEqual({ scheduledAt: '2026-12-29T19:00:00+03:00', location: 'Toplantı salonu' });
    expect(toInput(assemblyFormSchema.parse({ ...valid, planAt: '2026-12-29T19:00', planLocation: 'Bahçe' })).secondMeetingPlan).toMatchObject({ location: 'Bahçe' });
    expect(secondMeetingGapIssue('2026-12-15T19:00', '2026-12-18T19:00')).toContain('en az 7 gün');
    expect(secondMeetingGapIssue('2026-12-15T19:00', '2026-12-22T10:00')).toBeNull();
    expect(assemblyFormSchema.safeParse({ ...valid, planAt: '2026-12-18T19:00' }).error?.issues[0]?.message).toContain('KMK m.29/3');
  });

  it('bolum bazinda oy: ayni kisinin bolumleri birlikte isaretlenir; bos secim gonderilmez', () => {
    const units = [{ unitId: 'u1', voterKey: 'user:P' }, { unitId: 'u2', voterKey: 'user:P' }, { unitId: 'u3', voterKey: 'user:Q' }];
    const v = setUnitVote({}, units, 'u1', 'yes');
    expect(v).toEqual({ u1: 'yes', u2: 'yes' });
    const w = setUnitVote(v, units, 'u3', 'no');
    expect(unitVotesInput(setUnitVote(w, units, 'u2', ''))).toEqual({ u3: 'no' });
  });

  it('kisi sayimli kuralda ayni kat malikine dusen bolumler de birlikte isaretlenir; oy kuralinda degil', () => {
    // u2: hisseli, oy listesinde temsilci P ama toplantida Q temsil ediyor (oy kimligi Q, kisi kimligi P).
    const units = [{ unitId: 'u1', voterKey: 'user:P', personKey: 'user:P' }, { unitId: 'u2', voterKey: 'user:Q', personKey: 'user:P' }, { unitId: 'u3', voterKey: 'user:R', personKey: 'user:R' }];
    expect(setUnitVote({}, units, 'u1', 'yes', 'persons_and_land')).toEqual({ u1: 'yes', u2: 'yes' });
    expect(setUnitVote({}, units, 'u1', 'yes', 'four_fifths_votes')).toEqual({ u1: 'yes' });
  });

  it('tutanak girisi: adlar virgulle ayrilir, en fazla 3 kisi; bos baskan temizlenir', () => {
    expect(minutesInput({ version: 3, chair: ' Ayşe  Yılmaz ', clerks: 'Mehmet Kaya, Ali Veli', counters: '', notes: { a1: ' not ', a2: ' ' }, general: '' })).toEqual({
      version: 3,
      chair: 'Ayşe Yılmaz',
      clerks: ['Mehmet Kaya', 'Ali Veli'],
      voteCounters: [],
      notes: { a1: 'not' },
      generalNotes: '',
    });
    expect(minutesInput({ version: 3, chair: '', clerks: 'A B, C D, E F, G H', counters: '', notes: {}, general: '' })).toBeNull();
    expect(minutesInput({ version: 3, chair: 'X', clerks: '', counters: '', notes: {}, general: '' })).toBeNull();
    expect(minutesInput({ version: 3, chair: '', clerks: '', counters: '', notes: {}, general: '' })?.chair).toBeNull();
  });
});

describe('genel kurul sonrasi formlari', () => {
  it('secim adaylari: yalnizca yonetici / denetci seciminde gonderilir; tekrar ve uzunluk kurali; duzenlemede geri okunur', () => {
    const v = assemblyFormSchema.parse({ ...valid, agenda: [row('Yönetici seçimi', 'manager_election', '', ' Ali  Veli , Ayşe Kaya'), row('Bütçe', 'general', '', 'Yok Sayılır')] });
    expect(toInput(v).agenda).toEqual([
      { title: 'Yönetici seçimi', decisionKind: 'manager_election', candidates: [{ name: 'Ali Veli' }, { name: 'Ayşe Kaya' }] },
      { title: 'Bütçe', decisionKind: 'general' },
    ]);
    expect(assemblyFormSchema.safeParse({ ...valid, agenda: [row('Y', 'auditor_election', '', 'Ali Veli, ali veli')] }).error?.issues[0]?.message).toBe('Aynı aday iki kez girilemez');
    expect(candidatesIssue('A')).toContain('2-150');
    expect(candidateNames('a b,\n c d ,')).toEqual(['a b', 'c d']);
    const a = assembly({ agenda: [{ itemId: 'a1', title: 'Y', decisionKind: 'manager_election', majority: 'persons_and_land', candidates: [{ candidateId: 'c1', name: 'Ali Veli', userId: 'p1' }] }] });
    expect(formDefaults(a).agenda[0]?.candidates).toBe('Ali Veli');
    // Ayni adli adayin kisi baglantisi korunur.
    expect(toInput(assemblyFormSchema.parse({ ...formDefaults(a), scheduledAt: '2026-12-15T19:00' }), a).agenda[0]?.candidates).toEqual([{ name: 'Ali Veli', userId: 'p1' }]);
  });

  it('pusula: bos secim atilir; ayni kisinin bolumleri ayni aday', () => {
    const units = [{ unitId: 'u1', voterKey: 'user:P' }, { unitId: 'u2', voterKey: 'user:P' }, { unitId: 'u3', voterKey: 'user:Q' }];
    const b = setUnitVote<string>({}, units, 'u1', 'c2');
    expect(b).toEqual({ u1: 'c2', u2: 'c2' });
    expect(ballotsInput({ ...b, u3: '' })).toEqual({ u1: 'c2', u2: 'c2' });
  });

  it('erteleme: yalnizca degisen alanlar; degisiklik, gerekce ve gelecek tarih sarti', () => {
    const a = assembly();
    const now = Date.parse('2026-11-27T09:00:00.000Z');
    expect(rescheduleInput(a, { reason: 'Salon dolu', scheduledAt: '2026-12-20T19:00', location: 'Salon', onlineUrl: '' }, now)).toEqual({ input: { version: 2, reason: 'Salon dolu', scheduledAt: '2026-12-20T19:00:00+03:00' } });
    expect(rescheduleInput(a, { reason: 'Salon dolu', scheduledAt: '2026-12-15T19:00', location: 'Salon', onlineUrl: '' }, now)).toEqual({ issue: 'Tarih, yer veya çevrim içi bağlantıdan en az biri değişmeli' });
    expect(rescheduleInput(a, { reason: 'x', scheduledAt: '2026-12-20T19:00', location: 'Salon', onlineUrl: '' }, now)).toMatchObject({ issue: expect.stringContaining('Gerekçe') });
    expect(rescheduleInput(a, { reason: 'Geçmiş', scheduledAt: '2026-11-20T19:00', location: 'Salon', onlineUrl: '' }, now)).toMatchObject({ issue: expect.stringContaining('gelecekte') });
    expect(rescheduleInput(a, { reason: 'Çevrim içi', scheduledAt: '2026-12-15T19:00', location: '', onlineUrl: 'https://meet.example/x' }, now)).toEqual({
      input: { version: 2, reason: 'Çevrim içi', location: null, onlineUrl: 'https://meet.example/x' },
    });
  });

  it('tebligat denemesi: taahhutlu mektupta gonderi no zorunlu; gelecek tarih reddedilir', () => {
    const limits = { today: '2026-11-27', rollDate: '2026-12-15' };
    const base2 = { version: 0, method: 'hand_signed' as const, sentOn: '2026-11-26', referenceNo: '', status: '' as const, statusOn: '', note: '' };
    expect(serviceAttemptInput(base2, limits)).toEqual({ input: { version: 0, method: 'hand_signed', sentOn: '2026-11-26' } });
    expect(serviceAttemptInput({ ...base2, method: 'registered_mail' }, limits)).toMatchObject({ issue: expect.stringContaining('barkod') });
    expect(serviceAttemptInput({ ...base2, method: 'registered_mail', referenceNo: ' RR1 ', status: 'returned', statusOn: '2026-11-27' }, limits)).toEqual({
      input: { version: 0, method: 'registered_mail', sentOn: '2026-11-26', referenceNo: 'RR1', status: 'returned', statusOn: '2026-11-27' },
    });
    expect(serviceAttemptInput({ ...base2, sentOn: '2026-11-28' }, limits)).toMatchObject({ issue: 'Tarih bugünden sonra olamaz' });
  });

  it('yazili riza: ozel turde cogunluk zorunlu (katilanlar cogunlugu yok); kayit girisi kurallari', () => {
    expect(consentFormSchema.safeParse({ title: 'Boya', description: '', decisionKind: 'custom', majority: '' }).success).toBe(false);
    expect(consentFormSchema.safeParse({ title: 'Boya', description: '', decisionKind: 'custom', majority: 'attendees' }).success).toBe(false);
    const v = consentFormSchema.parse({ title: ' Dış cephe boyası ', description: '', decisionKind: 'common_area_change', majority: '' });
    expect(toConsentInput(v)).toEqual({ title: 'Dış cephe boyası', decisionKind: 'common_area_change' });
    expect(consentRule('common_area_change', '')).toBe('four_fifths_persons');
    const entry = { choice: 'consent' as const, signedOn: '2026-11-26', method: 'wet_signature' as const, methodNote: '', signerUserId: '', correctionReason: '' };
    const ctx = { coOwned: false, recorded: false, today: '2026-11-27' };
    expect(consentEntryInput(entry, ctx)).toEqual({ input: { choice: 'consent', signedOn: '2026-11-26', method: 'wet_signature' } });
    expect(consentEntryInput(entry, { ...ctx, coOwned: true })).toMatchObject({ issue: expect.stringContaining('paydaşı') });
    expect(consentEntryInput(entry, { ...ctx, recorded: true })).toMatchObject({ issue: expect.stringContaining('düzeltme gerekçesi') });
    expect(consentEntryInput({ ...entry, method: 'other' }, ctx)).toMatchObject({ issue: expect.stringContaining('Diğer') });
    expect(consentEntryInput({ ...entry, signerUserId: 'p2', correctionReason: 'İmza hatalı' }, { ...ctx, coOwned: true, recorded: true })).toEqual({
      input: { choice: 'consent', signedOn: '2026-11-26', method: 'wet_signature', signerUserId: 'p2', correctionReason: 'İmza hatalı' },
    });
  });

  it('yazili riza: ozel turde basit cogunluk yok; acilistan once imza yok; tasarruf turunde hisseli bolumde butun paydaslar', () => {
    expect(consentFormSchema.safeParse({ title: 'Boya', description: '', decisionKind: 'custom', majority: 'persons_and_land' }).success).toBe(false);
    expect(consentFormSchema.safeParse({ title: 'Boya', description: '', decisionKind: 'custom', majority: 'two_thirds_votes' }).success).toBe(true);
    const entry = { choice: 'consent' as const, signedOn: '2026-11-26', method: 'wet_signature' as const, methodNote: '', signerUserId: '', correctionReason: '' };
    const ctx = { coOwned: true, recorded: false, today: '2026-11-27', openedOn: '2026-11-25', allCoOwners: true, owners: ['p1', 'p2'] };
    expect(consentEntryInput({ ...entry, signedOn: '2026-11-24' }, ctx)).toMatchObject({ issue: expect.stringContaining('açıldığı günden önce') });
    expect(consentEntryInput({ ...entry, signerUserIds: ['p1'] }, ctx)).toMatchObject({ issue: expect.stringContaining('bütün paydaşları') });
    expect(consentEntryInput({ ...entry, signerUserIds: ['p2', 'p1'] }, ctx)).toEqual({ input: { choice: 'consent', signedOn: '2026-11-26', method: 'wet_signature', signerUserIds: ['p2', 'p1'] } });
    // Itiraz icin tek paydas (temsilci) yeter.
    expect(consentEntryInput({ ...entry, choice: 'object', signerUserId: 'p1' }, ctx)).toEqual({ input: { choice: 'object', signedOn: '2026-11-26', method: 'wet_signature', signerUserId: 'p1' } });
  });

  it('erteleme: ikinci toplanti plani olan ilk toplantida tarih degisince yeni plan zorunlu ve 7-15 gun kontrolu', () => {
    const a = { ...assembly(), secondMeetingPlan: { scheduledAt: '2026-12-29T16:00:00.000Z', location: 'Bahçe' } };
    const now = Date.parse('2026-11-27T09:00:00.000Z');
    const base = { reason: 'Salon dolu', scheduledAt: '2026-12-20T19:00', location: 'Salon', onlineUrl: '' };
    expect(rescheduleInput(a, base, now)).toMatchObject({ issue: expect.stringContaining('ikinci toplantının tarihini de yeniden girin') });
    expect(rescheduleInput(a, { ...base, secondAt: '2026-12-22T19:00', secondLocation: 'Bahçe' }, now)).toMatchObject({ issue: expect.stringContaining('en az 7 gün') });
    expect(rescheduleInput(a, { ...base, secondAt: '2027-01-03T19:00', secondLocation: 'Bahçe' }, now)).toEqual({
      input: { version: 2, reason: 'Salon dolu', scheduledAt: '2026-12-20T19:00:00+03:00', secondMeetingPlan: { scheduledAt: '2027-01-03T19:00:00+03:00', location: 'Bahçe' } },
    });
  });
});
