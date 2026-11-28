/**
 * Genel kurul sonrasi: toplanti disinda yazili riza (KMK m.19/2; diger turler README "Hukuki yorum").
 * Sayim majority.ts ile ayni kurallar (kisi / m.31 oyu / arsa payi; payda butun kat malikleri),
 * degismez kayit ve gerekceli duzeltme, kapanista kesinlesen sonuc, belge, PDF, roller ve tenant.
 */
import { describe, expect, it } from 'vitest';
import { consentOutcome, latestEntries } from '../src/modules/assemblies/consents.js';
import { APT, T0, ls, owner, setup, unit } from './fakes/assemblyWorld.js';

const sign = { signedOn: '2026-11-26', method: 'wet_signature' };

async function open(decisionKind = 'common_area_change', extra: Record<string, unknown> = {}, opts: Parameters<typeof setup>[0] = {}) {
  const w = setup({ now: T0, ...opts });
  const res = await w.call('POST', '/consents', { title: 'Dış cephe farklı renk boya', decisionKind, ...extra });
  return { w, res, id: res.body.consent?.consentId as string };
}

describe('talep', () => {
  it('yalnizca yazili rizaya acik turler; toplanti karari gerektiren tur 422; ozelde katilanlar cogunlugu secilemez; oy listesi bugun dondurulur', async () => {
    const { w, res, id } = await open();
    expect(res.status).toBe(201);
    expect(res.body.consent).toMatchObject({ consentId: 'cns-asm1', decisionKind: 'common_area_change', rule: 'four_fifths_persons', rollDate: '2026-11-27', status: 'open', roll: { units: 4 } });
    expect(res.body.legal).toMatchObject({ legal: 'KMK m.19/2' });
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.consent_open', target: { type: 'assembly_consent', id }, details: { rule: 'four_fifths_persons', units: 4 } });
    for (const kind of ['general', 'operating_budget', 'manager_election', 'auditor_election', 'beneficial_improvement']) {
      expect((await w.call('POST', '/consents', { title: 'Toplantı kararı', decisionKind: kind })).status).toBe(422);
    }
    expect((await w.call('POST', '/consents', { title: 'Özel', decisionKind: 'custom' })).status).toBe(400);
    expect((await w.call('POST', '/consents', { title: 'Özel', decisionKind: 'custom', majority: 'attendees' })).status).toBe(400);
    expect((await w.call('POST', '/consents', { title: 'Özel', decisionKind: 'custom', majority: 'two_thirds_votes' })).body.consent.rule).toBe('two_thirds_votes');
    expect((await w.call('POST', '/consents', { title: 'Boya', decisionKind: 'common_area_change', majority: 'unanimous' })).status).toBe(400);
    expect((await w.call('GET', '/consents')).body.items).toHaveLength(2);
  });

  it('arsa payi gereken kuralda arsa payi eksikse talep acilmaz (karar hesaplanamaz)', async () => {
    const units = [unit('u1', '1', ls(500)), unit('u2', '2')];
    const { res } = await open('custom', { majority: 'four_fifths_persons_and_land' }, { units, members: [owner('own-1', 'u1'), owner('own-2', 'u2')] });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('arsa payı');
  });
});

