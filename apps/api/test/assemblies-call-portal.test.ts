/**
 * Genel kurul devami: cagri (davet) e-postasi (ASSEMBLY_CALLED outbox olayi, alicilar, tercih
 * kategorisi, 15 gun uyarisi, acik yeniden gonderim) ve kat maliki sakin portali (kiraci haric,
 * baska maliklerin verisi yok).
 */
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { Unit } from '../src/modules/core/types.js';
import { createEmailNotifier } from '../src/modules/notifications/email.js';
import { ASSEMBLY_CALL_DISCLAIMER, renderEmail } from '../src/modules/notifications/templates.js';
import { type Notification, type SqsEvent, createNotificationWorker } from '../src/workers/notification-worker.js';
import { APT, T0, defaultMembers, defaultUnits, ls, meeting, owner, setup, unit } from './fakes/assemblyWorld.js';

const plan = { scheduledAt: '2026-12-29T19:00:00+03:00', location: 'Bahçe' };
const sqs = (list: DomainEvent[]): SqsEvent => ({ Records: list.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) });
const quiet = { info: () => {}, error: () => {} };

/** 27.11.2026: toplantiya (15.12.2026) 18 gun var. */
function beforeMeeting(opts: Parameters<typeof setup>[0] = {}) {
  return setup({ now: T0, ...opts });
}

function workerFor(w: ReturnType<typeof setup>, sent: Notification[], now = new Date(T0)) {
  const processed = new Set<string>();
  return createNotificationWorker({
    memberships: { list: async (apt) => w.members.filter((m) => m.apartmentId === apt) },
    core: { listUnits: async () => [] as Unit[] },
    roles: { list: async () => [] as ApartmentRole[] },
    gate: { get: async () => undefined },
    reservations: { getBooking: async () => undefined },
    assemblies: w.repo,
    notifier: { channel: 'test', send: async (n) => void sent.push(n) },
    isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
    markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
    now: () => now,
    log: quiet,
  });
}

