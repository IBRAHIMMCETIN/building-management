/**
 * Genel kurul devami: madde basina karar yeter sayisi - SAF hesap (KMK m.19, m.24, m.28, m.30, m.34,
 * m.41, m.42, m.44, m.45 yorumu; README "Hukuki yorum"). "Sayi" kisi, "oyu" m.31 oyu; payda butun kat
 * malikleri; besde dort / ucte iki yuvarlamasi; arsa payi eksikligi; hisseli bolum temsilcisi; oybirligi.
 */
import { describe, expect, it } from 'vitest';
import { DECISION_PRESETS, decideByCounts, decideByUnits, landShareMissing, requiredFor, unitVotesIssue, type VoteChoice } from '../src/modules/assemblies/majority.js';
import { decide } from '../src/modules/assemblies/quorum.js';

type E = { unitId: string; owners: { userId: string }[]; weight: string; representativeUserId?: string };
const entry = (unitId: string, owners: string[], weight = '100', representativeUserId?: string): E => ({
  unitId,
  owners: owners.map((userId) => ({ userId })),
  weight,
  ...(representativeUserId ? { representativeUserId } : {}),
});
const meta = (over: Partial<{ denominator: string | null; missingLandShare: number; totalWeight: string }> = {}) => ({ denominator: '1000', missingLandShare: 0, totalWeight: '1000', ...over });
const present = (...ids: string[]) => ids.map((unitId) => ({ unitId, mode: 'present' as const }));
const votes = (o: Record<string, VoteChoice>) => new Map(Object.entries(o));
const base = (n: number) => ({ presentVotes: n, allVotes: n, totalPersons: n, totalLand: 1000n, totalUnits: n });

describe('karar yeter sayisi - esikler ve yuvarlama', () => {
  it('besde dort ve ucte iki yukari yuvarlanir; kisi ve oy esikleri ayri; oybirligi tum bolumler', () => {
    expect(requiredFor('four_fifths_persons', base(7)).persons).toBe(6);
    expect(requiredFor('four_fifths_votes', base(10)).votes).toBe(8);
    expect(requiredFor('four_fifths_votes', base(6)).votes).toBe(5);
    expect(requiredFor('two_thirds_votes', base(9)).votes).toBe(6);
    expect(requiredFor('two_thirds_votes', base(10)).votes).toBe(7);
    expect(requiredFor('persons_and_land', base(10))).toEqual({ votes: null, persons: 6, land: 501n, units: null });
    expect(requiredFor('four_fifths_persons_and_land', { ...base(10), totalLand: 1001n }).land).toBe(801n);
    expect(requiredFor('unanimous', base(9))).toEqual({ votes: null, persons: null, land: null, units: 9 });
    expect(requiredFor('attendees', base(5)).votes).toBe(3);

    const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((u) => entry(u, [`o-${u}`]));
    const all = present(...entries.map((e) => e.unitId));
    const yesN = (n: number) => votes(Object.fromEntries(entries.map((e, i) => [e.unitId, i < n ? 'yes' : 'no'])));
    expect(decideByUnits({ rule: 'four_fifths_persons', entries, meta: meta({ totalWeight: '700' }), attendance: all, votes: yesN(5) }).decision).toBe('rejected');
    const six = decideByUnits({ rule: 'four_fifths_persons', entries, meta: meta({ totalWeight: '700' }), attendance: all, votes: yesN(6) });
    expect(six).toMatchObject({ decision: 'accepted', persons: { yes: 6, no: 1, total: 7 }, required: { persons: 6 } });
  });

  it('payda butun kat malikleri: katilanlarin cogunlugu yetse de sayi ve arsa payi cogunlugu saglanmaz', () => {
    const entries = [entry('u1', ['a'], '100'), entry('u2', ['b'], '100'), entry('u3', ['c'], '100'), entry('u4', ['d'], '700')];
    const att = present('u1', 'u2', 'u4');
    const v = votes({ u1: 'yes', u2: 'yes', u4: 'no' });
    expect(decideByUnits({ rule: 'attendees', entries, meta: meta(), attendance: att, votes: v })).toMatchObject({ decision: 'accepted', presentVotes: 3 });
    const q = decideByUnits({ rule: 'persons_and_land', entries, meta: meta(), attendance: att, votes: v });
    expect(q).toMatchObject({ decision: 'rejected', persons: { yes: 2, no: 1, absent: 1, total: 4 }, units: { yes: 2, no: 1, absent: 1 }, landShareBps: { yes: 2000, no: 7000 } });
    expect(q.reasons).toEqual(['Kabul eden kat maliki (2 kişi) bütün kat maliklerinin (4 kişi) yarısından fazla değil', 'Kabul eden bölümlerin arsa payı toplam arsa payının yarısından fazla değil']);
    const land = decideByUnits({ rule: 'persons_and_land', entries, meta: meta(), attendance: att, votes: votes({ u1: 'yes', u4: 'yes', u2: 'no' }) });
    expect(land.reasons).toEqual(['Kabul eden kat maliki (2 kişi) bütün kat maliklerinin (4 kişi) yarısından fazla değil']);
  });

  it('arsa payi eksikse arsa payi gereken kural hesaplanamaz (landShareMissing); kisi ve oy kurallari etkilenmez', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map((u) => entry(u, [`o-${u}`], u === 'e' ? '0' : '250'));
    const m = meta({ missingLandShare: 1 });
    expect(landShareMissing('persons_and_land', m)).toContain('1 bölümün arsa payı girilmemiş');
    expect(landShareMissing('four_fifths_persons_and_land', meta({ denominator: null, missingLandShare: 5 }))).toContain('hesaplanamaz');
    for (const r of ['attendees', 'four_fifths_persons', 'four_fifths_votes', 'two_thirds_votes', 'unanimous'] as const) expect(landShareMissing(r, m)).toBeNull();
    const yes = votes({ a: 'yes', b: 'yes', c: 'yes', d: 'yes', e: 'yes' });
    const all = present('a', 'b', 'c', 'd', 'e');
    expect(decideByUnits({ rule: 'four_fifths_persons', entries, meta: m, attendance: all, votes: yes }).decision).toBe('accepted');
    expect(decideByUnits({ rule: 'four_fifths_votes', entries, meta: m, attendance: all, votes: yes })).toMatchObject({ decision: 'accepted', landShare: null });
  });
});