describe('riza kaydi ve sayim', () => {
  it('m.19/2: butun kat maliklerinin (kisi) besde dordu; kaydi olmayan bolum riza vermemis sayilir; hisseli bolumde temsilci zorunlu', async () => {
    const { w, id } = await open();
    const put = (unitId: string, body: Record<string, unknown>) => w.call('PUT', `/consents/${id}/units/${unitId}`, { ...sign, ...body });
    expect((await put('u2', { choice: 'consent' })).status).toBe(400);
    expect((await put('u2', { choice: 'consent', signerUserId: 'own-1' })).status).toBe(400);
    expect((await put('u1', { choice: 'consent', signedOn: '2026-11-28' })).status).toBe(400);
    expect((await put('u1', { choice: 'consent', method: 'other' })).status).toBe(400);
    await put('u1', { choice: 'consent' });
    await put('u2', { choice: 'consent', signerUserId: 'own-2a' });
    const three = await put('u3', { choice: 'consent', method: 'notarized' });
    // 4 kisi: en az ceil(4 x 4/5) = 4 kisi gerekir; 3 riza yetmez.
    expect(three.body.outcome).toMatchObject({ rule: 'four_fifths_persons', decision: 'rejected', persons: { yes: 3, total: 4, absent: 1 }, required: { persons: 4 } });
    expect(three.body.outcome.reasons[0]).toContain('beşte dördüne (en az 4)');
    const four = await put('u4', { choice: 'consent' });
    expect(four.body.outcome).toMatchObject({ decision: 'accepted', persons: { yes: 4 }, units: { yes: 4 } });
    expect(four.body.entry).toMatchObject({ unitId: 'u4', seq: 1, choice: 'consent', signerUserId: 'own-4', method: 'wet_signature' });
    const d = (await w.call('GET', `/consents/${id}`)).body;
    expect(d.outcome.decision).toBe('accepted');
    expect(d.rows.find((r: any) => r.unitId === 'u2')).toMatchObject({ owners: [{ userId: 'own-2a' }, { userId: 'own-2b' }], entry: { signerUserId: 'own-2a', signerName: 'Kişi own-2a' }, records: 1 });
  });

  it('degismez: ikinci kayit yalnizca gerekceli duzeltme (yeni sira, oncekini gosterir); denetimli; itiraz sayimdan duser', async () => {
    const { w, id } = await open();
    const put = (unitId: string, body: Record<string, unknown>) => w.call('PUT', `/consents/${id}/units/${unitId}`, { ...sign, ...body });
    await put('u1', { choice: 'consent' });
    expect((await put('u1', { choice: 'object' })).status).toBe(409);
    expect((await put('u3', { choice: 'object', correctionReason: 'Yok' })).status).toBe(400);
    const fix = await put('u1', { choice: 'object', correctionReason: 'İmza başka bölüme aitti' });
    expect(fix.status).toBe(200);
    expect(fix.body.entry).toMatchObject({ seq: 2, supersedes: 1, correctionReason: 'İmza başka bölüme aitti', choice: 'object' });
    expect(fix.body.outcome).toMatchObject({ persons: { yes: 0, no: 1 } });
    expect([...w.consentEntries.keys()].filter((k) => k.includes('#u1#'))).toEqual([`APT#${APT}|ASMCONSV#${id}#u1#001`, `APT#${APT}|ASMCONSV#${id}#u1#002`]);
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.consent_correction', reason: 'İmza başka bölüme aitti', details: { unitId: 'u1', seq: 2, supersedes: 1, choice: 'object' } });
    expect((await w.call('GET', `/consents/${id}`)).body.rows[0]).toMatchObject({ unitId: 'u1', entry: { seq: 2 }, records: 2 });
  });

  it('ayni malikin bolumleri ayni yonde (kisi sayimi); m.28 yonetim plani oy olarak (m.31 siniri payda dahil); oybirligi kaydi olmayan bolumu sayar', async () => {
    const units = [unit('u1', '1', ls(100)), unit('u2', '2', ls(100)), unit('u3', '3', ls(100)), unit('u4', '4', ls(100)), unit('u5', '5', ls(600))];
    const members = [owner('own-1', 'u1'), owner('own-1', 'u2'), owner('own-3', 'u3'), owner('own-4', 'u4'), owner('own-5', 'u5')];
    const plan = await open('management_plan_change', {}, { units, members });
    expect(plan.res.body.consent.rule).toBe('four_fifths_votes');
    const put = (unitId: string, choice: string) => plan.w.call('PUT', `/consents/${plan.id}/units/${unitId}`, { ...sign, choice });
    await put('u1', 'consent');
    const split = await put('u2', 'object');
    expect(split.status).toBe(422);
    expect(split.body.message).toContain('aynı yönde');
    await put('u2', 'consent');
    await put('u3', 'consent');
    const r = await put('u4', 'consent');
    // 5 bolum, kisi siniri floor(5/3)=1: own-1 iki bolumle 1 oy. Butun oylar (sinirli) 4; gerekli ceil(4 x 4/5) = 4; kabul 3.
    expect(r.body.outcome).toMatchObject({ rule: 'four_fifths_votes', allVotes: 4, voteCap: 1, votes: { yes: 3 }, required: { votes: 4 }, decision: 'rejected' });
    expect((await put('u5', 'consent')).body.outcome.decision).toBe('accepted');

    const una = await open('use_change');
    const u = (unitId: string, body: Record<string, unknown>) => una.w.call('PUT', `/consents/${una.id}/units/${unitId}`, { ...sign, ...body });
    await u('u1', { choice: 'consent' });
    await u('u2', { choice: 'consent', signerUserId: 'own-2b' });
    const o3 = await u('u3', { choice: 'consent' });
    expect(o3.body.outcome).toMatchObject({ rule: 'unanimous', decision: 'rejected' });
    expect(o3.body.outcome.reasons[0]).toContain('bölümün rızası kayıtlı değil');
    expect((await u('u4', { choice: 'consent' })).body.outcome.decision).toBe('accepted');
  });

  it('saf sayim: en son sirali kayit gecerli', () => {
    const base = { PK: 'p', SK: 's', entityType: 'ASSEMBLY_CONSENT_ENTRY' as const, apartmentId: APT, consentId: 'c', signerUserId: 'own-1', signedOn: '2026-11-26', method: 'wet_signature' as const, recordedAt: T0, recordedBy: 'm' };
    const latest = latestEntries([
      { ...base, unitId: 'u1', seq: 1, choice: 'consent' },
      { ...base, unitId: 'u1', seq: 2, choice: 'object' },
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ seq: 2, choice: 'object' });
    const entries = [{ unitId: 'u1', blockId: 'b', number: '1', owners: [{ userId: 'own-1' }], weight: '1', warnings: [] }] as never;
    expect(consentOutcome('unanimous', entries, { denominator: '1', missingLandShare: 0, totalWeight: '1' } as never, latest).decision).toBe('rejected');
  });
});

