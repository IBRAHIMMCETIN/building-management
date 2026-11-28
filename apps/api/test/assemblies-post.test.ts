/**
 * Genel kurul sonrasi: cagrisi gonderilmis toplantinin iptal / erteleme bildirimi, cagri alici
 * kovalari (8.000+ malik), cok adayli secim (m.34 / m.41), yasal cagri teslim takibi (m.29).
 * Yazili riza: assemblies-consent.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { decisionBookReport, minutesReport } from '../src/modules/assemblies/minutes.js';
import { resolveCall } from '../src/modules/assemblies/repository.js';
import { CALL_RECIPIENTS_PER_BUCKET, type AssemblyCall, type AssemblyCallRecipients, type AssemblyDecision } from '../src/modules/assemblies/types.js';
import type { Unit } from '../src/modules/core/types.js';
import { renderPush } from '../src/modules/notifications/push-templates.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import { type Notification, type SqsEvent, createNotificationWorker } from '../src/workers/notification-worker.js';
import { APT, DURING, T0, ls, meeting, owner, setup, unit } from './fakes/assemblyWorld.js';

const sqs = (list: DomainEvent[]): SqsEvent => ({ Records: list.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) });
const quiet = { info: () => {}, error: () => {} };

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

async function called() {
  const w = setup({ now: T0 });
  await w.call('POST', '', meeting);
  await w.call('POST', '/asm1/call', { version: w.version() });
  return w;
}

describe('iptal bildirimi', () => {
  it('cagrisi gonderilmis toplanti iptali: deterministik olay (gerekce payloadda yok), denetim, tum cagri alicilarina e-posta + push sablonu', async () => {
    const w = await called();
    // Ikinci cagri (yeniden gonderim) sonra uyelik kazanan maliki de kapsar: alicilar birlesim.
    w.members.push(owner('own-9', 'u3'));
    await w.call('POST', '/asm1/call', { version: w.version(), resend: true, reason: 'Gündem netleşti' });
    const res = await w.call('POST', '/asm1/cancel', { version: w.version(), reason: 'Yönetici istifa etti' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Yönetici istifa etti', cancelEventId: 'ASSEMBLY_CANCELLED:asm1' });
    const ev = w.outbox.find((e) => e.type === 'ASSEMBLY_CANCELLED');
    expect(ev).toMatchObject({ eventId: 'ASSEMBLY_CANCELLED:asm1', apartmentId: APT, payload: { assemblyId: 'asm1', scheduledAt: '2026-12-15T16:00:00.000Z', kind: 'ordinary' } });
    expect(JSON.stringify(ev)).not.toContain('istifa');
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.cancel', reason: 'Yönetici istifa etti', details: { notified: true, eventId: 'ASSEMBLY_CANCELLED:asm1' } });

    const sent: Notification[] = [];
    await workerFor(w, sent)(sqs([ev!]));
    expect(sent.map((n) => n.userId).sort()).toEqual(['own-1', 'own-2a', 'own-2b', 'own-3', 'own-4', 'own-9']);
    expect(sent[0]).toMatchObject({ template: 'assembly_cancelled', category: 'assemblies', data: { assemblyId: 'asm1', reason: 'Yönetici istifa etti' } });
    const mail = renderEmail(sent[0]!, { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://site.example/app' })!;
    expect(mail.subject).toContain('İptal: kat malikleri kurulu toplantısı - 15.12.2026 19:00');
    expect(mail.text).toContain('Gerekçe: Yönetici istifa etti');
    expect(mail.text).toContain('https://site.example/app/genel-kurul/asm1');
    expect(renderPush(sent[0]!)).toMatchObject({ title: 'Kat malikleri kurulu toplantısı iptal edildi', path: '/genel-kurul/asm1', category: 'assemblies' });
    // Push gerekce tasimaz.
    expect(JSON.stringify(renderPush(sent[0]!))).not.toContain('istifa');
  });

  it('cagrisiz veya baslamis toplantinin iptali bildirim uretmez; iptal edilmemis toplanti icin bayat olay kimseye gitmez', async () => {
    const w = setup({ now: T0 });
    await w.call('POST', '', meeting);
    await w.call('POST', '/asm1/cancel', { version: w.version(), reason: 'Gerek kalmadı' });
    expect(w.outbox).toEqual([]);
    expect(w.audits.at(-1)).toMatchObject({ details: { notified: false } });
    const late = await called();
    late.clock.set(DURING);
    await late.call('POST', '/asm1/cancel', { version: late.version(), reason: 'Kimse gelmedi' });
    expect(late.outbox.map((e) => e.type)).toEqual(['ASSEMBLY_CALLED']);
    // Elle uretilmis (iptal edilmemis toplanti) olay: worker kaydi okur, kimseye gondermez.
    const live = await called();
    const fake = { ...live.outbox[0]!, eventId: 'ASSEMBLY_CANCELLED:asm1', type: 'ASSEMBLY_CANCELLED', payload: { assemblyId: 'asm1', scheduledAt: '2026-12-15T16:00:00.000Z', kind: 'ordinary' } } as DomainEvent;
    const sent: Notification[] = [];
    await workerFor(live, sent)(sqs([fake]));
    expect(sent).toEqual([]);
  });

  it('sakin portali iptali gosterir (gerekce, iptal tarihi)', async () => {
    const w = await called();
    await w.call('POST', '/asm1/cancel', { version: w.version(), reason: 'Yönetici istifa etti' });
    const d = await w.portal('/asm1', w.token('own-3', 'resident'));
    expect(d.body).toMatchObject({ phase: 'cancelled', status: 'cancelled', cancelReason: 'Yönetici istifa etti', cancelledAt: T0 });
  });
});

describe('erteleme / yer degisikligi bildirimi', () => {
  it('erteleme gerekceli, denetimli, gecmise yazilir; olay deterministik; e-posta yeni tarih ve onceki tarihle; oy listesi gunu tasinir', async () => {
    const w = await called();
    const res = await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon tadilatta' });
    expect(res.status).toBe(200);
    expect(res.body.assembly).toMatchObject({ scheduledAt: '2026-12-20T16:00:00.000Z', rollDate: '2026-12-20', reschedules: [{ seq: 1, previousScheduledAt: '2026-12-15T16:00:00.000Z', scheduledAt: '2026-12-20T16:00:00.000Z', reason: 'Salon tadilatta', eventId: 'ASSEMBLY_RESCHEDULED:asm1:1' }] });
    expect(res.body.warnings.join(' ')).toContain('çağrı usulünü yeniden uygulayın');
    const ev = w.outbox.at(-1)!;
    expect(ev).toMatchObject({ eventId: 'ASSEMBLY_RESCHEDULED:asm1:1', type: 'ASSEMBLY_RESCHEDULED', payload: { assemblyId: 'asm1', seq: 1, previousScheduledAt: '2026-12-15T16:00:00.000Z', scheduledAt: '2026-12-20T16:00:00.000Z', location: 'Site toplantı salonu' } });
    expect(JSON.stringify(ev)).not.toContain('tadilat');
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.reschedule', reason: 'Salon tadilatta', details: { seq: 1, timeChanged: true, placeChanged: false } });
    // Onceki cagri eskidi.
    expect((await w.call('GET', '/asm1')).body.callOutdated).toBe(true);

    const sent: Notification[] = [];
    await workerFor(w, sent)(sqs(w.outbox));
    // Eski cagri (ASSEMBLY_CALLED:1) gonderilmez, erteleme bildirimi gider.
    expect(sent.every((n) => n.template === 'assembly_rescheduled')).toBe(true);
    expect(sent).toHaveLength(5);
    expect(sent[0]).toMatchObject({ data: { previousScheduledAt: '2026-12-15T16:00:00.000Z', scheduledAt: '2026-12-20T16:00:00.000Z', timeChanged: 'true', placeChanged: 'false', reason: 'Salon tadilatta' } });
    const mail = renderEmail(sent[0]!, { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://site.example/app' })!;
    expect(mail.subject).toContain('Ertelendi: kat malikleri kurulu toplantısı - 20.12.2026 19:00');
    expect(mail.text).toContain('Önceki tarih: 15.12.2026 19:00');
    expect(renderPush(sent[0]!)).toMatchObject({ title: 'Kat malikleri kurulu toplantısı ertelendi', path: '/genel-kurul/asm1' });

    // Ikinci degisiklik birinciyi eskitir: gecikmis birinci olay kimseye gitmez.
    await w.call('POST', '/asm1/reschedule', { version: w.version(), location: 'Bahçe', reason: 'Hava güzel' });
    const stale: Notification[] = [];
    await workerFor(w, stale)(sqs([ev]));
    expect(stale).toEqual([]);
    const fresh: Notification[] = [];
    await workerFor(w, fresh)(sqs([w.outbox.at(-1)!]));
    expect(fresh[0]).toMatchObject({ template: 'assembly_rescheduled', data: { timeChanged: 'false', placeChanged: 'true', location: 'Bahçe' } });
    expect(renderEmail(fresh[0]!, { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://x/app' })!.subject).toContain('Yer değişikliği');

    // Sakin portali erteleme gecmisini gosterir.
    const p = await w.portal('/asm1', w.token('own-1', 'resident'));
    expect(p.body.reschedules).toEqual([
      { previousScheduledAt: '2026-12-15T16:00:00.000Z', scheduledAt: '2026-12-20T16:00:00.000Z', placeChanged: false, reason: 'Salon tadilatta', at: T0 },
      { previousScheduledAt: '2026-12-20T16:00:00.000Z', scheduledAt: '2026-12-20T16:00:00.000Z', placeChanged: true, reason: 'Hava güzel', at: T0 },
    ]);
  });

  it('ikinci toplanti plani olan ilk toplanti: tarih degisince yeni plan zorunlu ve 7-15 gun yeniden dogrulanir; bildirimde yeni plan', async () => {
    const w = setup({ now: T0 });
    await w.call('POST', '', { ...meeting, secondMeetingPlan: { scheduledAt: '2026-12-29T19:00:00+03:00', location: 'Bahçe' } });
    await w.call('POST', '/asm1/call', { version: w.version() });
    const missing = await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon dolu' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('ikinci toplantının yeri ve zamanı da yeniden bildirilmelidir');
    // Eski plan yeni tarihle 7 gunden az (9 gun degil: 20.12 -> 29.12 = 9 gun gecerli); 22.12 -> 3 gun gecersiz.
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-26T19:00:00+03:00', reason: 'Salon dolu', secondMeetingPlan: { scheduledAt: '2026-12-29T19:00:00+03:00', location: 'Bahçe' } })).status).toBe(400);
    const ok = await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon dolu', secondMeetingPlan: { scheduledAt: '2027-01-03T19:00:00+03:00', location: 'Bahçe' } });
    expect(ok.status).toBe(200);
    expect(ok.body.assembly.secondMeetingPlan).toMatchObject({ scheduledAt: '2027-01-03T16:00:00.000Z' });
    expect(ok.body.reschedule).toMatchObject({ previousSecondMeetingPlan: { scheduledAt: '2026-12-29T16:00:00.000Z' }, secondMeetingPlan: { scheduledAt: '2027-01-03T16:00:00.000Z' } });
    expect(w.audits.at(-1)).toMatchObject({ details: { secondMeetingPlanChanged: true } });
    const sent: Notification[] = [];
    await workerFor(w, sent)(sqs([w.outbox.at(-1)!]));
    const mail = renderEmail(sent[0]!, { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://x/app' })!;
    expect(mail.text).toContain('ikinci toplantı 03.01.2027 19:00 tarihinde (Bahçe)');
  });

  it('bagli ikinci toplanti varken ilk toplantinin yeni tarihi araligi bozarsa 409; one alinan tarih "tarihi degisti"; onceki tarih maliklere en son bildirilen', async () => {
    const w = await called();
    // Savunma: ilk toplantiya bagli (iptal edilmemis) ikinci toplanti kaydi.
    const first = w.docs.get(`${APT}|asm1`)!;
    w.docs.set(`${APT}|asm9`, { ...first, SK: 'ASSEMBLY#asm9', assemblyId: 'asm9', firstMeetingId: 'asm1', secondMeeting: true, scheduledAt: '2026-12-26T16:00:00.000Z', calls: [] });
    const bad = await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-22T19:00:00+03:00', reason: 'Salon dolu' });
    expect(bad.status).toBe(409);
    expect(bad.body.message).toContain('bağlı ikinci toplantı');
    w.docs.set(`${APT}|asm9`, { ...w.docs.get(`${APT}|asm9`)!, status: 'cancelled' });
    await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon dolu' });
    const earlier = await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-12T19:00:00+03:00', reason: 'Bayram' });
    // Onceki tarih: son bildirim (20.12), cagridaki ilk tarih (15.12) degil.
    expect(earlier.body.reschedule.previousScheduledAt).toBe('2026-12-20T16:00:00.000Z');
    expect(w.audits.at(-1)).toMatchObject({ details: { movedEarlier: true, timeChanged: true } });
    const sent: Notification[] = [];
    await workerFor(w, sent)(sqs([w.outbox.at(-1)!]));
    expect(sent[0]).toMatchObject({ data: { movedEarlier: 'true', previousScheduledAt: '2026-12-20T16:00:00.000Z' } });
    const mail = renderEmail(sent[0]!, { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://x/app' })!;
    expect(mail.subject).toContain('Tarihi değişti: kat malikleri kurulu toplantısı - 12.12.2026 19:00');
    expect(mail.subject).not.toContain('Ertelendi');
    expect(renderPush(sent[0]!)).toMatchObject({ title: 'Kat malikleri kurulu toplantısının tarihi değişti' });
  });

  it('kurallar: cagrisiz toplantida 409 (duzenleme kullanilir), cagri sonrasi duzenlemeyle tarih degismez, alan kisiti, degisiklik sarti, gecmis tarih, baslamis toplanti, denetci 403', async () => {
    const w = setup({ now: T0 });
    await w.call('POST', '', meeting);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon dolu' })).status).toBe(409);
    await w.call('POST', '/asm1/call', { version: w.version() });
    expect((await w.call('PATCH', '/asm1', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00' })).status).toBe(409);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00' })).status).toBe(400);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), agenda: ['X'], reason: 'Gündem' })).status).toBe(400);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), location: 'Site toplantı salonu', reason: 'Aynı' })).status).toBe(400);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-11-20T19:00:00+03:00', reason: 'Geçmiş' })).status).toBe(400);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon dolu' }, w.token('obs', 'observer'))).status).toBe(403);
    w.clock.set(DURING);
    expect((await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2026-12-20T19:00:00+03:00', reason: 'Salon dolu' })).status).toBe(409);
  });
});

describe('cagri alici kovalari (buyuk site)', () => {
  it('11.000 malik kullanicisi (5.500 hisseli bolum): alicilar 1.000lik degismez kovalarda, hicbir oge 400 KB sinirina yaklasmaz; okuma birlestirir; worker herkese', async () => {
    const n = 11_000;
    const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    // 5.500 hisseli bolum, bolum basina iki paydas: 11.000 malik kullanicisi.
    const units = Array.from({ length: n / 2 }, (_, i) => unit(`u${i}`, String(i + 1), ls(1)));
    const half = { ownershipShare: { numerator: 1, denominator: 2 } };
    const members = units.flatMap((u, i) => [owner(uid(2 * i), u.unitId, half), owner(uid(2 * i + 1), u.unitId, half)]);
    const w = setup({ now: T0, units, members });
    await w.call('POST', '', meeting);
    const res = await w.call('POST', '/asm1/call', { version: w.version() });
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ recipients: n });
    const header = [...w.extra.values()].find((x): x is AssemblyCall => x.entityType === 'ASSEMBLY_CALL')!;
    expect(header).toMatchObject({ recipientCount: n, buckets: Math.ceil(n / CALL_RECIPIENTS_PER_BUCKET) });
    expect(header).not.toHaveProperty('recipientUserIds');
    const buckets = [...w.extra.values()].filter((x): x is AssemblyCallRecipients => x.entityType === 'ASSEMBLY_CALL_RECIPIENTS');
    expect(buckets).toHaveLength(11);
    expect(buckets.map((b) => b.SK)).toContain('ASMCALLR#asm1#001#010');
    for (const b of buckets) expect(JSON.stringify(b).length).toBeLessThan(100_000);
    // Tek ogede tutulsaydi 400 KB'yi asardi.
    expect(JSON.stringify(buckets.flatMap((b) => b.userIds)).length).toBeGreaterThan(400_000);
    const resolved = await w.repo.getCall(APT, 'asm1', 1);
    expect(resolved?.recipientUserIds).toHaveLength(n);
    expect(new Set(resolved?.recipientUserIds).size).toBe(n);
    expect(w.audits.at(-1)).toMatchObject({ details: { recipients: n, buckets: 11, parts: 11 } });
    // Bildirim 11 parcaya bolunur: worker mesaj basina ~1.000 alici (60 sn icinde).
    expect(w.outbox.map((e) => e.eventId)).toEqual(Array.from({ length: 11 }, (_, k) => `ASSEMBLY_CALLED:asm1:1:p${k}`));
    const perPart: number[] = [];
    const sent: Notification[] = [];
    for (const ev of w.outbox) {
      const part: Notification[] = [];
      await workerFor(w, part)(sqs([ev]));
      perPart.push(part.length);
      sent.push(...part);
    }
    expect(sent).toHaveLength(n);
    expect(new Set(sent.map((x) => x.userId)).size).toBe(n);
    expect(Math.max(...perPart)).toBeLessThan(1_400);
    // Iptal bildirimi de parcali (tum cagrilarin alici birlesimi).
    await w.call('POST', '/asm1/cancel', { version: w.version(), reason: 'Salon yok' });
    expect(w.outbox.filter((e) => e.type === 'ASSEMBLY_CANCELLED').map((e) => e.eventId)).toHaveLength(11);
  }, 60_000);

  it('eski (kovasiz) cagri kaydi aynen okunur', () => {
    const legacy: AssemblyCall = { PK: `APT#${APT}`, SK: 'ASMCALL#asm1#001', entityType: 'ASSEMBLY_CALL', apartmentId: APT, assemblyId: 'asm1', seq: 1, recipientUserIds: ['a', 'b'], calledAt: T0, calledBy: 'm' };
    const other = { PK: `APT#${APT}`, SK: 'ASMCALLR#asm1#002#000', entityType: 'ASSEMBLY_CALL_RECIPIENTS', apartmentId: APT, assemblyId: 'asm1', seq: 2, bucket: 0, userIds: ['x'] } as AssemblyCallRecipients;
    expect(resolveCall(legacy, [other]).recipientUserIds).toEqual(['a', 'b']);
  });
});

const election = {
  ...meeting,
  agenda: [
    { title: 'Yönetici seçimi', decisionKind: 'manager_election', candidates: ['Ali Veli', { name: 'Ayşe Kaya' }] },
    { title: 'Denetçi seçimi', decisionKind: 'auditor_election', candidates: [{ name: 'Mehmet Demir', userId: 'own-3' }, { name: 'Dış Denetçi' }] },
  ],
};

async function electionMeeting() {
  const w = setup();
  expect((await w.call('POST', '', election)).status).toBe(201);
  await w.attend('u1', 'present');
  await w.attend('u2', 'present', { attendeeUserId: 'own-2a' });
  await w.attend('u3', 'present');
  await w.attend('u4', 'present');
  return w;
}

describe('cok adayli secim (m.34 / m.41)', () => {
  it('aday yalnizca yonetici / denetci seciminde; ayni aday iki kez yok; aday kisisi apartmanda olmali; adaylar cagri ozetine girer', async () => {
    const w = setup({ now: T0 });
    for (const bad of [
      { title: 'X', decisionKind: 'general', candidates: ['A B'] },
      { title: 'X', decisionKind: 'manager_election', candidates: [] },
      { title: 'X', decisionKind: 'manager_election', candidates: ['Ali Veli', 'ali veli'] },
      { title: 'X', decisionKind: 'manager_election', candidates: [{ name: 'Yok Kişi', userId: 'nobody' }] },
    ]) {
      expect((await w.call('POST', '', { ...meeting, agenda: [bad] })).status).toBe(400);
    }
    const ok = await w.call('POST', '', election);
    expect(ok.body.agenda[0]).toMatchObject({ decisionKind: 'manager_election', majority: 'persons_and_land', candidates: [{ candidateId: 'c1', name: 'Ali Veli' }, { candidateId: 'c2', name: 'Ayşe Kaya' }] });
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.create', details: { electionItems: 2 } });
    expect(JSON.stringify(w.audits.at(-1))).not.toContain('Ali Veli');
  });

  it('kazanan: butun kat maliklerinin kisi VE arsa payi cogunlugu; tek pusula kurali; secim kaydi degismez', async () => {
    const w = await electionMeeting();
    expect((await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), votes: { u1: 'yes' } })).status).toBe(400);
    expect((await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c9' } })).status).toBe(400);
    expect((await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'yes' } })).status).toBe(400);
    const r = await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c1', u2: 'c1', u3: 'c2', u4: 'c1' } });
    expect(r.status).toBe(200);
    const e = r.body.decision.election;
    expect(e).toMatchObject({ rule: 'persons_and_land', winnerCandidateId: 'c1', totalPersons: 4, required: { persons: 3 } });
    expect(e.candidates).toMatchObject([
      { candidateId: 'c1', name: 'Ali Veli', persons: 3, units: 3, votes: 3, landShareBps: 9000, elected: true },
      { candidateId: 'c2', name: 'Ayşe Kaya', persons: 1, units: 1, votes: 1, landShareBps: 1000, elected: false },
    ]);
    expect(r.body.decision.outcome).toMatchObject({ decision: 'accepted' });
    expect(r.body.assembly.agenda[0].tally).toMatchObject({ decision: 'accepted', winnerCandidateId: 'c1', seq: 1 });
    expect(r.body.decision.unitBallots).toEqual({ u1: 'c1', u2: 'c1', u3: 'c2', u4: 'c1' });
    expect(w.audits.at(-1)).toMatchObject({ action: 'assembly.tally', details: { election: { candidates: 2, winnerCandidateId: 'c1' }, votesHash: expect.any(String) } });
    // Degismez: ikinci kayit yalnizca gerekceli duzeltme.
    expect((await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c2' } })).status).toBe(409);
  });

  it('hicbir aday cogunluga ulasmazsa "secim yapilamadi" (nispi cogunluk yok); arsa payi tek basina yetmez', async () => {
    const w = await electionMeeting();
    // c2: arsa payi 800/1000 ama 2/4 kisi (yaridan fazla degil); c1: 2 kisi, 200/1000.
    const r = await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c1', u2: 'c1', u3: 'c2', u4: 'c2' } });
    const e = r.body.decision.election;
    expect(e.winnerCandidateId).toBeNull();
    expect(e.noWinner).toContain('Seçim yapılamadı');
    expect(e.noWinner).toContain('sulh mahkemesinden');
    expect(r.body.decision.outcome.decision).toBe('rejected');
    expect(r.body.decision.outcome.reasons[0]).toContain('Seçim yapılamadı');
    expect(r.body.assembly.agenda[0].tally).toMatchObject({ decision: 'rejected', winnerCandidateId: null });
    // Gerekceli duzeltme yeni kayit; karar defteri ikisini de tasir.
    const fix = await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c2', u2: 'c2', u3: 'c2', u4: 'c2' }, correctionReason: 'Pusula sayımı hatalı' });
    expect(fix.body.decision).toMatchObject({ seq: 2, supersedes: 1, election: { winnerCandidateId: 'c2' } });
    const decisions = [...w.extra.values()].filter((x): x is AssemblyDecision => x.entityType === 'ASSEMBLY_DECISION');
    const book = decisionBookReport({ apartmentName: 'Lale', assemblies: [w.docs.get(`${APT}|asm1`)!], decisions });
    const cells = book.sections[0]!.rows.map((row) => row.cells.join(' | '));
    expect(cells.some((c) => c.includes('SEÇİM YAPILAMADI'))).toBe(true);
    expect(cells.some((c) => c.includes('SEÇİLDİ: Ayşe Kaya'))).toBe(true);
  });

  it('ayni kisinin bolumleri ayni adaya; denetci adayi kat maliki degilse uyari (m.41); tutanak PDF uretilir; sakin portali sonucu gorur', async () => {
    const units = [unit('u1', '1', ls(100)), unit('u2', '2', ls(100)), unit('u3', '3', ls(100)), unit('u4', '4', ls(700))];
    const members = [owner('own-1', 'u1'), owner('own-1', 'u2'), owner('own-3', 'u3'), owner('own-4', 'u4')];
    const w = setup({ units, members });
    await w.call('POST', '', election);
    for (const u of ['u1', 'u2', 'u3', 'u4']) await w.attend(u, 'present');
    const split = await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c1', u2: 'c2', u3: 'c1', u4: 'c1' } });
    expect(split.status).toBe(400);
    expect(split.body.message).toContain('aynı adayı');
    await w.call('POST', '/asm1/agenda/a1/tally', { version: w.version(), ballots: { u1: 'c1', u2: 'c1', u3: 'c2', u4: 'c1' } });
    const aud = await w.call('POST', '/asm1/agenda/a2/tally', { version: w.version(), ballots: { u1: 'c2', u2: 'c2', u3: 'abstain', u4: 'c2' } });
    expect(aud.body.decision.election).toMatchObject({ winnerCandidateId: 'c2', abstain: { units: 1, persons: 1 } });
    expect(aud.body.decision.election.warnings.join(' ')).toContain('KMK m.41');
    expect(aud.body.decision.election.warnings.join(' ')).toContain('Dış Denetçi');
    expect(aud.body.decision.election.warnings.join(' ')).not.toContain('Mehmet Demir');
    expect((await w.call('GET', '/asm1/minutes')).status).toBe(200);
    // Tutanak icerigi: yonetim tam, sakin portali secilmeyen adayi "Aday N" ile.
    const decisions = [...w.extra.values()].filter((x): x is AssemblyDecision => x.entityType === 'ASSEMBLY_DECISION');
    const q = { met: true } as never;
    const full = JSON.stringify(minutesReport({ apartmentName: 'Lale', assembly: w.docs.get(`${APT}|asm1`)!, quorum: q, decisions, preview: false }));
    const anon = JSON.stringify(minutesReport({ apartmentName: 'Lale', assembly: w.docs.get(`${APT}|asm1`)!, quorum: q, decisions, preview: false, anonymizeLosers: true }));
    expect(full).toContain('Ayşe Kaya');
    expect(full).toContain('Mehmet Demir');
    expect(anon).not.toContain('Ayşe Kaya');
    expect(anon).not.toContain('Mehmet Demir');
    expect(anon).toContain('Ali Veli');
    expect(anon).toContain('Aday 2');
    await w.call('PUT', '/asm1/minutes', { version: w.version(), chair: 'Ayşe Yılmaz', clerks: ['Mehmet Kaya'] });
    await w.call('POST', '/asm1/finalize', { version: w.version() });
    const p = await w.portal('/asm1', w.token('own-3', 'resident'));
    // KVKK: portalda yalnizca secilenin adi (m.34 son fikra: zaten asilir); digeri sira etiketiyle.
    expect(p.body.agenda[0]).toMatchObject({ candidateCount: 2, decision: { decision: 'accepted', election: { winnerName: 'Ali Veli', candidates: [{ name: 'Ali Veli', elected: true }, { name: 'Aday 2', elected: false }] } } });
    expect(JSON.stringify(p.body)).not.toContain('own-');
    expect(JSON.stringify(p.body)).not.toContain('Ayşe Kaya');
    expect(JSON.stringify(p.body)).not.toContain('Mehmet Demir');
    // Sakin tutanak PDF'i yonetiminkinden ayri (anonim) dosya.
    const residentPdf = await w.portal('/asm1/minutes', w.token('own-3', 'resident'));
    expect(residentPdf.status).toBe(200);
    expect(residentPdf.body.url).not.toBe((await w.call('GET', '/asm1/minutes')).body.url);
  });
});

describe('yasal cagri teslim takibi (m.29)', () => {
  /** Olaganustu toplanti 15.12.2026: guvenli son teslim gunu 29.11.2026 (tebligat gunu sayilmaz); 27.11 itibariyla 2 gun kaldi. */
  async function extraordinary() {
    const w = setup({ now: T0 });
    await w.call('POST', '', { ...meeting, kind: 'extraordinary' });
    return w;
  }

  it('malik basina rapor (hisseli bolumde her paydas), son gun ve riskte uyarisi; e-posta bilgilendirme tebligat sayilmaz', async () => {
    const w = await extraordinary();
    const r0 = (await w.call('GET', '/asm1/service')).body;
    expect(r0).toMatchObject({ deadline: '2026-11-29', deadlineLenient: '2026-11-30', daysToDeadline: 2, rollFrozen: false, summary: { owners: 5, served: 0, unserved: 5, none: 5 } });
    expect(r0.rows.map((x: any) => x.ownerId).sort()).toEqual(['own-1', 'own-2a', 'own-2b', 'own-3', 'own-4']);
    expect(r0.rows.find((x: any) => x.ownerId === 'own-2a')).toMatchObject({ name: 'Kişi own-2a', units: [{ unitId: 'u2' }], state: 'none', version: 0 });
    expect(r0.warnings.join(' ')).toContain('KMK m.29/2 süresi riskte: 5 kat malikine en geç 2026-11-29');
    expect(r0.warnings.join(' ')).toContain('tebligat günü sayılırsa son gün 2026-11-30');

    const a = await w.call('POST', '/asm1/service/own-1', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' });
    expect(a.status).toBe(201);
    expect(a.body.record.attempts[0]).toMatchObject({ seq: 1, method: 'hand_signed', status: 'delivered', statusOn: '2026-11-26' });
    expect(a.body.record.attempts[0]).not.toHaveProperty('history');
    expect((await w.call('POST', '/asm1/service/own-3', { version: 0, method: 'registered_mail', sentOn: '2026-11-27' })).status).toBe(400);
    await w.call('POST', '/asm1/service/own-3', { version: 0, method: 'registered_mail', sentOn: '2026-11-27', referenceNo: 'RR123456789TR' });
    await w.call('POST', '/asm1/service/own-4', { version: 0, method: 'email_info', sentOn: '2026-11-27' });
    const upd = await w.call('PATCH', '/asm1/service/own-3/1', { version: 1, status: 'returned', statusOn: '2026-11-27', note: 'Adreste bulunamadı' });
    expect(upd.body.record.attempts[0]).toMatchObject({ status: 'returned', statusOn: '2026-11-27' });
    // Sonuclanmis deneme degismez; hatali giris gerekceli iptal.
    expect((await w.call('PATCH', '/asm1/service/own-3/1', { version: 2, status: 'delivered', statusOn: '2026-11-27' })).status).toBe(409);

    const r1 = (await w.call('GET', '/asm1/service')).body;
    expect(r1.summary).toMatchObject({ owners: 5, served: 1, returned: 1, none: 3, unserved: 4 });
    const unserved = (await w.call('GET', '/asm1/service?filter=unserved')).body.rows.map((x: any) => [x.ownerId, x.state]);
    expect(unserved.sort()).toEqual([['own-2a', 'none'], ['own-2b', 'none'], ['own-3', 'returned'], ['own-4', 'none']]);

    const v = await w.call('PATCH', '/asm1/service/own-1/1', { version: 1, void: true, reason: 'Yanlış kişiye imzalatıldı' });
    expect(v.body.record.attempts[0]).toMatchObject({ voidedBy: 'mgr-1', voidReason: 'Yanlış kişiye imzalatıldı' });
    expect((await w.call('GET', '/asm1/service')).body.summary.served).toBe(0);
    expect(w.audits.map((x) => x.action).filter((x) => x.startsWith('assembly.service'))).toEqual(['assembly.service', 'assembly.service', 'assembly.service', 'assembly.service_update', 'assembly.service_void']);
    const auditText = JSON.stringify(w.audits);
    expect(auditText).not.toContain('RR123456789TR');
    expect(auditText).not.toContain('Adreste');
  });

  it('sure gectikten sonra yapilan tebligat "gec" sayilir ve uyari verir; olagan toplantida yonetim plani notu', async () => {
    const w = await extraordinary();
    w.clock.set('2026-12-02T09:00:00.000Z');
    await w.call('POST', '/asm1/service/own-1', { version: 0, method: 'hand_signed', sentOn: '2026-12-01' });
    const r = (await w.call('GET', '/asm1/service')).body;
    expect(r.rows.find((x: any) => x.ownerId === 'own-1')).toMatchObject({ state: 'served_late', servedOn: '2026-12-01' });
    expect(r.warnings.join(' ')).toContain('KMK m.29/2 süresi geçti: 4 kat malikine');
    expect(r.warnings.join(' ')).toContain('1 kat malikine çağrı 15 günlük süre geçtikten sonra');
    const ord = setup({ now: T0 });
    await ord.call('POST', '', meeting);
    expect((await ord.call('GET', '/asm1/service')).body.warnings[0]).toContain('KMK m.29/1');
  });

  it('zamanlilik teslim tarihiyle: zamaninda postalanip gec teslim edilen ayri durum; guvenli son gun teslimi zamaninda', async () => {
    const w = await extraordinary();
    w.clock.set('2026-12-03T09:00:00.000Z');
    // Zamaninda postalandi (27.11 <= 29.11), 1.12'de teslim: gec teslim.
    await w.call('POST', '/asm1/service/own-3', { version: 0, method: 'registered_mail', sentOn: '2026-11-27', referenceNo: 'RR1' });
    await w.call('PATCH', '/asm1/service/own-3/1', { version: 1, status: 'delivered', statusOn: '2026-12-01' });
    // Son gun (29.11) teslim: zamaninda; 30.11 teslim yalnizca tebligat gunu sayilirsa zamaninda -> gec teslim.
    await w.call('POST', '/asm1/service/own-1', { version: 0, method: 'registered_mail', sentOn: '2026-11-26', referenceNo: 'RR2', status: 'delivered', statusOn: '2026-11-29' });
    await w.call('POST', '/asm1/service/own-4', { version: 0, method: 'hand_signed', sentOn: '2026-11-30' });
    const r = (await w.call('GET', '/asm1/service')).body;
    const state = (id: string) => r.rows.find((x: any) => x.ownerId === id);
    expect(state('own-3')).toMatchObject({ state: 'late_delivery', servedOn: '2026-12-01' });
    expect(state('own-1')).toMatchObject({ state: 'served', servedOn: '2026-11-29' });
    expect(state('own-4')).toMatchObject({ state: 'served_late', servedOn: '2026-11-30' });
    expect(r.summary).toMatchObject({ served: 1, lateDelivery: 1, servedLate: 1, unserved: 2 });
    expect(r.warnings.join(' ')).toContain('zamanında postalandı ancak 2026-11-29 tarihinden sonra teslim edildi');
  });

  it('erteleme sonrasi onceki tarih icin yapilan tebligat eskir (durum hesabina girmez, uyari)', async () => {
    const w = await extraordinary();
    await w.call('POST', '/asm1/service/own-1', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' });
    expect((await w.call('GET', '/asm1/service')).body.rows.find((x: any) => x.ownerId === 'own-1').state).toBe('served');
    await w.call('POST', '/asm1/call', { version: w.version() });
    await w.call('POST', '/asm1/reschedule', { version: w.version(), scheduledAt: '2027-01-10T19:00:00+03:00', reason: 'Tebligat yetişmedi' });
    const r = (await w.call('GET', '/asm1/service')).body;
    const own1 = r.rows.find((x: any) => x.ownerId === 'own-1');
    expect(own1).toMatchObject({ state: 'none', attempts: [{ seq: 1, stale: true, meetingAt: '2026-12-15T16:00:00.000Z', rescheduleSeq: 0 }] });
    expect(r.summary).toMatchObject({ staleAttempts: 1, served: 0 });
    expect(r.deadline).toBe('2026-12-25');
    expect(r.warnings.join(' ')).toContain('önceki tarih için kaydedilen 1 teslim denemesi');
    // Yeni tarih icin yeni deneme gecerli.
    const again = await w.call('POST', '/asm1/service/own-1', { version: 1, method: 'hand_signed', sentOn: '2026-11-27' });
    expect(again.body.record.attempts.map((x: any) => [x.seq, x.rescheduleSeq, x.stale ?? false])).toEqual([[1, 0, true], [2, 1, false]]);
    expect((await w.call('GET', '/asm1/service')).body.rows.find((x: any) => x.ownerId === 'own-1').state).toBe('served');
  });

  it('kurallar: surum, oy listesi disi kisi, gelecek tarih, iptal edilen toplanti, denetci yazamaz, tenant izolasyonu', async () => {
    const w = await extraordinary();
    await w.call('POST', '/asm1/service/own-1', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' });
    expect((await w.call('POST', '/asm1/service/own-1', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' })).status).toBe(409);
    expect((await w.call('POST', '/asm1/service/stranger', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' })).status).toBe(404);
    expect((await w.call('POST', '/asm1/service/own-2a', { version: 0, method: 'hand_signed', sentOn: '2026-11-28' })).status).toBe(400);
    expect((await w.call('POST', '/asm1/service/own-2a', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' }, w.token('obs', 'observer'))).status).toBe(403);
    expect((await w.call('GET', '/asm1/service', undefined, w.token('obs', 'observer'))).status).toBe(200);
    expect((await w.call('GET', '/asm1/service', undefined, w.token('mgr-2', 'apartment_manager', 'apt-2'))).status).toBe(404);
    await w.call('POST', '/asm1/cancel', { version: w.version(), reason: 'Gerek kalmadı' });
    expect((await w.call('POST', '/asm1/service/own-2a', { version: 0, method: 'hand_signed', sentOn: '2026-11-26' })).status).toBe(409);
  });
});