describe('karar yeter sayisi - kisi mi oy mu (hazir tur basina)', () => {
  // 6 bolum: P dordunun maliki; x ve y birer. Kisi 3; oy siniri floor(6/3) = 2, butun oylar 2 + 1 + 1 = 4.
  const entries = [entry('a', ['P']), entry('b', ['P']), entry('c', ['P']), entry('d', ['P']), entry('e', ['x']), entry('f', ['y'])];
  const all = present('a', 'b', 'c', 'd', 'e', 'f');
  const by = (p: VoteChoice, x: VoteChoice, y: VoteChoice) => votes({ a: p, b: p, c: p, d: p, e: x, f: y });
  const m6 = meta({ totalWeight: '600' });
  const run = (rule: Parameters<typeof decideByUnits>[0]['rule'], v: ReturnType<typeof by>) => decideByUnits({ rule, entries, meta: m6, attendance: all, votes: v });

  it('yonetici / denetci / faydali yenilik (m.34, m.41, m.42 "sayi ve arsa payi"): kisi sayilir; dort bolumlu malik tek kisidir', () => {
    expect(DECISION_PRESETS.manager_election.rule).toBe('persons_and_land');
    expect(DECISION_PRESETS.auditor_election.rule).toBe('persons_and_land');
    expect(DECISION_PRESETS.beneficial_improvement.rule).toBe('persons_and_land');
    // P tek basina: arsa payi 4/6 ama kisi 1/3 -> ret.
    expect(run('persons_and_land', by('yes', 'no', 'no'))).toMatchObject({ decision: 'rejected', persons: { yes: 1, total: 3 }, votes: { yes: 2, no: 2 } });
    // P + x: kisi 2/3, arsa payi 5/6 -> kabul. Kisi sayiminda m.31 uyarisi uretilmez.
    const ok = run('persons_and_land', by('yes', 'yes', 'no'));
    expect(ok).toMatchObject({ decision: 'accepted', persons: { yes: 2, no: 1 } });
    expect(ok.warnings).toEqual([]);
  });

  it('yonetim plani (m.28 "besde dordunun oyu"): m.31 oyu, sinir paydada da; herkes kabul ederse ulasilir', () => {
    expect(DECISION_PRESETS.management_plan_change.rule).toBe('four_fifths_votes');
    const allYes = run('four_fifths_votes', by('yes', 'yes', 'yes'));
    expect(allYes).toMatchObject({ decision: 'accepted', allVotes: 4, totalVotes: 6, voteCap: 2, votes: { yes: 4 }, required: { votes: 4 } });
    expect(allYes.warnings[0]).toContain('üçte biriyle (en fazla 2 oy)');
    expect(run('four_fifths_votes', by('yes', 'yes', 'no'))).toMatchObject({ decision: 'rejected', votes: { yes: 3 } });
  });

  it('ortak yer degisikligi (m.19/2 "yazili riza"): kisi sayisiyla besde dort', () => {
    expect(DECISION_PRESETS.common_area_change.rule).toBe('four_fifths_persons');
    expect(run('four_fifths_persons', by('yes', 'yes', 'no'))).toMatchObject({ decision: 'rejected', persons: { yes: 2, total: 3 }, required: { persons: 3 } });
    expect(run('four_fifths_persons', by('yes', 'yes', 'yes')).decision).toBe('accepted');
  });

  it('hisseli bolum kisi sayiminda oy listesindeki temsilciyle bir kez; ayni kisiye dusen bolumler ayni oyu alir', () => {
    // c: P ve Q hisseli, oy listesinde temsilci P; toplantida Q temsil ediyor.
    const es = [entry('a', ['P']), entry('c', ['P', 'Q'], '100', 'P'), entry('e', ['x'])];
    const att = [
      { unitId: 'a', mode: 'present' as const },
      { unitId: 'c', mode: 'present' as const, attendee: { userId: 'Q' } },
      { unitId: 'e', mode: 'present' as const },
    ];
    const v = votes({ a: 'yes', c: 'no', e: 'yes' });
    // Oy kurali: P ve Q ayri seçmenler, tutarli.
    expect(unitVotesIssue(es, att, v, 'four_fifths_votes')).toBeNull();
    // Kisi kurali: a ve c ayni kat maliki kimligi (P) -> farkli oy olamaz.
    expect(unitVotesIssue(es, att, v, 'persons_and_land')).toContain('Kişi sayımında');
    const ok = decideByUnits({ rule: 'four_fifths_persons', entries: es, meta: meta({ totalWeight: '300' }), attendance: att, votes: votes({ a: 'yes', c: 'yes', e: 'yes' }) });
    expect(ok).toMatchObject({ persons: { yes: 2, total: 2 }, decision: 'accepted' });
  });

  it('oybirligi (m.24/2, m.42/4, m.44, m.45): katilmayan veya kabul etmeyen bolum oybirligini bozar', () => {
    for (const k of ['use_change', 'central_heating_conversion', 'major_disposition', 'additional_floor'] as const) expect(DECISION_PRESETS[k].rule).toBe('unanimous');
    expect(DECISION_PRESETS.central_heating_conversion.legal).toBe('KMK m.42/4');
    expect(DECISION_PRESETS.use_change.hint).toContain('m.24/1');
    const es = [entry('a', ['x']), entry('b', ['y']), entry('c', ['z'])];
    const two = decideByUnits({ rule: 'unanimous', entries: es, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b'), votes: votes({ a: 'yes', b: 'yes' }) });
    expect(two).toMatchObject({ decision: 'rejected', units: { yes: 2, absent: 1 } });
    expect(two.reasons[0]).toBe('Oybirliği için bütün bölümlerin (3) kabul oyu gerekir: 1 bölüm katılmadı');
    const abstain = decideByUnits({ rule: 'unanimous', entries: es, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b', 'c'), votes: votes({ a: 'yes', b: 'yes', c: 'abstain' }) });
    expect(abstain.reasons[0]).toContain('1 bölüm kabul etmedi');
    expect(decideByUnits({ rule: 'unanimous', entries: es, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b', 'c'), votes: votes({ a: 'yes', b: 'yes', c: 'yes' }) }).decision).toBe('accepted');
  });

  it('ozel tur: ucte iki (oy) toplu yapi icin; m.19/2 etiketi olagan onarimi kapsamaz', () => {
    expect(run('two_thirds_votes', by('yes', 'no', 'no'))).toMatchObject({ decision: 'rejected', votes: { yes: 2 }, required: { votes: 3 } });
    expect(run('two_thirds_votes', by('yes', 'yes', 'no')).decision).toBe('accepted');
    expect(DECISION_PRESETS.common_area_change.label).not.toContain('onarım');
    expect(DECISION_PRESETS.common_area_change.hint).toContain('m.35/b');
  });
});

describe('karar yeter sayisi - giris dogrulamasi ve oy sayisi girisi', () => {
  it('ayni kisinin oyunu kullandigi bolumler ayni oyu alir; katilmayan / listede olmayan bolume oy girilemez', () => {
    const es = [entry('d', ['y', 'z']), entry('e', ['z']), entry('f', ['w'])];
    const att = [
      { unitId: 'd', mode: 'present' as const, attendee: { userId: 'z' } },
      { unitId: 'e', mode: 'present' as const },
    ];
    expect(unitVotesIssue(es, att, votes({ d: 'yes', e: 'no' }))).toContain('Aynı kişinin');
    expect(unitVotesIssue(es, att, votes({ d: 'yes' }))).toContain('Aynı kişinin');
    expect(unitVotesIssue(es, att, votes({ d: 'yes', e: 'yes' }))).toBeNull();
    expect(unitVotesIssue(es, att, votes({ f: 'yes' }))).toContain('katılmadı');
    expect(unitVotesIssue(es, att, votes({ x: 'yes' }))).toContain('oy listesinde yok');
  });

  it('oy sayisi girisi (katilanlarin cogunlugu) eski karar kuraliyla ayni', () => {
    const es = [entry('a', ['x']), entry('b', ['y']), entry('c', ['z'])];
    for (const [yes, no] of [[2, 1], [1, 1], [0, 0]] as const) {
      const o = decideByCounts({ entries: es, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b', 'c'), yes, no, abstain: 0 });
      expect(o.decision).toBe(decide(yes, 3));
      expect(o).toMatchObject({ mode: 'counts', units: null, persons: null, landShare: null, required: { votes: 2 } });
    }
  });
});
