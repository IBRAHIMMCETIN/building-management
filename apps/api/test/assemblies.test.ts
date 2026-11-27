import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import { assemblyQuorum, countVotes, decide, proxyKey, proxyLimit, voteCap, voterOf } from '../src/modules/assemblies/quorum.js';
import type { AssemblyRepository } from '../src/modules/assemblies/repository.js';
import { createAssemblyService } from '../src/modules/assemblies/service.js';
import type { Assembly, AssemblyAttendance } from '../src/modules/assemblies/types.js';
import type { AuditDraft } from '../src/modules/audit/log.js';
import type { Block, LandShare, Unit } from '../src/modules/core/types.js';
import { renderReportPdf } from '../src/modules/documents/reportPdf.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import { createMemoryRollStore } from '../src/modules/polls/rollSnapshot.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import type { Person } from '../src/modules/residents/repository.js';

const APT = 'apt-1';
const T0 = '2026-11-27T09:00:00.000Z';
/** Toplanti (15.12.2026 19:00 Istanbul) basladiktan sonra. */
const DURING = '2026-12-15T16:30:00.000Z';
const seed = { createdAt: T0, createdBy: 'seed', updatedAt: T0, updatedBy: 'seed', version: 1 };

const unit = (id: string, number: string, landShare?: LandShare, blockId = 'b1'): Unit => ({
  PK: `APT#${APT}`,
  SK: `UNIT#${id}`,
  entityType: 'UNIT',
  status: 'active',
  ...seed,
  unitId: id,
  siteId: APT,
  blockId,
  number,
  type: 'flat',
  grossAreaTenthsM2: 1000,
  ...(landShare ? { landShare } : {}),
  exemptions: [],
});

const owner = (userId: string, unitId: string, extra: Partial<UnitMembership> = {}): UnitMembership => ({
  PK: `APT#${APT}`,
  SK: `MEMBER#${userId}#${unitId}`,
  entityType: 'UNIT_MEMBERSHIP',
  ...seed,
  userId,
  apartmentId: APT,
  unitId,
  relation: 'owner',
  residesInUnit: true,
  status: 'active',
  startDate: '2026-01-01',
  ...extra,
});

/** u1-u3 %10'ar, u4 %70 arsa payi: sayica cogunluk ile arsa payi cogunlugu ayrisir. */
const ls = (n: number): LandShare => ({ numerator: n, denominator: 1000 });
const defaultUnits = () => [unit('u1', '1', ls(100)), unit('u2', '2', ls(100)), unit('u3', '3', ls(100)), unit('u4', '4', ls(700), 'b2')];
const defaultMembers = () => [
  owner('own-1', 'u1'),
  owner('own-2a', 'u2', { ownershipShare: { numerator: 1, denominator: 2 } }),
  owner('own-2b', 'u2', { ownershipShare: { numerator: 1, denominator: 2 } }),
  owner('own-3', 'u3'),
  owner('own-4', 'u4'),
];

