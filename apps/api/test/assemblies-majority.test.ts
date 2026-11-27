/**
 * Genel kurul devami: madde basina karar yeter sayisi - SAF hesap (KMK m.19, m.24, m.28, m.30,
 * m.34, m.42, m.44, m.45 yorumu; README "Hukuki yorum"). Payda butun kat malikleri, m.31 kisi
 * siniri, besde dort yuvarlamasi, arsa payi eksikligi, hisseli bolum temsilcisi, oybirligi.
 */
import { describe, expect, it } from 'vitest';
import { DECISION_PRESETS, decideByCounts, decideByUnits, requiredFor, unitVotesIssue, type VoteChoice } from '../src/modules/assemblies/majority.js';
import { decide } from '../src/modules/assemblies/quorum.js';

type E = { unitId: string; owners: { userId: string }[]; weight: string; representativeUserId?: string };
const entry = (unitId: string, owners: string[], weight = '100'): E => ({ unitId, owners: owners.map((userId) => ({ userId })), weight });
const meta = (over: Partial<{ denominator: string | null; missingLandShare: number; totalWeight: string }> = {}) => ({ denominator: '1000', missingLandShare: 0, totalWeight: '1000', ...over });
const present = (...ids: string[]) => ids.map((unitId) => ({ unitId, mode: 'present' as const }));
const votes = (o: Record<string, VoteChoice>) => new Map(Object.entries(o));

