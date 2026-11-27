/**
 * Guvenlik kapisi bildirimleri: kurye kaydi ve misafir girisi olaylari kaydi doguran yazimla AYNI
 * atomik islemde outbox'a yazilir; payload'da kisisel veri (misafir adi, plaka, not, firma, telefon)
 * yoktur; worker alicilari portal gorunurluk kurallariyla cozer (yalnizca bolumde oturan guncel
 * uyeler, tasinan / devir gunu gelen uye haric) ve `eventId` ile idempotent calisir.
 */
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { Unit } from '../src/modules/core/types.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { type Notification, type SqsEvent, buildNotifications, createNotificationWorker } from '../src/workers/notification-worker.js';
import { APT, T0, ctxs, gateWorld } from './fakes/gateWorld.js';

const quiet = { info: () => {}, error: () => {} };
const DAY = '2026-11-27';

const member = (userId: string, unitId: string, relation: 'owner' | 'tenant', over: Partial<UnitMembership> = {}) =>
  ({ userId, unitId, apartmentId: APT, relation, residesInUnit: relation === 'tenant', status: 'active', startDate: '2026-01-01', ...over }) as UnitMembership;

/** gateWorld ile ayni uyelikler + tasinmis kiraci ve devir gunu gelen yeni kiraci. */
const memberships: UnitMembership[] = [
  member('tenant-u1', 'u1', 'tenant'),
  member('owner-u1', 'u1', 'owner'), // dairede oturmuyor: ziyaretci kayitlarini gormez
  member('owner-u2', 'u2', 'owner', { residesInUnit: true }),
  member('old-tenant', 'u1', 'tenant', { status: 'inactive', endDate: '2026-10-31' }),
  member('ended-today-before', 'u1', 'tenant', { endDate: '2026-11-26' }),
  member('other-apt', 'u1', 'tenant', { apartmentId: 'apt-2' }),
];

const outboxEvents = (w: ReturnType<typeof gateWorld>) => w.fake.byPrefix(APT, 'OUTBOX#').map((i) => i.event as DomainEvent);
const sqs = (...events: DomainEvent[]): SqsEvent => ({ Records: events.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) });

function worker(w: ReturnType<typeof gateWorld>, opts: { members?: UnitMembership[]; now?: string } = {}) {
  const sent: Notification[] = [];
  const processed = new Set<string>();
  const handler = createNotificationWorker({
    memberships: { list: async (apt) => (opts.members ?? memberships).filter((m) => m.apartmentId === apt) },
    core: { listUnits: async () => [] as Unit[] },
    roles: { list: async () => [] as ApartmentRole[] },
    gate: w.fake.repo,
    notifier: { channel: 'test', send: async (n) => void sent.push(n) },
    isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
    markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
    now: () => new Date(opts.now ?? '2026-11-27T09:05:00.000Z'),
    log: quiet,
  });
  return { handler, sent };
}

