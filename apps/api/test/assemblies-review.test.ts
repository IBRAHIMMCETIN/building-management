/**
 * Genel kurul devami - bagimsiz inceleme duzeltmeleri: bos genel not, ikinci toplanti 7 gun alt
 * siniri ve bildirilen plandan sapma uyarisi, ilk karardan sonra katilimin donmasi, kimsenin
 * gelmedigi ikinci toplantinin kesinlestirilmesi, arsa payi eksikliginde 422, Y1'den kalan sayimin
 * duzeltilmesi ve tutanak / karar defterinde gosterimi, tutanagin anlik goruntuden yazilmasi.
 */
import { describe, expect, it } from 'vitest';
import { decisionBookReport, minutesReport } from '../src/modules/assemblies/minutes.js';
import type { Quorum } from '../src/modules/assemblies/quorum.js';
import { APT, DURING, T0, defaultMembers, defaultUnits, ls, meeting, owner, setup, unit } from './fakes/assemblyWorld.js';

/** u1, u2 (own-2a), u4 katilir: yeter sayi saglanir. */
async function quorate(agenda: unknown[] = meeting.agenda) {
  const w = setup();
  await w.call('POST', '', { ...meeting, agenda });
  await w.attend('u1', 'present');
  await w.attend('u2', 'present', { attendeeUserId: 'own-2a' });
  await w.attend('u4', 'present');
  return w;
}

describe('tutanak: bos genel not ve kesinlestirme', () => {
  it('webin gonderdigi govde (bos generalNotes) kaydedilir ve kesinlestirme acilir; bos metin notu temizler', async () => {
    const w = await quorate();
    await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), yes: 2, no: 1, abstain: 0 });
    const body = { version: w.version(), chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'], voteCounters: [], notes: {}, generalNotes: '' };
    const saved = await w.call('PUT', '/asm1/minutes', body);
    expect(saved.status).toBe(200);
    expect(saved.body.minutes.generalNotes).toBeUndefined();
    await w.call('PUT', '/asm1/minutes', { version: w.version(), generalNotes: 'Asansör konuşuldu' });
    expect(w.docs.get(`${APT}|asm1`)!.minutes?.generalNotes).toBe('Asansör konuşuldu');
    expect((await w.call('PUT', '/asm1/minutes', { version: w.version(), generalNotes: null })).body.minutes.generalNotes).toBeUndefined();
    expect((await w.call('PUT', '/asm1/minutes', { version: w.version(), generalNotes: 5 })).status).toBe(400);
    expect((await w.call('POST', '/asm1/finalize', { version: w.version() })).status).toBe(200);
  });

  it('kimsenin gelmedigi ikinci toplanti divansiz kesinlestirilir', async () => {
    const w = setup();
    await w.call('POST', '', meeting);
    await w.attend('u1', 'present');
    await w.call('POST', '/asm1/quorum', { version: w.version() });
    await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-22T19:00:00+03:00', firstMeetingId: 'asm1' });
    w.clock.set('2026-12-22T16:30:00.000Z');
    expect((await w.call('POST', '/asm2/quorum', { version: w.version('asm2'), noAttendance: true })).body.assembly.quorumRecord).toMatchObject({ met: true, noAttendance: true });
    const fin = await w.call('POST', '/asm2/finalize', { version: w.version('asm2') });
    expect(fin.status).toBe(200);
    expect(fin.body.assembly.status).toBe('held');
  });
});

