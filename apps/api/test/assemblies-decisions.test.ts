/**
 * Genel kurul devami: gundem maddesi karar turu, degismez karar kayitlari ve duzeltme, tutanak /
 * kesinlestirme, tutanak ve karar defteri PDF'leri, roller ve tenant izolasyonu (HTTP uzerinden).
 * Saf cogunluk hesabi: assemblies-majority.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { wrapText } from '../src/modules/documents/reportPdf.js';
import { APT, ls, meeting, owner, setup, unit } from './fakes/assemblyWorld.js';

const qualified = {
  ...meeting,
  agenda: [
    { title: 'Ahmet Bey yönetici seçilsin', decisionKind: 'manager_election' },
    { title: 'İşletme projesi', decisionKind: 'operating_budget' },
    { title: 'Dış cephe boyası', decisionKind: 'common_area_change' },
    { title: 'Yönetim planında aidat maddesi', decisionKind: 'custom', majority: 'four_fifths_persons_and_land' },
  ],
};

/** u1, u2 (own-2a temsil), u4 katilir: yeter sayi saglanir (3/4 malik, 900/1000 arsa payi). */
async function heldQuorum() {
  const w = setup();
  await w.call('POST', '', qualified);
  await w.attend('u1', 'present');
  await w.attend('u2', 'present', { attendeeUserId: 'own-2a' });
  await w.attend('u4', 'present');
  return w;
}

describe('gundem karar turu ve kayit', () => {
  it('gundem maddesi karar turunu ve kanundaki cogunlugu saklar; hazir turde farkli cogunluk ve cogunluksuz ozel tur 400', async () => {
    const { call } = setup();
    const res = await call('POST', '', qualified);
    expect(res.status).toBe(201);
    expect(res.body.agenda.map((i: any) => [i.decisionKind, i.majority])).toEqual([
      ['manager_election', 'persons_and_land'],
      ['operating_budget', 'attendees'],
      ['common_area_change', 'four_fifths_persons'],
      ['custom', 'four_fifths_persons_and_land'],
    ]);
    expect((await call('POST', '', meeting)).body.agenda[0]).toMatchObject({ decisionKind: 'general', majority: 'attendees' });
    for (const bad of [{ title: 'X', decisionKind: 'manager_election', majority: 'attendees' }, { title: 'X', decisionKind: 'custom' }, { title: 'X', decisionKind: 'nope' }]) {
      expect((await call('POST', '', { ...meeting, agenda: [bad] })).status).toBe(400);
    }
  });

  it('nitelikli cogunluk bolum bazinda oy ister; payda butun kat malikleri (katilanlar cogunlugu yetmez)', async () => {
    const { call, version, extra } = await heldQuorum();
    const counts = await call('POST', '/asm1/agenda/a1/tally', { version: version(), yes: 2, no: 1, abstain: 0 });
    expect(counts.status).toBe(400);
    expect(counts.body.message).toContain('bölüm bazında oy');
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u3: 'yes' } })).status).toBe(400);
    const r = await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'no' } });
    expect(r.status).toBe(200);
    expect(r.body.decision.outcome).toMatchObject({ rule: 'persons_and_land', decision: 'rejected', allVotes: 4, presentVotes: 3, units: { yes: 2, no: 1, absent: 1 }, persons: { yes: 2, no: 1, absent: 1, total: 4 } });
    expect(r.body.assembly.agenda[0].tally).toMatchObject({ decision: 'rejected', rule: 'persons_and_land', mode: 'units', seq: 1, yes: 2, no: 1 });
    expect([...extra.keys()]).toContain(`APT#${APT}|ASMDEC#asm1#a1#001`);
    // Ayni oylar katilanlarin cogunlugu kuralinda kabul.
    const b = await call('POST', '/asm1/agenda/a2/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'no' } });
    expect(b.body.decision.outcome).toMatchObject({ rule: 'attendees', decision: 'accepted' });
    // Besde dort: 3 katilan bolumun hepsi kabul etse de 4 oyun 4'u gerekir.
    const c = await call('POST', '/asm1/agenda/a3/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'yes' } });
    expect(c.body.decision.outcome).toMatchObject({ decision: 'rejected', required: { persons: 4 }, persons: { yes: 3, total: 4 } });
  });

  it('karar degismez: ikinci kayit yalnizca gerekceli duzeltme (yeni sira, onceki kayit korunur, denetimli)', async () => {
    const { call, version, extra, audits } = await heldQuorum();
    await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'no' } });
    const again = await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'yes' } });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('değiştirilemez');
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'yes' }, correctionReason: 'x' })).status).toBe(400);
    const fixed = await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u4: 'yes' }, correctionReason: 'B Blok oyu yanlış girildi' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.decision).toMatchObject({ seq: 2, supersedes: 1, correctionReason: 'B Blok oyu yanlış girildi', outcome: { decision: 'accepted' } });
    expect(fixed.body.assembly.agenda[0].tally).toMatchObject({ seq: 2, decision: 'accepted' });
    const first = extra.get(`APT#${APT}|ASMDEC#asm1#a1#001`) as any;
    expect(first.outcome.decision).toBe('rejected');
    expect(first.unitVotes).toEqual({ u1: 'yes', u2: 'yes', u4: 'no' });
    const log = audits.filter((a) => a.action.startsWith('assembly.tally'));
    expect(log.map((a) => a.action)).toEqual(['assembly.tally', 'assembly.tally_correction']);
    expect(log[1]).toMatchObject({ reason: 'B Blok oyu yanlış girildi', details: { seq: 2, supersedes: 1, corrected: true, decision: 'accepted' } });
    expect(log[0]?.details?.votesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(log)).not.toContain('"u4":"no"');
    // Ayrinti tum kayitlari sirayla verir.
    const d = (await call('GET', '/asm1')).body;
    expect(d.decisions.map((x: any) => [x.itemId, x.seq])).toEqual([
      ['a1', 1],
      ['a1', 2],
    ]);
    // Karar kaydedilmis toplanti iptal edilemez.
    expect((await call('POST', '/asm1/cancel', { version: version(), reason: 'Vazgeçildi' })).status).toBe(409);
  });

  it('hisseli bolumun temsilcisi ve ayni kisinin bolumleri: tutarsiz oy 400', async () => {
    const units = [unit('u1', '1', ls(250)), unit('u2', '2', ls(250)), unit('u3', '3', ls(250)), unit('u4', '4', ls(250))];
    const half = { ownershipShare: { numerator: 1, denominator: 2 } };
    const members = [owner('P', 'u1'), owner('P', 'u2', half), owner('Q', 'u2', half), owner('R', 'u3'), owner('S', 'u4')];
    const { call, attend, version } = setup({ units, members });
    await call('POST', '', qualified);
    await attend('u1', 'present');
    await attend('u2', 'present', { attendeeUserId: 'P' });
    await attend('u3', 'present');
    const bad = await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'no', u3: 'yes' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('Aynı kişinin');
    const ok = await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes', u2: 'yes', u3: 'no' } });
    // Sinir floor(4/3) = 1: P iki bolumle 1 oy; butun oylar P1 + R1 + S1 = 3; kabul 1 -> ret.
    expect(ok.body.decision.outcome).toMatchObject({ allVotes: 3, votes: { yes: 1, no: 1 }, units: { yes: 2, no: 1 }, persons: { yes: 2, total: 4 }, decision: 'rejected' });
  });
});