function setup(opts: { store?: boolean; units?: Unit[]; members?: UnitMembership[] } = {}) {
  let now = new Date(DURING);
  const clock = { set: (iso: string) => void (now = new Date(iso)) };
  const docs = new Map<string, Assembly>();
  const atts = new Map<string, AssemblyAttendance>();
  const audits: AuditDraft[] = [];
  const rolls = createMemoryRollStore();
  const clone = <T>(x: T): T => structuredClone(x);
  const repo: AssemblyRepository = {
    get: async (apt, id) => clone(docs.get(`${apt}|${id}`)),
    list: async (apt) => [...docs.values()].filter((a) => a.apartmentId === apt).map(clone),
    create: async (a, audit) => {
      docs.set(`${a.apartmentId}|${a.assemblyId}`, clone(a));
      audits.push(clone(audit));
    },
    update: async (a, expected, audit, roll = []) => {
      if (docs.get(`${a.apartmentId}|${a.assemblyId}`)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      if (roll.length) rolls.put(roll);
      docs.set(`${a.apartmentId}|${a.assemblyId}`, clone(a));
      if (audit) audits.push(clone(audit));
    },
    listAttendance: async (apt, id) => [...atts.values()].filter((x) => x.apartmentId === apt && x.assemblyId === id).map(clone),
    getAttendance: async (apt, id, unitId) => clone(atts.get(`${apt}|${id}|${unitId}`)),
    putAttendance: async (att, expected, audit) => {
      if (docs.get(`${att.apartmentId}|${att.assemblyId}`)?.status !== 'planned') throw new DataAccessError('conflict', 'iptal');
      const k = `${att.apartmentId}|${att.assemblyId}|${att.unitId}`;
      if (expected === 0 ? atts.has(k) : atts.get(k)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      atts.set(k, clone(att));
      audits.push(clone(audit));
    },
  };
  const units = opts.units ?? defaultUnits();
  const members = opts.members ?? defaultMembers();
  const people = [...new Set([...members.map((m) => m.userId), 'prx-1', 'prx-2'])].map((userId) => ({ apartmentId: APT, userId, fullName: `Kişi ${userId}` }) as Person);
  const blocks = [
    { blockId: 'b1', name: 'A Blok', siteId: APT },
    { blockId: 'b2', name: 'B Blok', siteId: APT },
  ] as Block[];
  const { store } = createMemoryDocumentStore();
  let n = 0;
  const service = createAssemblyService({
    repository: repo,
    core: { listUnits: async () => units, listBlocks: async () => blocks, getSite: async () => ({ name: 'Lale Apartmanı' }) as never },
    ownership: { listHeads: async () => [], listRecords: async () => [] },
    memberships: { list: async (apt) => members.filter((m) => m.apartmentId === apt) },
    people: { list: async () => people },
    rolls,
    store: opts.store === false ? undefined : store,
    now: () => now,
    newId: () => `asm${++n}`,
  });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), assemblyService: service });
  const token = (sub: string, role: string, apartmentId = APT) => `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');
  const call = async (method: string, path: string, body?: unknown, auth = manager) => {
    const res = await app.request(`/api/assemblies${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const attend = (unitId: string, mode: string, extra: Record<string, unknown> = {}, id = 'asm1') => call('PUT', `/${id}/attendance/${unitId}`, { mode, ...extra });
  const version = (id = 'asm1') => docs.get(`${APT}|${id}`)!.version;
  return { call, token, attend, audits, store, docs, units, members, version, clock, rolls };
}

const meeting = {
  kind: 'ordinary',
  scheduledAt: '2026-12-15T19:00:00+03:00',
  location: 'Site toplantı salonu',
  agenda: ['Yönetim kurulu seçimi', { title: 'İşletme projesi', description: '2027 bütçesi' }],
};