describe('cagri: kayit, olay ve uyarilar', () => {
  it('ilk cagri outbox olayi + degismez alici kaydi ile; deterministik olay kimligi; denetimli', async () => {
    const members = [...defaultMembers(), owner('own-5', 'u5', { startDate: '2026-12-10' })];
    const w = beforeMeeting({ units: [...defaultUnits(), unit('u5', '5', ls(0))], members });
    await w.call('POST', '', { ...meeting, secondMeetingPlan: plan });
    const pre = (await w.call('GET', '/asm1')).body;
    // own-5 oy listesi gununde malik ama bugun apartman kullanicisi degil: e-posta gitmez.
    expect(pre.callCheck).toEqual({ daysBefore: 18, lateNotice: false, recipients: 5, ownersWithoutAccount: 1, warnings: [] });
    const res = await w.call('POST', '/asm1/call', { version: w.version() });
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ seq: 1, eventId: 'ASSEMBLY_CALLED:asm1:1', recipients: 5, ownersWithoutAccount: 1, daysBefore: 18, lateNotice: false, resend: false });
    expect(res.body.warnings).toEqual([]);
    expect(w.outbox).toHaveLength(1);
    expect(w.outbox[0]).toMatchObject({
      eventId: 'ASSEMBLY_CALLED:asm1:1',
      type: 'ASSEMBLY_CALLED',
      apartmentId: APT,
      payload: { assemblyId: 'asm1', callSeq: 1, kind: 'ordinary', secondMeeting: false, location: 'Site toplantı salonu', agenda: ['Yönetim kurulu seçimi', 'İşletme projesi'], secondMeetingPlan: { scheduledAt: '2026-12-29T16:00:00.000Z', location: 'Bahçe' }, resend: false },
    });
    expect(JSON.stringify(w.outbox[0]!.payload)).not.toContain('own-');
    const callRec = await w.repo.getCall(APT, 'asm1', 1);
    expect(callRec?.recipientUserIds).toEqual(['own-1', 'own-2a', 'own-2b', 'own-3', 'own-4']);
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.call', details: { seq: 1, recipients: 5, ownersWithoutAccount: 1, lateNotice: false, eventId: 'ASSEMBLY_CALLED:asm1:1' } });
    // Ikinci gonderim acik ve gerekceli.
    expect((await w.call('POST', '/asm1/call', { version: w.version() })).status).toBe(409);
    expect((await w.call('POST', '/asm1/call', { version: w.version(), resend: true })).status).toBe(400);
    const again = await w.call('POST', '/asm1/call', { version: w.version(), resend: true, reason: 'Yer değişti' });
    expect(again.body.call).toMatchObject({ seq: 2, eventId: 'ASSEMBLY_CALLED:asm1:2', resend: true, reason: 'Yer değişti' });
    expect(w.outbox.map((e) => e.eventId)).toEqual(['ASSEMBLY_CALLED:asm1:1', 'ASSEMBLY_CALLED:asm1:2']);
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.call_resend', reason: 'Yer değişti' });
  });

  it('olaganustu toplantida 15 gunden az kala cagri uyari verir (m.29/2) ama gonderilir; olaganda yalnizca yumusak not; baslamissa 409; denetci gonderemez', async () => {
    const w = setup({ now: '2026-12-05T09:00:00.000Z' });
    await w.call('POST', '', { ...meeting, kind: 'extraordinary' });
    const res = await w.call('POST', '/asm1/call', { version: w.version() });
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ daysBefore: 10, lateNotice: true });
    expect(res.body.warnings[0]).toContain('KMK m.29/2: olağanüstü toplantıya çağrı toplantıdan en az 15 gün önce');
    const ord = setup({ now: '2026-12-05T09:00:00.000Z' });
    await ord.call('POST', '', meeting);
    const soft = await ord.call('POST', '/asm1/call', { version: ord.version() });
    expect(soft.body.call).toMatchObject({ daysBefore: 10, lateNotice: false });
    expect(soft.body.warnings[0]).toContain('yönetim planında belirtilen zamanda');
    expect(soft.body.warnings[0]).not.toContain('m.29/2');
    const late = setup();
    await late.call('POST', '', meeting);
    expect((await late.call('POST', '/asm1/call', { version: late.version() })).status).toBe(409);
    const o = beforeMeeting();
    await o.call('POST', '', meeting);
    expect((await o.call('POST', '/asm1/call', { version: o.version() }, o.token('obs', 'observer'))).status).toBe(403);
  });

  it('ikinci toplanti plani: 15 gunu asamaz, 7 gunden az olamaz (m.29/3, 400); cagri sonrasi duzenleme cagriyi eskitir', async () => {
    const w = beforeMeeting();
    expect((await w.call('POST', '', { ...meeting, secondMeetingPlan: { scheduledAt: '2027-01-05T19:00:00+03:00', location: 'Bahçe' } })).status).toBe(400);
    expect((await w.call('POST', '', { ...meeting, secondMeetingPlan: { scheduledAt: '2026-12-20T19:00:00+03:00' } })).status).toBe(400);
    const short = await w.call('POST', '', { ...meeting, secondMeetingPlan: { scheduledAt: '2026-12-21T19:00:00+03:00', location: 'Bahçe' } });
    expect(short.status).toBe(400);
    expect(short.body.message).toContain('en az 7 gün');
    // 7 gun dahil gecerli.
    expect((await w.call('POST', '', { ...meeting, secondMeetingPlan: { scheduledAt: '2026-12-22T19:00:00+03:00', location: 'Bahçe' } })).status).toBe(201);
    expect((await w.call('GET', '/asm1')).body.warnings).toEqual([]);
    await w.call('POST', '/asm1/call', { version: w.version() });
    expect((await w.call('GET', '/asm1')).body.callOutdated).toBe(false);
    await w.call('PATCH', '/asm1', { version: w.version(), location: 'Kafeterya' });
    expect((await w.call('GET', '/asm1')).body.callOutdated).toBe(true);
  });
});