describe('ikinci toplanti: 7 gun alt siniri ve bildirilen plan', () => {
  it('ilk toplantidan 7 gunden once ikinci toplanti 400 (KMK m.29/3); 7 gun gecerli', async () => {
    const w = setup();
    await w.call('POST', '', meeting);
    await w.attend('u1', 'present');
    await w.call('POST', '/asm1/quorum', { version: w.version() });
    const early = await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-21T19:00:00+03:00', firstMeetingId: 'asm1' });
    expect(early.status).toBe(400);
    expect(early.body.message).toContain('en az 7 gün');
    expect((await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-22T10:00:00+03:00', firstMeetingId: 'asm1' })).status).toBe(201);
  });

  it('ikinci toplanti ilk cagrida bildirilen zaman / yerden farkliysa uyari; plan yoksa da uyari', async () => {
    const w = setup({ now: T0 });
    await w.call('POST', '', { ...meeting, secondMeetingPlan: { scheduledAt: '2026-12-29T19:00:00+03:00', location: 'Bahçe' } });
    w.clock.set(DURING);
    await w.attend('u1', 'present');
    await w.call('POST', '/asm1/quorum', { version: w.version() });
    await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-29T19:00:00+03:00', location: 'Bahçe', firstMeetingId: 'asm1' }); // asm2: uyumlu
    await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-30T19:00:00+03:00', firstMeetingId: 'asm1' }); // asm3: farkli
    expect((await w.call('GET', '/asm2')).body.warnings).toEqual([]);
    const diff = (await w.call('GET', '/asm3')).body.warnings;
    expect(diff[0]).toContain('İkinci toplantı, ilk toplantının çağrısında bildirilenden farklı: zaman (29.12.2026 19:00), yer (Bahçe)');
    const n = setup();
    await n.call('POST', '', meeting);
    await n.attend('u1', 'present');
    await n.call('POST', '/asm1/quorum', { version: n.version() });
    await n.call('POST', '', { ...meeting, scheduledAt: '2026-12-29T19:00:00+03:00', firstMeetingId: 'asm1' });
    expect((await n.call('GET', '/asm2')).body.warnings[0]).toContain('ikinci toplantının yeri ve zamanı kayıtlı değil');
  });
});

describe('katilim ilk karardan sonra donar; tutanak anlik goruntuden', () => {
  it('karar kaydedildikten sonra katilim 409; tutanak yeter sayisi kayitli anlik goruntuden', async () => {
    const w = await quorate();
    const tally = await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), yes: 2, no: 1, abstain: 0 });
    expect(tally.body.assembly).toMatchObject({ attendanceLockedAt: DURING, quorumRecord: { presentLandShare: { numerator: '900', denominator: '1000' }, proxyUnits: 0 } });
    const late = await w.attend('u3', 'present');
    expect(late.status).toBe(409);
    expect(late.body.message).toContain('Karar kaydedildikten sonra katılım değiştirilemez');
    expect((await w.attend('u1', 'absent')).status).toBe(409);
  });

  it('tutanak icerigi kayitli yeter sayiyi kullanir, canli degerle karistirmaz', () => {
    const live = { presentOwners: 4, totalOwners: 4, presentVotes: 4, totalVotes: 4, proxyUnits: 2, presentLandShare: { numerator: '1000', denominator: '1000' }, totalLandShare: { numerator: '1000', denominator: '1000' }, landShareComputable: true, ownersMajority: true, landShareMajority: true, met: true } as Quorum;
    const rec = { met: true, presentUnits: 3, totalUnits: 4, presentOwners: 3, totalOwners: 4, presentVotes: 3, totalVotes: 4, noAttendance: false, ownersMajority: true, landShareMajority: true, landShareComputable: true, proxyUnits: 0, presentLandShare: { numerator: '900', denominator: '1000' }, totalLandShare: { numerator: '1000', denominator: '1000' }, landShareBps: 9000, recordedAt: DURING, recordedBy: 'm' };
    const a = { assemblyId: 'asm1', apartmentId: APT, entityType: 'ASSEMBLY' as const, kind: 'ordinary' as const, secondMeeting: false, scheduledAt: '2026-12-15T16:00:00.000Z', rollDate: '2026-12-15', agenda: [{ itemId: 'a1', title: 'Bütçe' }], status: 'planned' as const, quorumRecord: rec, createdAt: T0, createdBy: 's', updatedAt: T0, updatedBy: 's', version: 3 };
    const content = minutesReport({ apartmentName: 'Lale', assembly: a, quorum: live, decisions: [], preview: true });
    const q = content.sections[1]!;
    expect(q.rows.map((r) => r.cells.slice(0, 3))).toEqual([
      ['Kat maliki (kişi)', '3', '4'],
      ['Oy (bağımsız bölüm; KMK m.31 sınırlı)', '3', '4'],
      ['Arsa payı', '900/1000', '1000/1000'],
      ['Sonuç: yeter sayı sağlandı', '', ''],
    ]);
    expect(q.rows[1]!.cells[3]).toBe('0 bölüm vekaleten');
  });
});