describe('assemblies - yetki, kayit ve denetim', () => {
  it('roller: denetci okur, yazamaz; sakin ve gorevli giremez; tenant izolasyonu', async () => {
    const { call, token } = setup();
    expect((await call('POST', '', meeting, token('o', 'observer'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('r', 'resident'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('s', 'building_staff'))).status).toBe(403);
    expect((await call('POST', '', meeting, token('m', 'management_company'))).status).toBe(201);
    expect((await call('GET', '', undefined, token('o', 'observer'))).body.items).toHaveLength(1);
    expect((await call('GET', '/asm1', undefined, token('x', 'apartment_manager', 'apt-2'))).status).toBe(404);
  });

  it('olusturma, duzenleme ve iptal denetim zincirine yazilir; gundem a1..aN, oy listesi tarihi Istanbul gunu', async () => {
    const { call, audits } = setup();
    const res = await call('POST', '', { ...meeting, scheduledAt: '2026-12-16T00:30:00+03:00', onlineUrl: 'https://meet.example/abc' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'planned', secondMeeting: false, scheduledAt: '2026-12-15T21:30:00.000Z', rollDate: '2026-12-16', agenda: [{ itemId: 'a1' }, { itemId: 'a2', description: '2027 bütçesi' }] });
    expect((await call('PATCH', '/asm1', { version: 1, location: 'Bahçe' })).body).toMatchObject({ location: 'Bahçe', version: 2 });
    expect((await call('POST', '/asm1/cancel', { version: 2, reason: 'Ertelendi' })).body).toMatchObject({ status: 'cancelled' });
    expect(audits.map((a) => a.action)).toEqual(['assembly.create', 'assembly.update', 'assembly.cancel']);
    expect(audits[0]).toMatchObject({ apartmentId: APT, target: { type: 'assembly', id: 'asm1' }, details: { kind: 'ordinary', agendaItems: 2, secondMeeting: false } });
    expect(audits[2]).toMatchObject({ reason: 'Ertelendi' });
  });

  it.each([
    ['yer ve baglanti yok', { ...meeting, location: undefined }],
    ['http baglanti', { ...meeting, location: undefined, onlineUrl: 'http://meet.example' }],
    ['bos gundem', { ...meeting, agenda: [] }],
    ['31 madde', { ...meeting, agenda: Array.from({ length: 31 }, (_, i) => `M${i}`) }],
    ['gecersiz tur', { ...meeting, kind: 'annual' }],
    ['saat dilimsiz tarih', { ...meeting, scheduledAt: '2026-12-15T19:00:00' }],
    ['ilk toplanti olmadan ikinci toplanti isareti', { ...meeting, secondMeeting: true }],
  ])('400: %s', async (_l, body) => {
    const { call } = setup();
    expect((await call('POST', '', body)).status).toBe(400);
  });
});

describe('assemblies - dondurulmus oy listesi', () => {
  it('ilk katilimda oy listesi dondurulur (denetimli); sonraki sicil / arsa payi degisikligi yeter sayi ve hazirunu etkilemez', async () => {
    const { call, attend, audits, units, rolls } = setup();
    await call('POST', '', meeting);
    const before = (await call('GET', '/asm1')).body;
    expect(before.rollFrozen).toBe(false);
    expect(await rolls.entries(APT, 'assembly', 'asm1')).toEqual([]);

    await attend('u4', 'present');
    expect(audits.map((a) => a.action)).toEqual(['assembly.create', 'assembly.roll_freeze', 'assembly.attendance']);
    expect((await rolls.entries(APT, 'assembly', 'asm1')).map((e) => e.unitId)).toEqual(['u1', 'u2', 'u3', 'u4']);

    units[3] = { ...units[3]!, landShare: ls(1) };
    units.push(unit('u9', '9', ls(999)));
    const d = (await call('GET', '/asm1')).body;
    expect(d.rollFrozen).toBe(true);
    expect(d.units.map((u: any) => u.unitId)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(d.quorum).toMatchObject({ totalUnits: 4, presentLandShare: { numerator: '700', denominator: '1000' } });
    expect((await attend('u9', 'present')).status).toBe(404);
    // Dondurulduktan sonra toplanti bilgisi / gundem degismez (oy listesi tarihi kayardi).
    expect((await call('PATCH', '/asm1', { version: d.assembly.version, scheduledAt: '2026-12-20T19:00:00+03:00' })).status).toBe(409);
  });
});

describe('assemblies - KMK m.30 yeter sayi', () => {
  it('yeter sayi sayi VE arsa payi cogunlugu ister; katilan malik adlari ve paylar', async () => {
    const { call, attend } = setup();
    await call('POST', '', meeting);
    for (const u of ['u1', 'u2', 'u3']) expect((await attend(u, 'present')).status).toBe(200);
    let d = (await call('GET', '/asm1')).body;
    expect(d.units[1].owners).toEqual([
      { userId: 'own-2a', name: 'Kişi own-2a', share: { numerator: 1, denominator: 2 } },
      { userId: 'own-2b', name: 'Kişi own-2b', share: { numerator: 1, denominator: 2 } },
    ]);
    expect(d.quorum).toMatchObject({ totalOwners: 4, presentOwners: 3, presentVotes: 3, totalVotes: 4, ownersMajority: true, landShareMajority: false, met: false, landShareBps: 3000 });
    expect(d.quorum.reasons).toEqual(['Katılanların arsa payı toplamın yarısından fazla değil']);

    await attend('u2', 'absent');
    await attend('u3', 'absent');
    await attend('u4', 'proxy', { proxyUserId: 'prx-1' });
    d = (await call('GET', '/asm1')).body;
    expect(d.quorum).toMatchObject({ presentOwners: 2, presentVotes: 2, proxyUnits: 1, ownersMajority: false, landShareMajority: true, met: false });

    await attend('u2', 'present', { attendeeUserId: 'own-2b' });
    d = (await call('GET', '/asm1')).body;
    expect(d.quorum).toMatchObject({ presentVotes: 3, met: true, decisionThreshold: 2, presentLandShare: { numerator: '900', denominator: '1000' }, reasons: [] });
    expect(d.units[1].attendance).toMatchObject({ mode: 'present', attendee: { userId: 'own-2b', name: 'Kişi own-2b' } });
    expect(d.units[3].attendance).toMatchObject({ mode: 'proxy', proxy: { userId: 'prx-1', name: 'Kişi prx-1' } });
  });

  it('oy listesinde arsa payi eksik bolum varsa arsa payi olcutu hesaplanamaz: herkes katilsa da yeter sayi yok', async () => {
    const units = [...defaultUnits(), unit('u5', '5')];
    const { call, attend } = setup({ units, members: [...defaultMembers(), owner('own-5', 'u5')] });
    await call('POST', '', meeting);
    for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) await attend(u, 'present');
    const q = (await call('GET', '/asm1')).body.quorum;
    expect(q).toMatchObject({ ownersMajority: true, landShareComputable: false, landShareMajority: false, met: false, totalLandShare: null });
    expect(q.reasons[0]).toContain('1 bölümün arsa payı girilmemiş; arsa payı çoğunluğu hesaplanamıyor');
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: 2, yes: 5, no: 0, abstain: 0 })).status).toBe(422);
  });

  it('KMK m.31: birden fazla bolumu olan malikin oyu toplam oylarin ucte biriyle sinirli (yeter sayi ve karar)', async () => {
    const units = ['1', '2', '3', '4', '5', '6'].map((x) => unit(`u${x}`, x, ls(100)));
    const members = [owner('big', 'u1'), owner('big', 'u2'), owner('big', 'u3'), owner('big', 'u4'), owner('o5', 'u5'), owner('o6', 'u6')];
    const { call, attend } = setup({ units, members });
    await call('POST', '', meeting);
    for (const u of ['u1', 'u2', 'u3', 'u4']) await attend(u, 'present');
    const q = (await call('GET', '/asm1')).body.quorum;
    // Butun oylar 6 (sinirsiz, payda kuculmez); kisi siniri floor(6/3) = 2. Kat maliki 3 kisi (big, o5, o6).
    expect(q).toMatchObject({ totalUnits: 6, presentUnits: 4, totalVotes: 6, presentVotes: 2, voteCap: 2, cappedOwners: 1, totalOwners: 3, presentOwners: 1, ownersMajority: false, met: false });
    expect(q.warnings[0]).toContain('üçte biriyle (en fazla 2 oy)');
    await attend('u5', 'present');
    const met = (await call('GET', '/asm1')).body;
    expect(met.quorum).toMatchObject({ presentOwners: 2, presentVotes: 3, met: true, decisionThreshold: 2 });
    // Sayim sinirli oyla: katilan 3 oy, 4 kabul girilemez.
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: met.assembly.version, yes: 4, no: 0, abstain: 0 })).status).toBe(400);
  });
});