describe('cagri bildirimi: worker, e-posta ve tercih', () => {
  it('worker cagri kaydindaki guncel uyelere gonderir; iptal edilen veya baslamis toplantida kimseye', async () => {
    const w = beforeMeeting();
    await w.call('POST', '', { ...meeting, secondMeetingPlan: plan });
    await w.call('POST', '/asm1/call', { version: w.version() });
    // own-4 bu arada tasindi: gonderim aninda uye degil.
    w.members[4] = { ...w.members[4]!, status: 'inactive', endDate: '2026-11-26' };
    const sent: Notification[] = [];
    expect((await workerFor(w, sent)(sqs(w.outbox))).batchItemFailures).toEqual([]);
    expect(sent.map((n) => n.userId).sort()).toEqual(['own-1', 'own-2a', 'own-2b', 'own-3']);
    expect(sent[0]).toMatchObject({ template: 'assembly_called', category: 'assemblies', eventId: 'ASSEMBLY_CALLED:asm1:1', data: { assemblyId: 'asm1', secondMeetingAt: '2026-12-29T16:00:00.000Z', resend: 'false' } });

    const late: Notification[] = [];
    await workerFor(w, late, new Date('2026-12-15T17:00:00.000Z'))(sqs(w.outbox));
    expect(late).toEqual([]);
    await w.call('POST', '/asm1/cancel', { version: w.version(), reason: 'Ertelendi' });
    const cancelled: Notification[] = [];
    await workerFor(w, cancelled)(sqs(w.outbox));
    expect(cancelled).toEqual([]);
  });

  it('cagridan sonra toplanti tasindiysa gecikmis / yeniden surulen teslim eski bilgiyi e-postalamaz; yeniden gonderilen cagri gider', async () => {
    const w = beforeMeeting();
    await w.call('POST', '', meeting);
    await w.call('POST', '/asm1/call', { version: w.version() });
    const first = [...w.outbox];
    await w.call('PATCH', '/asm1', { version: w.version(), location: 'Kafeterya' });
    const stale: Notification[] = [];
    expect((await workerFor(w, stale)(sqs(first))).batchItemFailures).toEqual([]);
    expect(stale).toEqual([]);
    await w.call('POST', '/asm1/call', { version: w.version(), resend: true, reason: 'Yer değişti' });
    const fresh: Notification[] = [];
    await workerFor(w, fresh)(sqs(w.outbox.slice(1)));
    expect(fresh).toHaveLength(5);
    expect(fresh[0]).toMatchObject({ eventId: 'ASSEMBLY_CALLED:asm1:2', data: { location: 'Kafeterya', resend: 'true' } });
  });

  it('e-posta: tarih Istanbul saatiyle, yer, gundem, ikinci toplanti ve yasal cagrinin yerine gecmedigi notu; HTML escape', () => {
    const r = renderEmail(
      {
        eventId: 'E',
        apartmentId: APT,
        userId: 'own-1',
        template: 'assembly_called',
        data: { assemblyId: 'asm1', kind: 'ordinary', secondMeeting: 'false', scheduledAt: '2026-12-15T16:00:00.000Z', location: 'Salon', onlineUrl: 'https://meet.example/x', agenda: [{ label: 'Bütçe <b>' }, { label: 'Dilekler' }], secondMeetingAt: '2026-12-29T16:00:00.000Z', secondMeetingLocation: 'Bahçe', resend: 'false' },
      },
      { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://site.example/app' },
    )!;
    expect(r.subject).toBe('Kat malikleri kurulu toplantısı - 15.12.2026 19:00 - Lale');
    expect(r.text).toContain('Tarih ve saat: 15.12.2026 19:00 (Türkiye saati)');
    expect(r.text).toContain('Gündem:\n1. Bütçe <b>\n2. Dilekler');
    expect(r.text).toContain('ikinci toplantı 29.12.2026 19:00 tarihinde (Bahçe)');
    expect(r.text).toContain(ASSEMBLY_CALL_DISCLAIMER);
    expect(r.text).toContain('https://site.example/app/genel-kurul/asm1');
    expect(r.html).toContain('Bütçe &lt;b&gt;');
    expect(r.html).not.toContain('Bütçe <b>');
  });

  it('tercih: genel kurul kategorisini kapatan malik atlanir; anket kategorisini kapatan almaya devam eder', async () => {
    const w = beforeMeeting();
    await w.call('POST', '', meeting);
    await w.call('POST', '/asm1/call', { version: w.version() });
    const to: string[] = [];
    const email = createEmailNotifier({
      sender: { send: async (m) => (to.push(m.to), { messageId: 'm' }) },
      preferences: { get: async (u) => ({ email: u === 'own-1' ? { enabled: true, assemblies: false } : u === 'own-3' ? { enabled: true, polls: false } : { enabled: true } }) },
      people: { get: async (_a, u) => ({ email: `${u}@b.co`, fullName: u }) as never },
      core: { getSite: async () => ({ name: 'Site' }) as never, listUnits: async () => [], listBlocks: async () => [] },
      sentLog: { has: async () => false, record: async () => {} },
      now: () => new Date(T0),
      log: quiet,
    });
    const processed = new Set<string>();
    const worker = createNotificationWorker({
      memberships: { list: async () => w.members },
      core: { listUnits: async () => [] as Unit[] },
      roles: { list: async () => [] as ApartmentRole[] },
      gate: { get: async () => undefined },
      reservations: { getBooking: async () => undefined },
      assemblies: w.repo,
      notifier: email,
      isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
      markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
      now: () => new Date(T0),
      log: quiet,
    });
    await worker(sqs(w.outbox));
    expect(to.sort()).toEqual(['own-2a@b.co', 'own-2b@b.co', 'own-3@b.co', 'own-4@b.co']);
  });
});

describe('sakin portali: kat maliki gorunumu', () => {
  async function heldWorld() {
    const members = [...defaultMembers(), owner('ten-1', 'u1', { relation: 'tenant' })];
    const w = beforeMeeting({ members });
    await w.call('POST', '', { ...meeting, agenda: [{ title: 'Yönetici seçimi', decisionKind: 'manager_election' }, 'İşletme projesi'] }); // asm1
    await w.call('POST', '', { ...meeting, scheduledAt: '2026-12-20T19:00:00+03:00' }); // asm2: cagri yok
    await w.call('POST', '/asm1/call', { version: w.version() });
    return w;
  }

  it('malik cagrisi gonderilmis toplantiyi gorur; cagrisiz toplanti gizli; kiraci ve yonetim rolu 403', async () => {
    const w = await heldWorld();
    const ownerTok = w.token('own-3', 'resident');
    const list = await w.portal('', ownerTok);
    expect(list.status).toBe(200);
    expect(list.body.items.map((a: any) => a.assemblyId)).toEqual(['asm1']);
    expect(list.body.items[0]).toMatchObject({ phase: 'upcoming', location: 'Site toplantı salonu', calledAt: T0, minutesAvailable: false, agenda: [{ title: 'Yönetici seçimi', majority: 'persons_and_land' }, { majority: 'attendees' }] });
    expect((await w.portal('/asm2', ownerTok)).status).toBe(404);
    expect((await w.portal('', w.token('ten-1', 'resident'))).status).toBe(403);
    expect((await w.portal('', w.token('mgr-1', 'apartment_manager'))).status).toBe(403);
    expect((await w.portal('', w.token('own-3', 'resident', 'apt-2'))).status).toBe(403);
    expect((await w.portal('/asm1/minutes', ownerTok)).status).toBe(409);
  });

  it('kesinlesen toplantida kararlar (toplam sayilar) ve tutanak linki; baska maliklerin adi / bolum katilimi yok', async () => {
    const w = await heldWorld();
    w.clock.set('2026-12-15T16:30:00.000Z');
    await w.attend('u1', 'present');
    await w.attend('u2', 'present', { attendeeUserId: 'own-2a' });
    await w.attend('u4', 'present');
    await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), votes: { u1: 'yes', u2: 'yes', u4: 'yes' } });
    await w.call('POST', '/asm1/agenda/a2/tally', { version: w.version(), yes: 2, no: 1, abstain: 0 });
    await w.call('PUT', '/asm1/minutes', { version: w.version(), chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'] });
    const ownerTok = w.token('own-3', 'resident');
    // Kesinlesmeden once kararlar gosterilmez.
    const pending = (await w.portal('/asm1', ownerTok)).body;
    expect(pending.phase).toBe('awaiting_minutes');
    expect(pending.agenda[0].decision).toBeUndefined();
    await w.call('POST', '/asm1/finalize', { version: w.version() });

    const d = await w.portal('/asm1', ownerTok);
    expect(d.body).toMatchObject({
      phase: 'held',
      minutesAvailable: true,
      quorum: { met: true, presentOwners: 3, totalOwners: 4, presentVotes: 3, totalVotes: 4 },
      agenda: [
        { decision: { decision: 'accepted', rule: 'persons_and_land', votes: { yes: 3, no: 0, abstain: 0 }, units: { yes: 3 }, landShareBps: { yes: 9000 }, corrected: false } },
        { decision: { decision: 'accepted', rule: 'attendees', votes: { yes: 2, no: 1 }, units: null } },
      ],
    });
    const json = JSON.stringify(d.body);
    for (const leak of ['own-', 'Kişi', 'u1', 'u4', 'unitVotes', 'recordedBy']) expect(json).not.toContain(leak);
    const minutes = await w.portal('/asm1/minutes', ownerTok);
    expect(minutes.status).toBe(200);
    expect(minutes.body).toMatchObject({ fileName: 'toplanti-tutanagi-2026-12-15.pdf', contentType: 'application/pdf' });
    expect(minutes.body.url).toMatch(/assembly-minutes-asm1-[0-9a-f]{16}\.pdf\?ttl=300&/);
    expect(minutes.body.preview).toBeUndefined();
    // Yonetimin tutanagi ile ayni dosya.
    expect((await w.call('GET', '/asm1/minutes')).body.url).toBe(minutes.body.url);
    expect((await w.portal('/asm1/minutes', w.token('ten-1', 'resident'))).status).toBe(403);
  });
});