describe('kapatma, belge, PDF, roller', () => {
  it('kapatma sonucu kesinlestirir (sonra kayit 409); surumlu; PDF ara sonuc / kesin; belge imzali linkle', async () => {
    const { w, id } = await open();
    const withDoc = await w.call('PUT', `/consents/${id}/units/u1`, { ...sign, choice: 'consent', document: { uploadId: 'up-77', fileName: 'riza-u1.pdf' } });
    expect(withDoc.body.entry.document).toEqual({ fileName: 'riza-u1.pdf', contentType: 'application/pdf', size: 1234 });
    expect(JSON.stringify(withDoc.body)).not.toContain('apartments/');
    const doc = await w.call('GET', `/consents/${id}/units/u1/document`);
    expect(doc.body.url).toContain(`apartments/${APT}/assemblies/consents/${id}/u1/up-77.pdf`);
    expect((await w.call('GET', `/consents/${id}/units/u3/document`)).status).toBe(404);
    const interim = await w.call('GET', `/consents/${id}/pdf`);
    expect(interim.body).toMatchObject({ interim: true, contentType: 'application/pdf' });
    expect(interim.body.url).toMatch(/assembly-consent-cns-asm1-[0-9a-f]{16}\.pdf/);
    expect((await w.call('POST', `/consents/${id}/close`, { version: 2 })).status).toBe(409);
    const closed = await w.call('POST', `/consents/${id}/close`, { version: 1 });
    expect(closed.body).toMatchObject({ consent: { status: 'closed', result: { decision: 'rejected' } }, outcome: { decision: 'rejected', persons: { yes: 1 } } });
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.consent_close', details: { decision: 'rejected', records: 1, entriesHash: expect.any(String) } });
    expect((await w.call('PUT', `/consents/${id}/units/u2`, { ...sign, choice: 'consent', signerUserId: 'own-2a' })).status).toBe(409);
    const final = await w.call('GET', `/consents/${id}/pdf`);
    expect(final.body.interim).toBe(false);
    expect(final.body.url).not.toBe(interim.body.url);
    expect((await w.call('POST', `/consents/${id}/cancel`, { version: 2, reason: 'Geç kaldı' })).status).toBe(409);
  });

  it('iptal gerekceli; roller: denetci okur yazamaz; sakin 403; baska apartman 404', async () => {
    const { w, id } = await open();
    const obs = w.token('obs', 'observer');
    expect((await w.call('GET', `/consents/${id}`, undefined, obs)).status).toBe(200);
    expect((await w.call('PUT', `/consents/${id}/units/u1`, { ...sign, choice: 'consent' }, obs)).status).toBe(403);
    expect((await w.call('POST', '/consents', { title: 'X boya', decisionKind: 'common_area_change' }, obs)).status).toBe(403);
    expect((await w.call('GET', '/consents', undefined, w.token('own-1', 'resident'))).status).toBe(403);
    expect((await w.call('GET', `/consents/${id}`, undefined, w.token('mgr-2', 'apartment_manager', 'apt-2'))).status).toBe(404);
    expect((await w.call('PUT', `/consents/${id}/units/u1`, { ...sign, choice: 'consent' }, w.token('mgr-2', 'apartment_manager', 'apt-2'))).status).toBe(404);
    const c = await w.call('POST', `/consents/${id}/cancel`, { version: 1, reason: 'Proje değişti' });
    expect(c.body.consent).toMatchObject({ status: 'cancelled', cancelReason: 'Proje değişti' });
    expect((await w.call('PUT', `/consents/${id}/units/u1`, { ...sign, choice: 'consent' })).status).toBe(409);
  });
});