describe('assemblies - KMK m.31 vekalet', () => {
  it('40 ve alti bolumde bir kisi en fazla iki kat malikine vekil olur; kisi uye kimligiyle ya da adla tanimlanir', async () => {
    const units = ['1', '2', '3', '4', '5'].map((x) => unit(`u${x}`, x, ls(200)));
    const members = [owner('o1', 'u1'), owner('o2', 'u2'), owner('o3', 'u3'), owner('o4', 'u4'), owner('o4', 'u5')];
    const { call, attend, audits } = setup({ units, members });
    await call('POST', '', meeting);
    expect((await attend('u1', 'proxy', { proxyUserId: 'prx-1' })).status).toBe(200);
    expect((await attend('u2', 'proxy', { proxyUserId: 'prx-1' })).status).toBe(200);
    const third = await attend('u3', 'proxy', { proxyUserId: 'prx-1' });
    expect(third.status).toBe(422);
    expect(third.body.message).toContain('en fazla 2 kat malikine');
    // Ayni malikin iki bolumu tek malik sayilir; ad ile tanimli vekil bosluk / harf farki gozetmez.
    expect((await attend('u4', 'proxy', { proxyName: 'Ali  Demir' })).status).toBe(200);
    expect((await attend('u5', 'proxy', { proxyName: 'ali demir' })).status).toBe(200);
    expect((await attend('u3', 'proxy', { proxyName: 'ALİ DEMİR' })).status).toBe(200);
    expect(JSON.stringify(audits)).not.toContain('Demir');
    expect(audits.filter((a) => a.action === 'assembly.attendance').at(-1)).toMatchObject({ details: { unitId: 'u3', mode: 'proxy', proxyIsMember: false } });
  });

  it('40 bolumun ustunde vekil oylarin %5\'inden fazlasini temsil edemez', async () => {
    const units = Array.from({ length: 41 }, (_, i) => unit(`u${i + 1}`, String(i + 1), ls(10)));
    const members = units.map((u, i) => owner(`o${i + 1}`, u.unitId));
    const { call, attend } = setup({ units, members });
    await call('POST', '', meeting);
    expect((await attend('u1', 'proxy', { proxyUserId: 'prx-2' })).status).toBe(200);
    expect((await attend('u2', 'proxy', { proxyUserId: 'prx-2' })).status).toBe(200);
    const third = await attend('u3', 'proxy', { proxyUserId: 'prx-2' });
    expect(third.status).toBe(422);
    expect(third.body.message).toContain("%5'inden fazlasını (en fazla 2 oy)");
  });

  it('vekil / katilan dogrulamasi: bilinmeyen kisi, bolumun kendi maliki vekil, malik olmayan katilan reddedilir', async () => {
    const { call, attend } = setup();
    await call('POST', '', meeting);
    expect((await attend('u1', 'proxy')).status).toBe(400);
    expect((await attend('u1', 'proxy', { proxyUserId: 'yok' })).status).toBe(400);
    expect((await attend('u1', 'proxy', { proxyUserId: 'own-1' })).status).toBe(400);
    expect((await attend('u2', 'present', { attendeeUserId: 'own-1' })).status).toBe(400);
    expect((await attend('u1', 'maybe')).status).toBe(400);
  });
});