describe('karar yeter sayisi - saf hesap', () => {
  it('besde dort yukari yuvarlanir (bütün oylar 7 -> 6, 10 -> 8, 6 -> 5); oybirligi tum bolumler', () => {
    expect(requiredFor('four_fifths_owners', 0, 7, 0n, 7).votes).toBe(6);
    expect(requiredFor('four_fifths_owners', 0, 10, 0n, 10).votes).toBe(8);
    expect(requiredFor('four_fifths_owners', 0, 6, 0n, 6).votes).toBe(5);
    expect(requiredFor('owners_and_land', 0, 10, 1000n, 10)).toEqual({ votes: 6, land: 501n, units: null });
    expect(requiredFor('four_fifths_owners_and_land', 0, 10, 1001n, 10).land).toBe(801n);
    expect(requiredFor('unanimous', 0, 9, 0n, 9)).toEqual({ votes: 9, land: null, units: 9 });

    const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((u) => entry(u, [`o-${u}`]));
    const all = present(...entries.map((e) => e.unitId));
    const yesN = (n: number) => votes(Object.fromEntries(entries.map((e, i) => [e.unitId, i < n ? 'yes' : 'no'])));
    expect(decideByUnits({ rule: 'four_fifths_owners', entries, meta: meta({ totalWeight: '700' }), attendance: all, votes: yesN(5) }).decision).toBe('rejected');
    const six = decideByUnits({ rule: 'four_fifths_owners', entries, meta: meta({ totalWeight: '700' }), attendance: all, votes: yesN(6) });
    expect(six).toMatchObject({ decision: 'accepted', allVotes: 7, required: { votes: 6 }, votes: { yes: 6, no: 1 } });
  });

  it('payda butun kat malikleri: katilanlarin cogunlugu yetse de sayi ve arsa payi cogunlugu saglanmaz', () => {
    const entries = [entry('u1', ['a'], '100'), entry('u2', ['b'], '100'), entry('u3', ['c'], '100'), entry('u4', ['d'], '700')];
    const att = present('u1', 'u2', 'u4');
    const v = votes({ u1: 'yes', u2: 'yes', u4: 'no' });
    expect(decideByUnits({ rule: 'attendees', entries, meta: meta(), attendance: att, votes: v })).toMatchObject({ decision: 'accepted', presentVotes: 3 });
    const q = decideByUnits({ rule: 'owners_and_land', entries, meta: meta(), attendance: att, votes: v });
    expect(q).toMatchObject({ decision: 'rejected', allVotes: 4, units: { yes: 2, no: 1, absent: 1 }, landShare: { yes: { numerator: '200', denominator: '1000' } }, landShareBps: { yes: 2000, no: 7000 } });
    expect(q.reasons).toHaveLength(2);
    // Arsa payi saglanip sayi saglanmazsa da ret (iki olcut birlikte).
    const land = decideByUnits({ rule: 'owners_and_land', entries, meta: meta(), attendance: att, votes: votes({ u1: 'yes', u4: 'yes', u2: 'no' }) });
    expect(land.decision).toBe('rejected');
    expect(land.reasons).toEqual(['Kabul oyu (2) bütün kat maliklerinin oyunun (4) yarısından fazla değil']);
  });

  it('arsa payi eksik bolum varsa arsa payi gereken kararlar alinmaz; sayica besde dort etkilenmez', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map((u) => entry(u, [`o-${u}`], u === 'e' ? '0' : '250'));
    const m = meta({ missingLandShare: 1 });
    const all = present('a', 'b', 'c', 'd', 'e');
    const yes = votes({ a: 'yes', b: 'yes', c: 'yes', d: 'yes', e: 'yes' });
    const q = decideByUnits({ rule: 'owners_and_land', entries, meta: m, attendance: all, votes: yes });
    expect(q).toMatchObject({ decision: 'rejected', landShareComputable: false, landShare: null, totalLandShare: null });
    expect(q.reasons[0]).toContain('1 bölümün arsa payı girilmemiş');
    expect(decideByUnits({ rule: 'four_fifths_owners', entries, meta: m, attendance: all, votes: yes }).decision).toBe('accepted');
    expect(decideByUnits({ rule: 'four_fifths_owners_and_land', entries, meta: m, attendance: all, votes: yes }).decision).toBe('rejected');
  });

  it('KMK m.31 ucte bir siniri pay ve paydada: baskin malik tek basina gecemez, herkes kabul ederse besde dort ulasilabilir', () => {
    // 6 bolum: P dordunun maliki; sinir floor(6/3) = 2. Butun kat maliklerinin oyu 2 + 1 + 1 = 4.
    const entries = [entry('a', ['P']), entry('b', ['P']), entry('c', ['P']), entry('d', ['P']), entry('e', ['x']), entry('f', ['y'])];
    const all = present('a', 'b', 'c', 'd', 'e', 'f');
    const by = (p: VoteChoice, x: VoteChoice, y: VoteChoice) => votes({ a: p, b: p, c: p, d: p, e: x, f: y });
    const onlyP = decideByUnits({ rule: 'owners_and_land', entries, meta: meta({ totalWeight: '600' }), attendance: all, votes: by('yes', 'no', 'no') });
    expect(onlyP).toMatchObject({ decision: 'rejected', voteCap: 2, allVotes: 4, totalVotes: 6, votes: { yes: 2, no: 2 }, units: { yes: 4, no: 2 } });
    expect(onlyP.warnings[0]).toContain('üçte biriyle (en fazla 2 oy)');
    expect(decideByUnits({ rule: 'owners_and_land', entries, meta: meta({ totalWeight: '600' }), attendance: all, votes: by('yes', 'yes', 'no') }).decision).toBe('accepted');
    expect(decideByUnits({ rule: 'four_fifths_owners', entries, meta: meta({ totalWeight: '600' }), attendance: all, votes: by('yes', 'yes', 'yes') })).toMatchObject({ decision: 'accepted', votes: { yes: 4 } });
    expect(decideByUnits({ rule: 'four_fifths_owners', entries, meta: meta({ totalWeight: '600' }), attendance: all, votes: by('yes', 'yes', 'no') }).decision).toBe('rejected');
  });

  it('oybirligi: katilmayan veya kabul etmeyen bolum oybirligini bozar', () => {
    const entries = [entry('a', ['x']), entry('b', ['y']), entry('c', ['z'])];
    const two = decideByUnits({ rule: 'unanimous', entries, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b'), votes: votes({ a: 'yes', b: 'yes' }) });
    expect(two).toMatchObject({ decision: 'rejected', units: { yes: 2, absent: 1 } });
    expect(two.reasons[0]).toBe('Oybirliği için bütün bölümlerin (3) kabul oyu gerekir: 1 bölüm katılmadı');
    const abstain = decideByUnits({ rule: 'unanimous', entries, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b', 'c'), votes: votes({ a: 'yes', b: 'yes', c: 'abstain' }) });
    expect(abstain.reasons[0]).toContain('1 bölüm kabul etmedi');
    expect(decideByUnits({ rule: 'unanimous', entries, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b', 'c'), votes: votes({ a: 'yes', b: 'yes', c: 'yes' })}).decision).toBe('accepted');
  });

  it('hisseli bolum temsilcisi: ayni kisinin bolumleri ayni oyu alir; katilmayan bolume oy girilemez', () => {
    const entries = [entry('d', ['y', 'z']), entry('e', ['z']), entry('f', ['w'])];
    const att = [
      { unitId: 'd', mode: 'present' as const, attendee: { userId: 'z' } },
      { unitId: 'e', mode: 'present' as const },
    ];
    expect(unitVotesIssue(entries, att, votes({ d: 'yes', e: 'no' }))).toContain('Aynı kişinin');
    expect(unitVotesIssue(entries, att, votes({ d: 'yes' }))).toContain('Aynı kişinin');
    expect(unitVotesIssue(entries, att, votes({ d: 'yes', e: 'yes' }))).toBeNull();
    expect(unitVotesIssue(entries, att, votes({ f: 'yes' }))).toContain('katılmadı');
    expect(unitVotesIssue(entries, att, votes({ x: 'yes' }))).toContain('oy listesinde yok');
    // y temsil ederse farkli kisiler: farkli oy serbest.
    const byY = [{ ...att[0]!, attendee: { userId: 'y' } }, att[1]!];
    expect(unitVotesIssue(entries, byY, votes({ d: 'yes', e: 'no' }))).toBeNull();
  });

  it('oy sayisi girisi (katilanlarin cogunlugu) eski karar kuraliyla ayni', () => {
    const entries = [entry('a', ['x']), entry('b', ['y']), entry('c', ['z'])];
    for (const [yes, no] of [[2, 1], [1, 1], [0, 0]] as const) {
      const o = decideByCounts({ entries, meta: meta({ totalWeight: '300' }), attendance: present('a', 'b', 'c'), yes, no, abstain: 0 });
      expect(o.decision).toBe(decide(yes, 3));
      expect(o).toMatchObject({ mode: 'counts', units: null, landShare: null, required: { votes: 2 } });
    }
  });

  it('hazir karar turleri kanundaki cogunluga eslenir', () => {
    expect(Object.fromEntries(Object.entries(DECISION_PRESETS).map(([k, v]) => [k, v.rule]))).toEqual({
      general: 'attendees',
      operating_budget: 'attendees',
      manager_election: 'owners_and_land',
      beneficial_improvement: 'owners_and_land',
      common_area_change: 'four_fifths_owners',
      management_plan_change: 'four_fifths_owners',
      use_change: 'unanimous',
      central_heating_conversion: 'unanimous',
      major_disposition: 'unanimous',
      additional_floor: 'unanimous',
    });
  });
});