describe('kurye kaydi: outbox', () => {
  it('kurye ve GATE_COURIER_ARRIVED ayni atomik yazimda; payload yalnizca kimlik, bolum ve yanit suresi', async () => {
    const w = gateWorld();
    const { courier } = await w.service.createCourier(ctxs.guard, { idempotencyKey: 'c-1', unitId: 'u1', company: 'Hızlı Kargo', note: 'Ahmet, 0532 111 22 33' });
    const write = w.fake.writes.find((x) => x.puts.some((p) => p.SK.startsWith('GCOUR#')));
    const outbox = write?.puts.filter((p) => p.SK.startsWith('OUTBOX#')) ?? [];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ SK: `OUTBOX#GATE_COURIER_ARRIVED:${courier.courierId}`, status: 'pending', eventType: 'GATE_COURIER_ARRIVED', GSI1PK: 'OUTBOX#PENDING' });
    const event = outbox[0]?.event as DomainEvent;
    expect(event).toMatchObject({ type: 'GATE_COURIER_ARRIVED', apartmentId: APT, actorId: 'guard-1', occurredAt: T0 });
    expect(event.payload).toEqual({ courierId: courier.courierId, unitId: 'u1', respondBy: '2026-11-27T10:00:00.000Z' });
    // KVKK: not (telefon, kurye adi) ve firma olayda yok.
    const json = JSON.stringify(event);
    for (const text of ['Ahmet', '0532', 'Kargo']) expect(json).not.toContain(text);
    // Ayni anahtarla tekrar: ikinci olay yok.
    expect((await w.service.createCourier(ctxs.guard, { idempotencyKey: 'c-1', unitId: 'u1', company: 'Hızlı Kargo', note: 'Ahmet, 0532 111 22 33' })).replayed).toBe(true);
    expect(outboxEvents(w)).toHaveLength(1);
  });

  it('worker: yalnizca bolumde oturan guncel uyeler; oturmayan malik, tasinan, baska daire ve gorevli almaz', async () => {
    const w = gateWorld();
    await w.service.createCourier(ctxs.guard, { idempotencyKey: 'c-1', unitId: 'u1', company: 'Hızlı Kargo' });
    const { handler, sent } = worker(w);
    const res = await handler(sqs(...outboxEvents(w)));
    expect(res.batchItemFailures).toEqual([]);
    expect(sent.map((n) => n.userId)).toEqual(['tenant-u1']);
    // Firma worker'da kurye kaydindan okunur (olayda yok).
    expect(sent[0]).toMatchObject({ template: 'gate_courier_arrived', data: { unitId: 'u1', company: 'Hızlı Kargo', respondBy: '2026-11-27T10:00:00.000Z' } });
    // Tekrar teslim: ikinci bildirim yok (eventId idempotency).
    await handler(sqs(...outboxEvents(w)));
    expect(sent).toHaveLength(1);
  });

  it('devir gunu kuryeden sonra baslayan yeni sakin almaz; once baslayan alir', () => {
    const event = {
      eventId: 'GATE_COURIER_ARRIVED:c1',
      type: 'GATE_COURIER_ARRIVED',
      version: 1,
      occurredAt: T0,
      apartmentId: APT,
      actorId: 'guard-1',
      groupKey: APT,
      payload: { courierId: 'c1', unitId: 'u1', respondBy: '2026-11-27T10:00:00.000Z' },
    } as DomainEvent;
    const members = [
      member('early', 'u1', 'tenant', { startDate: DAY, createdAt: '2026-11-27T06:00:00.000Z' }),
      member('late', 'u1', 'tenant', { startDate: DAY, createdAt: '2026-11-27T09:30:00.000Z' }),
      member('future', 'u1', 'tenant', { startDate: '2026-12-01' }),
    ];
    const out = buildNotifications(event, members, new Map(), DAY, [], { now: new Date(T0), courier: { courierId: 'c1', unitId: 'u1', status: 'waiting' } });
    expect(out.map((n) => n.userId)).toEqual(['early']);
  });

  it('kurye yanitlandi / iptal edildi / yanit suresi doldu: bildirim gitmez', async () => {
    const w = gateWorld();
    const a = (await w.service.createCourier(ctxs.guard, { idempotencyKey: 'c-a', unitId: 'u1' })).courier;
    await w.service.cancelCourier(ctxs.guard, a.courierId, { version: a.version });
    const { handler, sent } = worker(w);
    await handler(sqs(...outboxEvents(w)));
    expect(sent).toEqual([]);

    const w2 = gateWorld();
    await w2.service.createCourier(ctxs.guard, { idempotencyKey: 'c-b', unitId: 'u1' });
    const late = worker(w2, { now: '2026-11-27T10:00:01.000Z' });
    await late.handler(sqs(...outboxEvents(w2)));
    expect(late.sent).toEqual([]);
  });
});