describe('arsa payi eksik: karar hesaplanamaz', () => {
  it('arsa payi gereken madde 422, kayit yazilmaz; dondurmadan once uyari; arsa payi gerekmeyen madde kaydedilir', async () => {
    const units = [...defaultUnits(), unit('u5', '5')];
    const w = setup({ units, members: [...defaultMembers(), owner('own-5', 'u5')], now: T0 });
    await w.call('POST', '', { ...meeting, agenda: [{ title: 'Yönetici seçimi', decisionKind: 'manager_election' }, { title: 'Yönetim planı', decisionKind: 'management_plan_change' }] });
    const before = (await w.call('GET', '/asm1')).body;
    expect(before.warnings[0]).toContain('1 bölümün arsa payı girilmemiş: arsa payı çoğunluğu gereken 1 gündem maddesi için karar hesaplanamaz');
    expect(before.warnings[0]).toContain('arsa paylarını önce girin');
    w.clock.set(DURING);
    // Ikinci toplanti olmadan yeter sayi arsa payi eksikliginde saglanamaz; ikinci toplantida dene.
    await w.attend('u1', 'present');
    await w.call('POST', '/asm1/quorum', { version: w.version() });
    await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-22T19:00:00+03:00', firstMeetingId: 'asm1', agenda: [{ title: 'Yönetici seçimi', decisionKind: 'manager_election' }, { title: 'Yönetim planı', decisionKind: 'management_plan_change' }] });
    w.clock.set('2026-12-22T16:30:00.000Z');
    for (const u of ['u1', 'u3', 'u4', 'u5']) await w.attend(u, 'present', {}, 'asm2');
    const res = await w.call('POST', '/asm2/agenda/a1/tally', { version: w.version('asm2'), votes: { u1: 'yes', u3: 'yes', u4: 'yes', u5: 'yes' } });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('hesaplanamaz; karar kaydedilmedi');
    expect([...w.extra.keys()].some((k) => k.includes('ASMDEC#asm2#a1'))).toBe(false);
    expect(w.docs.get(`${APT}|asm2`)!.agenda[0]!.tally).toBeUndefined();
    const plan = await w.call('POST', '/asm2/agenda/a2/tally', { version: w.version('asm2'), votes: { u1: 'yes', u3: 'yes', u4: 'yes', u5: 'yes' } });
    expect(plan.status).toBe(200);
    // Arsa payi gerekmeyen besde dort (oy): 5 oyun 4'u tam besde dort, kabul.
    expect(plan.body.decision.outcome).toMatchObject({ rule: 'four_fifths_votes', decision: 'accepted', votes: { yes: 4 }, allVotes: 5, required: { votes: 4 } });
  });
});