describe('assemblies - sayim, tutanak ve ikinci toplanti', () => {
  it('sayim yalnizca yeter sayi varken; karar katilanlarin oy cogunlugu; ilk sayim yeter sayiyi tutanaga gecirir', async () => {
    const { call, attend, audits, docs, version } = setup();
    await call('POST', '', meeting);
    await attend('u1', 'present');
    const blocked = await call('POST', '/asm1/agenda/a1/tally', { version: version(), yes: 1, no: 0, abstain: 0 });
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toContain('İkinci toplantıda');
    await attend('u2', 'present');
    await attend('u4', 'present');
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: version(), yes: 3, no: 1, abstain: 0 })).status).toBe(400);
    const accepted = await call('POST', '/asm1/agenda/a1/tally', { version: version(), yes: 2, no: 1, abstain: 0 });
    expect(accepted.body.assembly.agenda[0].tally).toMatchObject({ yes: 2, presentVotes: 3, decision: 'accepted' });
    expect(docs.get(`${APT}|asm1`)!.quorumRecord).toMatchObject({ met: true, presentVotes: 3, totalVotes: 4 });
    const rejected = await call('POST', '/asm1/agenda/a2/tally', { version: version(), yes: 1, no: 1, abstain: 1 });
    expect(rejected.body.assembly.agenda[1].tally.decision).toBe('rejected');
    expect(audits.filter((a) => a.action === 'assembly.tally')).toHaveLength(2);
    expect((await call('POST', '/asm1/quorum', { version: version() })).status).toBe(409);
  });

  it('ikinci toplanti: yeter sayisizligi tutanakta ilk toplantiya baglanir, en gec 15 gun sonra; yeter sayi aranmaz', async () => {
    const { call, attend, audits, version, clock } = setup();
    await call('POST', '', meeting); // asm1, 15.12.2026
    // Tutanak yokken ikinci toplanti baglanamaz.
    const early = await call('POST', '', { ...meeting, scheduledAt: '2026-12-22T19:00:00+03:00', firstMeetingId: 'asm1' });
    expect(early.status).toBe(422);
    await attend('u1', 'present');
    const rec = await call('POST', '/asm1/quorum', { version: version() });
    expect(rec.body.assembly.quorumRecord).toMatchObject({ met: false, presentOwners: 1, totalOwners: 4, presentVotes: 1, totalVotes: 4, noAttendance: false });
    expect(audits.at(-1)).toMatchObject({ action: 'assembly.quorum', details: { met: false } });
    // Basarisiz ilk toplantida sayim yapilamaz.
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: version(), yes: 1, no: 0, abstain: 0 })).status).toBe(409);

    expect((await call('POST', '', { ...meeting, scheduledAt: '2026-12-31T19:00:00+03:00', firstMeetingId: 'asm1' })).status).toBe(400);
    expect((await call('POST', '', { ...meeting, scheduledAt: '2026-12-14T19:00:00+03:00', firstMeetingId: 'asm1' })).status).toBe(400);
    expect((await call('POST', '', { ...meeting, firstMeetingId: 'nope' })).status).toBe(404);
    const second = await call('POST', '', { ...meeting, scheduledAt: '2026-12-30T19:00:00+03:00', firstMeetingId: 'asm1' });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ assemblyId: 'asm2', secondMeeting: true, firstMeetingId: 'asm1' });
    // Ikinci toplantiya yeniden ikinci toplanti baglanamaz.
    expect((await call('POST', '', { ...meeting, scheduledAt: '2026-12-31T19:00:00+03:00', firstMeetingId: 'asm2' })).status).toBe(422);

    clock.set('2026-12-30T16:30:00.000Z');
    await attend('u1', 'present', {}, 'asm2');
    const tally = await call('POST', '/asm2/agenda/a1/tally', { version: version('asm2'), yes: 1, no: 0, abstain: 0 });
    expect(tally.status).toBe(200);
    expect(tally.body.quorum).toMatchObject({ met: true, ownersMajority: false, secondMeeting: true });
    expect(tally.body.assembly.agenda[0].tally.decision).toBe('accepted');
  });

  it('iptal edilen toplantida katilim / sayim 409', async () => {
    const { call, attend } = setup();
    await call('POST', '', meeting);
    await call('POST', '/asm1/cancel', { version: 1, reason: 'Ertelendi' });
    expect((await attend('u1', 'present')).status).toBe(409);
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: 2, yes: 1, no: 0, abstain: 0 })).status).toBe(409);
  });
});