describe('misafir girisi: outbox', () => {
  it('giris kaydi ve GATE_GUEST_ENTERED ayni atomik yazimda; cikis ve tekrar olay uretmez; misafir adi / plaka yok', async () => {
    const w = gateWorld();
    const p = await w.pass(ctxs.tenant, { entryMode: 'multi', validUntil: '2026-11-29', plate: '34 KL 42', note: 'Akşam' });
    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'e-1' });
    const write = w.fake.writes.find((x) => x.puts.some((i) => i.SK.startsWith('GLOG#')));
    const outbox = write?.puts.filter((i) => i.SK.startsWith('OUTBOX#')) ?? [];
    expect(outbox.map((i) => i.SK)).toEqual([`OUTBOX#GATE_GUEST_ENTERED:${p.passId}:1`]);
    const event = outbox[0]?.event as DomainEvent;
    expect(event.payload).toEqual({ passId: p.passId, unitId: 'u1', hostUserId: 'tenant-u1', entryMode: 'multi', entryCount: 1, enteredAt: T0, validUntil: '2026-11-29' });
    const json = JSON.stringify(event);
    for (const text of ['Mehmet', 'Misafir', '34KL42', 'Akşam']) expect(json).not.toContain(text);

    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'e-1' }); // cift dokunma
    await w.service.passExit(ctxs.guard, p.passId, { idempotencyKey: 'x-1' });
    expect(outboxEvents(w)).toHaveLength(1);
    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'e-2' });
    expect(outboxEvents(w).map((e) => e.eventId)).toEqual([`GATE_GUEST_ENTERED:${p.passId}:1`, `GATE_GUEST_ENTERED:${p.passId}:2`]);
  });

  it('worker: yalnizca gecisi olusturan sakin; ayni daireyi paylasan ve tasinmis ev sahibi almaz', async () => {
    const w = gateWorld();
    const p = await w.pass();
    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'e-1' });
    const both = [...memberships, member('roommate', 'u1', 'tenant')];
    const { handler, sent } = worker(w, { members: both });
    await handler(sqs(...outboxEvents(w)));
    expect(sent.map((n) => [n.userId, n.template])).toEqual([['tenant-u1', 'gate_guest_entered']]);
    expect(sent[0]?.data).toEqual({ passId: p.passId, unitId: 'u1', entryMode: 'single', entryCount: 1, enteredAt: T0, validUntil: DAY });

    // Ev sahibi tasindiysa (worker gec isledi) bildirim yok.
    const movedOut = memberships.map((m) => (m.userId === 'tenant-u1' ? { ...m, status: 'inactive', endDate: '2026-11-26' } : m)) as UnitMembership[];
    const later = worker(w, { members: movedOut });
    await later.handler(sqs(...outboxEvents(w)));
    expect(later.sent).toEqual([]);
  });
});

describe('kapi e-posta sablonlari', () => {
  const ctx = { siteName: 'Güneş Sitesi', unitLabel: () => 'A Blok - 5', portalUrl: 'https://site.example/app' };
  const note = (template: Notification['template'], data: Notification['data']): Notification => ({ eventId: 'e', apartmentId: APT, userId: 'u', template, data });

  it('kurye: firma, Istanbul saatiyle son yanit, portal ziyaretci baglantisi; telefon yok', () => {
    const email = renderEmail(note('gate_courier_arrived', { courierId: 'c1', unitId: 'u1', company: 'Hızlı Kargo', respondBy: '2026-11-27T10:00:00.000Z' }), ctx);
    expect(email?.subject).toBe('Kapıda kurye var - A Blok - 5 - Güneş Sitesi');
    expect(email?.text).toContain('Hızlı Kargo kuryesi');
    expect(email?.text).toContain('Yanıt için son saat: 13:00');
    expect(email?.text).toContain('https://site.example/app/ziyaretci');
    const generic = renderEmail(note('gate_courier_arrived', { courierId: 'c1', unitId: 'u1', respondBy: '2026-11-27T10:00:00.000Z' }), ctx);
    expect(generic?.text).toContain('bir kurye kaydetti');
    expect(generic?.text).not.toContain('Firma');
  });

  it('misafir girisi: giris ani, gecis turu ve gecerlilik; misafir adi yok', () => {
    const single = renderEmail(note('gate_guest_entered', { passId: 'p1', unitId: 'u1', entryMode: 'single', entryCount: 1, enteredAt: T0, validUntil: DAY }), ctx);
    expect(single?.subject).toBe('Misafiriniz giriş yaptı - A Blok - 5 - Güneş Sitesi');
    expect(single?.text).toContain('Giriş: 27.11.2026 12:00');
    expect(single?.text).toContain('Geçiş türü: Tek girişlik');
    expect(single?.text).toContain('Geçerlilik sonu: 27.11.2026');
    const multi = renderEmail(note('gate_guest_entered', { passId: 'p1', unitId: 'u1', entryMode: 'multi', entryCount: 3, enteredAt: T0, validUntil: '2026-11-29' }), ctx);
    expect(multi?.text).toContain('Çok girişli (3. giriş)');
    expect(multi?.text).toContain('geçişi portaldan iptal edin');
  });
});