describe('tutanak, kesinlestirme ve PDF', () => {
  it('divan ve notlar denetime adsiz yazilir; kesinlestirme baskan + yazman ister; sonra yazim kapanir, duzeltme acik', async () => {
    const { call, version, audits, attend } = await heldQuorum();
    await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 2, no: 1, abstain: 0 });
    expect((await call('POST', '/asm1/finalize', { version: version() })).status).toBe(422);
    const m = await call('PUT', '/asm1/minutes', { version: version(), chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'], notes: { a2: 'Bütçe 2027 için %20 artırıldı.' }, generalNotes: 'Asansör bakımı konuşuldu.' });
    expect(m.status).toBe(200);
    expect(m.body.minutes).toMatchObject({ chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'], notes: { a2: 'Bütçe 2027 için %20 artırıldı.' } });
    expect(audits.at(-1)).toMatchObject({ action: 'assembly.minutes', details: { chair: true, clerks: 1, itemNotes: 1, generalNotes: true } });
    expect(JSON.stringify(audits)).not.toContain('Ayşe');
    expect((await call('PUT', '/asm1/minutes', { version: version(), notes: { zz: 'x' } })).status).toBe(400);

    const fin = await call('POST', '/asm1/finalize', { version: version() });
    expect(fin.status).toBe(200);
    expect(fin.body.assembly).toMatchObject({ status: 'held' });
    expect(fin.body.warnings[0]).toContain('3 gündem maddesi için karar kaydı yok');
    expect(audits.at(-1)).toMatchObject({ action: 'assembly.finalize', details: { quorumMet: true, decisions: 1, itemsWithoutDecision: 3 } });
    expect((await attend('u3', 'present')).status).toBe(409);
    expect((await call('PUT', '/asm1/minutes', { version: version(), chair: 'Başka' })).status).toBe(409);
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: version(), votes: { u1: 'yes' } })).status).toBe(409);
    const corr = await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 1, no: 2, abstain: 0, correctionReason: 'Sayım hatası düzeltildi' });
    expect(corr.status).toBe(200);
    expect(corr.body.assembly.status).toBe('held');
    expect((await call('POST', '/asm1/cancel', { version: version(), reason: 'Vazgeçildi' })).status).toBe(409);
  });

  it('yeter sayisizlikta kesinlestirme divan istemez; ikinci toplanti kesinlesmis ilk toplantiya baglanabilir', async () => {
    const { call, attend, version } = setup();
    await call('POST', '', meeting);
    await attend('u1', 'present');
    await call('POST', '/asm1/quorum', { version: version() });
    expect((await call('POST', '/asm1/finalize', { version: version() })).body.assembly.status).toBe('held');
    expect((await call('POST', '', { ...meeting, scheduledAt: '2026-12-22T19:00:00+03:00', firstMeetingId: 'asm1' })).status).toBe(201);
  });

  it('tutanak PDF: S3 raporlar altinda, ayni veriyle yeniden uretilmez; tutanak veya duzeltme yeni dosya; kesinlesince taslak degil', async () => {
    const { call, version, store } = await heldQuorum();
    const before = setup();
    await before.call('POST', '', meeting);
    before.clock.set('2026-11-27T09:00:00.000Z');
    expect((await before.call('GET', '/asm1/minutes')).status).toBe(409);

    await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 2, no: 1, abstain: 0 });
    const draft = await call('GET', '/asm1/minutes');
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ preview: true, fileName: 'toplanti-tutanagi-2026-12-15-taslak.pdf', contentType: 'application/pdf' });
    expect(draft.body.url).toMatch(/^memory:\/\/get\/apartments\/apt-1\/reports\/2026\/12\/assembly-minutes-asm1-[0-9a-f]{16}\.pdf\?ttl=300/);
    const key = decodeURIComponent(draft.body.url.slice('memory://get/'.length).split('?')[0]);
    expect((await store.head(key))?.contentType).toBe('application/pdf');
    expect((await call('GET', '/asm1/minutes')).body.url).toBe(draft.body.url);
    await call('PUT', '/asm1/minutes', { version: version(), chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'] });
    const withDivan = await call('GET', '/asm1/minutes');
    expect(withDivan.body.url).not.toBe(draft.body.url);
    await call('POST', '/asm1/finalize', { version: version() });
    const final = await call('GET', '/asm1/minutes');
    expect(final.body).toMatchObject({ preview: false, fileName: 'toplanti-tutanagi-2026-12-15.pdf' });
    await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 1, no: 2, abstain: 0, correctionReason: 'Sayım hatası' });
    expect((await call('GET', '/asm1/minutes')).body.url).not.toBe(final.body.url);
  });

  it('karar defteri: tum kararlar, onbellekli; yeni karar yeni dosya; depo yoksa 503', async () => {
    const { call, version } = await heldQuorum();
    const empty = await call('GET', '/decision-book');
    expect(empty.status).toBe(200);
    expect(empty.body.fileName).toMatch(/^karar-defteri-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(empty.body.url).toMatch(/assembly-decision-book-[0-9a-f]{16}\.pdf/);
    expect((await call('GET', '/decision-book')).body.url).toBe(empty.body.url);
    await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 2, no: 1, abstain: 0 });
    const one = await call('GET', '/decision-book');
    expect(one.body.url).not.toBe(empty.body.url);
    expect(one.body.url).toContain('/reports/2026/12/');
    const none = setup({ store: false });
    expect((await none.call('GET', '/decision-book')).status).toBe(503);
  });

  it('roller: denetci tutanak / karar defterini okur, yazamaz; baska apartman goremez; sakin yonetim ucuna giremez', async () => {
    const { call, token, version } = await heldQuorum();
    const observer = token('o', 'observer');
    expect((await call('GET', '/asm1/minutes', undefined, observer)).status).toBe(200);
    expect((await call('GET', '/decision-book', undefined, observer)).status).toBe(200);
    for (const [m, p, b] of [
      ['POST', '/asm1/agenda/a2/tally', { version: version(), yes: 1, no: 0, abstain: 0 }],
      ['PUT', '/asm1/minutes', { version: version(), chair: 'X Y' }],
      ['POST', '/asm1/finalize', { version: version() }],
      ['POST', '/asm1/call', { version: version() }],
    ] as const) {
      expect((await call(m, p, b, observer)).status).toBe(403);
    }
    const other = token('x', 'apartment_manager', 'apt-2');
    expect((await call('GET', '/asm1/minutes', undefined, other)).status).toBe(404);
    expect((await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 1, no: 0, abstain: 0 }, other)).status).toBe(404);
    expect((await call('GET', '/decision-book', undefined, token('r', 'resident'))).status).toBe(403);
  });

  it('PDF metni satir kaydirma: uzun kelime bolunur, satir sonlari korunur', () => {
    const font = { widthOfTextAtSize: (s: string) => s.length };
    expect(wrapText('bir iki üç dört', font, 1, 7)).toEqual(['bir iki', 'üç dört']);
    expect(wrapText('abcdefghij', font, 1, 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', font, 1, 4)).toEqual(['a', '', 'b']);
  });
});