describe('assemblies - hazirun cetveli PDF', () => {
  it('dondurulmus oy listesinden uretilir (istek dondurmaz), S3 anahtari apartman altinda, veri degismedikce yeniden uretilmez', async () => {
    const { call, attend, store, docs, units } = setup();
    await call('POST', '', meeting);
    const before = await call('GET', '/asm1/attendance-sheet');
    expect(before.body).toMatchObject({ preview: true });
    expect(docs.get(`${APT}|asm1`)!.roll).toBeUndefined();
    await attend('u1', 'present');
    const res = await call('GET', '/asm1/attendance-sheet');
    expect(res.status).toBe(200);
    expect(docs.get(`${APT}|asm1`)!.roll).toMatchObject({ units: 4 });
    expect(res.body).toMatchObject({ preview: false, contentType: 'application/pdf', fileName: 'hazirun-cetveli-2026-12-15.pdf' });
    expect(res.body.url).not.toBe(before.body.url);
    expect(res.body.url).toMatch(/^memory:\/\/get\/apartments\/apt-1\/reports\/2026\/12\/assembly-hazirun-asm1-[0-9a-f]{16}\.pdf\?ttl=300/);
    const key = decodeURIComponent(res.body.url.slice('memory://get/'.length).split('?')[0]);
    expect((await store.head(key))?.contentType).toBe('application/pdf');
    // Canli sicil degisse de ayni dosya (dondurulmus liste).
    units.push(unit('u9', '9', ls(5)));
    expect((await call('GET', '/asm1/attendance-sheet')).body.url).toBe(res.body.url);
    await attend('u4', 'proxy', { proxyUserId: 'prx-1' });
    expect((await call('GET', '/asm1/attendance-sheet')).body.url).not.toBe(res.body.url);
  });

  it('belge deposu yoksa 503', async () => {
    const { call } = setup({ store: false });
    await call('POST', '', meeting);
    expect((await call('GET', '/asm1/attendance-sheet')).status).toBe(503);
  });

  it('rapor sablonu imza payli yuksek satir ve satir cizgileriyle gecerli PDF uretir', async () => {
    const bytes = await renderReportPdf({
      apartmentName: 'Lale',
      title: 'Hazirun Cetveli',
      sections: [{ columns: [{ header: 'Bölüm', width: 1 }, { header: 'İmza', width: 2 }], rowHeight: 26, ruled: true, rows: Array.from({ length: 40 }, (_, i) => ({ cells: [String(i + 1), ''] })) }],
      generatedAt: T0,
      dataHash: 'a'.repeat(64),
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});

describe('assemblies - saf yeter sayi ve oy sinirlari', () => {
  const entry = (unitId: string, owners: string[], weight = '250') => ({ unitId, owners: owners.map((userId) => ({ userId })), weight });
  const meta = (over = {}) => ({ denominator: '1000', missingLandShare: 0, totalWeight: '1000', ...over });
  const att = (unitId: string, mode: AssemblyAttendance['mode'] = 'present') => ({ unitId, mode });

  it('tam yari yetmez; arsa payi hesaplanamazsa yeter sayi yok; ikinci toplantida aranmaz', () => {
    const entries = ['u0', 'u1', 'u2', 'u3'].map((u) => entry(u, [`o-${u}`]));
    expect(assemblyQuorum({ entries, meta: meta(), attendance: [att('u0'), att('u1')], secondMeeting: false })).toMatchObject({ ownersMajority: false, landShareMajority: false, met: false });
    const missing = assemblyQuorum({ entries, meta: meta({ missingLandShare: 1 }), attendance: entries.map((e) => att(e.unitId)), secondMeeting: false });
    expect(missing).toMatchObject({ ownersMajority: true, landShareComputable: false, met: false, totalLandShare: null });
    expect(assemblyQuorum({ entries, meta: meta({ missingLandShare: 1 }), attendance: [att('u0')], secondMeeting: true })).toMatchObject({ met: true, reasons: [] });
  });

  it('oy siniri, vekalet siniri ve vekil kimligi', () => {
    expect(voteCap(6)).toBe(2);
    expect(voteCap(10)).toBe(3);
    expect(voteCap(2)).toBe(1);
    const entries = [entry('a', ['x']), entry('b', ['x']), entry('c', ['x']), entry('d', ['y', 'z']), entry('e', ['z', 'y'])];
    // Butun oylar 5 (sinirsiz), kisi siniri 1. x uc bolumle sinirli; temsilcisi belli olmayan hisseli bolumler ayri.
    expect(countVotes(entries, [att('a'), att('b'), att('d')])).toEqual({ totalVotes: 5, presentVotes: 2, cap: 1, cappedOwners: 1, totalOwners: 3, presentOwners: 2 });
    expect(voterOf(entry('d', ['y', 'z']))).toBe('unit:d');
    expect(voterOf({ ...entry('d', ['y', 'z']), representativeUserId: 'y' })).toBe('user:y');
    expect(voterOf({ ...entry('d', ['y', 'z']), representativeUserId: 'y' }, { attendee: { userId: 'z' } })).toBe('user:z');
    expect(proxyLimit(40)).toEqual({ kind: 'owners', max: 2 });
    expect(proxyLimit(100)).toEqual({ kind: 'votes', max: 5 });
    expect(proxyKey({ userId: 'u1', name: 'Ali' })).toBe('user:u1');
    expect(proxyKey({ name: '  Ali   DEMİR ' })).toBe(proxyKey({ name: 'ali demir' }));
    expect(decide(2, 3)).toBe('accepted');
    expect(decide(2, 4)).toBe('rejected');
    expect(decide(0, 0)).toBe('rejected');
  });
});

describe('assemblies - zamanlama, yan etkisiz okuma ve tutanak', () => {
  it('toplanti baslamadan katilim / yeter sayi / sayim yazilamaz; hazirun on izlemedir ve hicbir sey dondurmaz', async () => {
    const { call, attend, clock, docs, rolls, audits, version } = setup();
    clock.set(T0);
    await call('POST', '', meeting);
    const early = await attend('u1', 'present');
    expect(early.status).toBe(409);
    expect(early.body.message).toContain('toplantı başladıktan sonra');
    expect((await call('POST', '/asm1/quorum', { version: version() })).status).toBe(409);
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: version(), yes: 1, no: 0, abstain: 0 })).status).toBe(409);
    const sheet = await call('GET', '/asm1/attendance-sheet');
    expect(sheet.body).toMatchObject({ preview: true, fileName: 'hazirun-cetveli-2026-12-15-on-izleme.pdf' });
    expect(docs.get(`${APT}|asm1`)!.roll).toBeUndefined();
    expect(await rolls.entries(APT, 'assembly', 'asm1')).toEqual([]);
    expect(audits.map((a) => a.action)).toEqual(['assembly.create']);
  });

  it('denetcinin hazirun / ayrinti okumasi toplanti sirasinda da yan etkisiz; ilk katilim yazimi dondurur', async () => {
    const { call, attend, token, docs, audits } = setup();
    await call('POST', '', meeting);
    const observer = token('o', 'observer');
    expect((await call('GET', '/asm1/attendance-sheet', undefined, observer)).body.preview).toBe(true);
    expect((await call('GET', '/asm1', undefined, observer)).body.rollFrozen).toBe(false);
    expect(docs.get(`${APT}|asm1`)!.roll).toBeUndefined();
    expect(audits.some((a) => a.action === 'assembly.roll_freeze')).toBe(false);
    expect((await attend('u1', 'present', {}, 'asm1')).status).toBe(200);
    expect(docs.get(`${APT}|asm1`)!.roll).toMatchObject({ frozenAt: DURING });
    expect((await call('GET', '/asm1/attendance-sheet', undefined, observer)).body).toMatchObject({ preview: false, fileName: 'hazirun-cetveli-2026-12-15.pdf' });
  });

  it('yeter sayisizlik tutanagi katilim ister; kimse gelmediyse acik "kimse gelmedi" ile; denetime yazilir', async () => {
    const { call, attend, audits, version } = setup();
    await call('POST', '', meeting);
    const blocked = await call('POST', '/asm1/quorum', { version: version() });
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toContain('kimse gelmedi');
    const none = await call('POST', '/asm1/quorum', { version: version(), noAttendance: true });
    expect(none.status).toBe(200);
    expect(none.body.assembly.quorumRecord).toMatchObject({ met: false, noAttendance: true, presentOwners: 0 });
    expect(audits.at(-1)).toMatchObject({ action: 'assembly.quorum', details: { met: false, noAttendance: true } });

    const { call: call2, attend: attend2, version: version2 } = setup();
    await call2('POST', '', meeting);
    await attend2('u1', 'present');
    expect((await call2('POST', '/asm1/quorum', { version: version2(), noAttendance: true })).status).toBe(400);
    expect((await call2('POST', '/asm1/quorum', { version: version2() })).body.assembly.quorumRecord).toMatchObject({ met: false, noAttendance: false });
    void attend;
  });

  it('KMK m.31 kisi siniri hisseli bolum temsilcisi uzerinden de uygulanir (sinirdan kacis yok)', async () => {
    const units = ['1', '2', '3', '4', '5', '6'].map((x) => unit(`u${x}`, x, ls(100)));
    const half = { numerator: 1, denominator: 2 };
    const members = [owner('P', 'u1'), owner('P', 'u2'), owner('P', 'u3', { ownershipShare: half }), owner('Q', 'u3', { ownershipShare: half }), owner('o4', 'u4'), owner('o5', 'u5'), owner('o6', 'u6')];
    const { call, attend } = setup({ units, members });
    await call('POST', '', meeting);
    await attend('u1', 'present');
    await attend('u2', 'present');
    // P hisseli bolumu temsil ederse uc bolumun oyunu kullanir: siniri floor(6/3) = 2.
    await attend('u3', 'present', { attendeeUserId: 'P' });
    let q = (await call('GET', '/asm1')).body.quorum;
    expect(q).toMatchObject({ totalVotes: 6, presentUnits: 3, presentVotes: 2, cappedOwners: 1, presentOwners: 1 });
    // Q temsil ederse P iki bolumle sinirin altinda: 3 oy, 2 kat maliki.
    await attend('u3', 'present', { attendeeUserId: 'Q' });
    q = (await call('GET', '/asm1')).body.quorum;
    expect(q).toMatchObject({ presentVotes: 3, cappedOwners: 0, presentOwners: 2 });
  });
});