describe("Y1'den kalan sayim", () => {
  it('duzeltme ilk degismez kayittir (sira 1, supersedes yok), eski sayim kayitta korunur; tutanak ve karar defteri gosterir', async () => {
    const w = await quorate();
    // Y1 verisi: karar turu / sira / ASMDEC# yok.
    const doc = w.docs.get(`${APT}|asm1`)!;
    doc.agenda[1] = { itemId: 'a2', title: 'İşletme projesi', tally: { yes: 1, no: 2, abstain: 0, presentVotes: 3, decision: 'rejected', recordedAt: DURING, recordedBy: 'mgr-1' } };
    doc.agenda[0] = { itemId: 'a1', title: 'Yönetim kurulu seçimi', tally: { yes: 2, no: 1, abstain: 0, presentVotes: 3, decision: 'accepted', recordedAt: DURING, recordedBy: 'mgr-1' } };
    expect((await w.call('POST', '/asm1/agenda/a2/tally', { version: w.version(), yes: 2, no: 1, abstain: 0 })).status).toBe(409);
    const fixed = await w.call('POST', '/asm1/agenda/a2/tally', { version: w.version(), yes: 2, no: 1, abstain: 0, correctionReason: 'Y1 sayımı hatalı' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.decision).toMatchObject({ seq: 1, correctionReason: 'Y1 sayımı hatalı', legacyTally: { yes: 1, decision: 'rejected' } });
    expect(fixed.body.decision.supersedes).toBeUndefined();
    expect([...w.extra.keys()]).toContain(`APT#${APT}|ASMDEC#asm1#a2#001`);
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.tally_correction', details: { seq: 1, correctsLegacyTally: true } });
    // Sonraki duzeltme normal zincir: sira 2, supersedes 1.
    const again = await w.call('POST', '/asm1/agenda/a2/tally', { version: w.version(), yes: 1, no: 2, abstain: 0, correctionReason: 'Tekrar sayıldı' });
    expect(again.body.decision).toMatchObject({ seq: 2, supersedes: 1 });

    const a = w.docs.get(`${APT}|asm1`)!;
    const decisions = await w.repo.listDecisions(APT, 'asm1');
    const live = { presentOwners: 3, totalOwners: 4, presentVotes: 3, totalVotes: 4, proxyUnits: 0, presentLandShare: null, totalLandShare: null, landShareComputable: true, ownersMajority: true, landShareMajority: true, met: true } as unknown as Quorum;
    const minutes = minutesReport({ apartmentName: 'Lale', assembly: a, quorum: live, decisions, preview: true });
    const legacyItem = minutes.sections.find((s) => s.title === '1. Yönetim kurulu seçimi')!;
    expect(legacyItem.paragraphs?.[0]).toContain('Karar türü kaydı yok (Y1 sayımı)');
    expect(legacyItem.rows.at(-1)?.cells[0]).toBe('Sonuç: KABUL EDİLDİ');
    const corrected = minutes.sections.find((s) => s.title === '2. İşletme projesi')!;
    expect(corrected.paragraphs?.join(' ')).toContain('Düzeltilen Y1 sayımı');
    const book = decisionBookReport({ apartmentName: 'Lale', assemblies: [a], decisions });
    const cells = book.sections[0]!.rows.map((r) => [r.cells[2], r.cells[3], r.muted ?? false]);
    expect(cells).toEqual([
      ['Yönetim kurulu seçimi', 'Y1 sayımı (karar türü yok)', false],
      ['İşletme projesi', 'Y1 sayımı (karar türü yok)', true],
      ['İşletme projesi', 'Katılanların oy çokluğu', true],
      ['İşletme projesi', 'Katılanların oy çokluğu', false],
    ]);
  });
});

describe('hazir tur ve ozel cogunluk dogrulamasi', () => {
  it('denetci secimi kisi + arsa payi; ozel turde ucte iki secilebilir; hazir turde ozel cogunluk reddedilir', async () => {
    const { call } = setup({ units: [unit('u1', '1', ls(500)), unit('u2', '2', ls(500))], members: [owner('a', 'u1'), owner('b', 'u2')] });
    const res = await call('POST', '', { ...meeting, agenda: [{ title: 'Denetçi', decisionKind: 'auditor_election' }, { title: 'Toplu yapı planı', decisionKind: 'custom', majority: 'two_thirds_votes' }] });
    expect(res.body.agenda.map((i: any) => i.majority)).toEqual(['persons_and_land', 'two_thirds_votes']);
    expect((await call('POST', '', { ...meeting, agenda: [{ title: 'X', decisionKind: 'management_plan_change', majority: 'two_thirds_votes' }] })).status).toBe(400);
  });
});
