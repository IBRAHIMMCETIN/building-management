/**
 * Ihale bildirimleri: yayin / karar / yayindan sonra iptal ve yonetim yaniti outbox olaylari
 * (yalnizca kimlik), worker alicilari (guncel uyeler, yanitlanan acik sorularin yazarlari), bayat
 * olayin elenmesi, kiraci izolasyonu, `tenders` tercih kategorisi ve e-posta sablonlari.
 */
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { type DomainEvent, buildEvent } from '../src/events/publisher.js';
import { createTenderRepository } from '../src/modules/tenders/repository.js';
import { categoryOfEvent, categoryOfTemplate } from '../src/modules/notifications/categories.js';
import { createEmailNotifier } from '../src/modules/notifications/email.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import { CATEGORY_ATTRIBUTES, parsePreferences } from '../src/modules/notifications/preferences.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import type { Person } from '../src/modules/residents/repository.js';
import { type TenderContext, createTenderService } from '../src/modules/tenders/service.js';
import { type SqsEvent, buildNotifications, createNotificationWorker } from '../src/workers/notification-worker.js';
import { createFakeTenderRepo } from './fakes/tenderRepo.js';

const APT = 'apt-1';
const T0 = '2026-11-27T07:00:00.000Z';
const DAY = '2026-11-27';

const ctx = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  a: { apartmentId: APT, userId: 'res-a', role: 'resident' },
  b: { apartmentId: APT, userId: 'res-b', role: 'resident' },
  c: { apartmentId: APT, userId: 'res-c', role: 'resident' },
} satisfies Record<string, TenderContext>;

const member = (userId: string, unitId: string, extra: Partial<UnitMembership> = {}) =>
  ({ userId, unitId, apartmentId: APT, relation: 'owner', residesInUnit: true, status: 'active', startDate: '2026-01-01', ...extra }) as unknown as UnitMembership;

function world() {
  const fake = createFakeTenderRepo();
  let now = new Date(T0);
  let n = 0;
  const memberships: UnitMembership[] = [
    member('res-a', 'u1'),
    member('res-a', 'u4', { relation: 'tenant' }),
    member('res-b', 'u2'),
    member('res-c', 'u3'),
    member('res-old', 'u5', { status: 'inactive', endDate: '2026-10-01' }),
    member('mgr', 'u6'),
    member('other-apt', 'x1', { apartmentId: 'apt-2' }),
  ];
  const service = createTenderService({
    repo: fake.repo,
    documents: {
      promote: async (apt, upload, target) => ({ key: `apartments/${apt}/tenders/${target.tenderId}/quotes/${target.quoteId}/${upload.uploadId}.pdf`, fileName: upload.fileName, contentType: 'application/pdf', size: 1000 }),
      sign: async () => ({ url: 'https://s3.example/x', fileName: 'a.pdf', contentType: 'application/pdf', expiresAt: T0 }),
    },
    tickets: { get: async () => undefined },
    memberships: { listMemberships: async (apt, userId) => memberships.filter((m) => m.apartmentId === apt && m.userId === userId) },
    now: () => now,
    newId: () => String(++n).padStart(10, '0'),
  });
  let k = 0;
  const key = () => `key-${++k}`;
  const tick = (minutes = 1) => (now = new Date(now.getTime() + minutes * 60_000));
  /** Yayindaki ihale: 2 teklif (belgeli), asgari 3 -> eksik teklif gerekcesiyle. */
  async function published(title = 'Dış cephe mantolama') {
    const created = await service.create(ctx.mgr, { idempotencyKey: key(), title, description: 'A ve B blok dış cephe mantolama işi', category: 'mantolama', deadline: '2026-12-15' });
    let t = (await service.collect(ctx.mgr, created.tender.tenderId, { version: created.tender.version })).tender;
    for (const [supplier, amount] of [['Yalıtım A.Ş.', 100_000_00], ['Cephe Ltd.', 90_000_00]] as const) {
      t = (await service.addQuote(ctx.mgr, t.tenderId, { idempotencyKey: key(), supplierName: supplier, amountKurus: amount, vatIncluded: false, vatRate: 20, document: { uploadId: `up-${key()}`, fileName: 'teklif.pdf' } })).tender;
    }
    tick();
    t = (await service.publish(ctx.mgr, t.tenderId, { version: t.version, shortfallReason: 'Üçüncü firma teklif vermedi' })).tender;
    return t;
  }
  const comment = async (who: TenderContext, tenderId: string, body: string) => {
    tick();
    return service.comment(who, tenderId, { idempotencyKey: key(), body });
  };
  const sent: Notification[] = [];
  const processed = new Set<string>();
  const worker = createNotificationWorker({
    memberships: { list: async (apt) => memberships.filter((m) => m.apartmentId === apt) },
    core: { listUnits: async () => [] },
    tenders: { get: fake.repo.get, listComments: fake.repo.listComments },
    notifier: { channel: 'test', send: async (x) => void sent.push(x) },
    isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
    markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
    now: () => now,
    log: { info: () => {}, error: () => {} },
  });
  const deliver = async (...events: DomainEvent[]) => {
    const before = sent.length;
    const res = await worker({ Records: events.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) } satisfies SqsEvent);
    expect(res.batchItemFailures).toEqual([]);
    return sent.slice(before);
  };
  const lastEvent = (type: DomainEvent['type']) => [...fake.outbox].reverse().find((e) => e.type === type) as DomainEvent;
  return { fake, service, memberships, published, comment, deliver, lastEvent, sent, tick, key };
}

const users = (ns: readonly Notification[]) => ns.map((x) => x.userId).sort();

describe('ihale olaylari (outbox)', () => {
  it('yayin, karar ve yonetim yaniti ayni atomik yazimda; payload yalnizca kimlik; sakin sorusu olay uretmez', async () => {
    const w = world();
    const t = await w.published();
    const pub = w.lastEvent('TENDER_PUBLISHED');
    expect(pub).toMatchObject({ eventId: `TENDER_PUBLISHED:${t.tenderId}`, apartmentId: APT, actorId: 'mgr', payload: { tenderId: t.tenderId } });
    expect(Object.keys(pub.payload)).toEqual(['tenderId']);
    // Olay, ihale yazimiyla ayni yazimda (ayri yazim yok).
    expect(w.fake.writes.find((wr) => wr.outbox?.length)?.tender?.item.status).toBe('published');

    const asked = await w.comment(ctx.a, t.tenderId, 'Garanti süresi kaç yıl?');
    expect(w.fake.outbox.filter((e) => e.type === 'TENDER_REPLIED')).toHaveLength(0);
    const replied = await w.comment(ctx.mgr, t.tenderId, 'Her iki firma da 10 yıl garanti veriyor.');
    const reply = replied.tender.comments.at(-1);
    const ev = w.lastEvent('TENDER_REPLIED');
    expect(ev).toMatchObject({ eventId: `TENDER_REPLIED:${t.tenderId}:${reply?.commentId}`, payload: { tenderId: t.tenderId, commentId: reply?.commentId } });
    expect(JSON.stringify(ev)).not.toContain('garanti');
    expect(asked.tender.comments).toHaveLength(1);

    const cur = (await w.service.get(ctx.mgr, t.tenderId)).tender;
    await w.service.decide(ctx.mgr, t.tenderId, { version: cur.version, quoteId: cur.quotes[1]?.quoteId, reason: 'En düşük teklif ve aynı garanti' });
    expect(w.lastEvent('TENDER_DECIDED')).toMatchObject({ eventId: `TENDER_DECIDED:${t.tenderId}`, payload: { tenderId: t.tenderId } });
    expect(w.fake.outbox.map((e) => e.type)).toEqual(['TENDER_PUBLISHED', 'TENDER_REPLIED', 'TENDER_DECIDED']);
  });

  it('iptal: yalnizca yayindan sonra olay; taslak / teklif toplamada iptal sakine gitmez', async () => {
    const w = world();
    const draft = await w.service.create(ctx.mgr, { idempotencyKey: w.key(), title: 'Asansör revizyonu', description: 'Asansör kabin ve motor revizyonu', category: 'asansor', deadline: '2026-12-15' });
    await w.service.cancel(ctx.mgr, draft.tender.tenderId, { version: draft.tender.version, reason: 'Bütçe onaylanmadı' });
    expect(w.fake.outbox).toEqual([]);
    const t = await w.published();
    await w.service.cancel(ctx.mgr, t.tenderId, { version: t.version, reason: 'Genel kurul işi erteledi' });
    expect(w.fake.outbox.map((e) => e.eventId)).toEqual([`TENDER_PUBLISHED:${t.tenderId}`, `TENDER_CANCELLED:${t.tenderId}`]);
  });
});

describe('ihale bildirimleri (worker)', () => {
  it('yayin ve karar: apartmanin guncel uyeleri (kullanici basina bir kez); eski uye ve baska apartman almaz', async () => {
    const w = world();
    const t = await w.published();
    const pub = await w.deliver(w.lastEvent('TENDER_PUBLISHED'));
    expect(users(pub)).toEqual(['mgr', 'res-a', 'res-b', 'res-c']);
    expect(pub[0]).toMatchObject({ template: 'tender_published', category: 'tenders', data: { tenderId: t.tenderId, title: 'Dış cephe mantolama', quoteCount: 2, lowestTotalKurus: 108_000_00, shortfall: 'true' } });
    const cur = (await w.service.get(ctx.mgr, t.tenderId)).tender;
    await w.service.decide(ctx.mgr, t.tenderId, { version: cur.version, quoteId: cur.quotes[1]?.quoteId, reason: 'En düşük teklif', reference: 'KD-2026/14' });
    const dec = await w.deliver(w.lastEvent('TENDER_DECIDED'));
    expect(users(dec)).toEqual(['mgr', 'res-a', 'res-b', 'res-c']);
    expect(dec[0]).toMatchObject({ template: 'tender_decided', category: 'tenders', data: { supplierName: 'Cephe Ltd.', totalKurus: 108_000_00, reason: 'En düşük teklif', reference: 'KD-2026/14' } });
    // Ayni olay tekrar teslim edilirse (SQS en az bir kez) islenmez.
    expect(await w.deliver(w.lastEvent('TENDER_DECIDED'))).toEqual([]);
  });

  it('bayat olay elenir: yayin e-postasi islenirken ihale iptal edilmisse gitmez; iptal e-postasi gider', async () => {
    const w = world();
    const t = await w.published();
    const pub = w.lastEvent('TENDER_PUBLISHED');
    await w.service.cancel(ctx.mgr, t.tenderId, { version: t.version, reason: 'Genel kurul işi erteledi' });
    expect(await w.deliver(pub)).toEqual([]);
    const cancelled = await w.deliver(w.lastEvent('TENDER_CANCELLED'));
    expect(users(cancelled)).toEqual(['mgr', 'res-a', 'res-b', 'res-c']);
    expect(cancelled[0]).toMatchObject({ template: 'tender_cancelled', data: { reason: 'Genel kurul işi erteledi' } });
    // Karar olayi geldiginde ihale karara bagli degilse (veya kayit yoksa) kimse almaz.
    const fakeDecided = { ...w.lastEvent('TENDER_CANCELLED'), eventId: `TENDER_DECIDED:${t.tenderId}`, type: 'TENDER_DECIDED' } as DomainEvent;
    expect(await w.deliver(fakeDecided)).toEqual([]);
    const missing = { ...fakeDecided, eventId: 'TENDER_DECIDED:yok', payload: { tenderId: 'tnd-yok' } } as DomainEvent;
    expect(await w.deliver(missing)).toEqual([]);
  });

  it('yonetim yaniti: yalnizca yanitlanan acik sorularin yazarlari; tasinan soru sahibi almaz; yanit metni sablona', async () => {
    const w = world();
    const t = await w.published();
    await w.comment(ctx.a, t.tenderId, 'Garanti süresi kaç yıl?');
    await w.comment(ctx.b, t.tenderId, 'İskele ne zaman kurulacak?');
    await w.comment(ctx.a, t.tenderId, 'Bir de boya rengi seçilebilir mi?');
    await w.comment(ctx.mgr, t.tenderId, 'Garanti 10 yıl, iskele Mart ayında kurulacak.');
    const first = await w.deliver(w.lastEvent('TENDER_REPLIED'));
    expect(users(first)).toEqual(['res-a', 'res-b']);
    expect(first[0]).toMatchObject({ template: 'tender_replied', category: 'tenders', data: { tenderId: t.tenderId, reply: 'Garanti 10 yıl, iskele Mart ayında kurulacak.' } });
    expect(JSON.stringify(first[0]?.data)).not.toContain('res-');
    // Sonraki yanit yalnizca o arada sorulanlari kapsar; soran tasindiysa e-posta yok.
    await w.comment(ctx.c, t.tenderId, 'Aidat artacak mı?');
    await w.comment(ctx.b, t.tenderId, 'Çalışma saatleri nedir?');
    await w.comment(ctx.mgr, t.tenderId, 'Aidat artmayacak; çalışma 09-18 arası.');
    for (const m of w.memberships) if (m.userId === 'res-c') Object.assign(m, { status: 'inactive', endDate: '2026-11-20' });
    expect(users(await w.deliver(w.lastEvent('TENDER_REPLIED')))).toEqual(['res-b']);
    // Yonetim yaniti arka arkaya: ikinci yanitta acik soru yok.
    await w.comment(ctx.mgr, t.tenderId, 'Ek: belgeler ihale sayfasında.');
    expect(await w.deliver(w.lastEvent('TENDER_REPLIED'))).toEqual([]);
  });

  it('kiraci izolasyonu: olayin apartmaniyla uyusmayan kayit / uyelik kullanilmaz', () => {
    const tender = { tenderId: 't1', apartmentId: 'apt-2', title: 'X', status: 'published' as const, quotes: [] };
    const event = { eventId: 'TENDER_PUBLISHED:t1', type: 'TENDER_PUBLISHED', version: 1, occurredAt: T0, apartmentId: APT, actorId: 'mgr', groupKey: APT, payload: { tenderId: 't1' } } as DomainEvent;
    const ms = [member('res-a', 'u1'), member('other-apt', 'x1', { apartmentId: 'apt-2' })];
    expect(buildNotifications(event, ms, new Map(), DAY, [], { tender: { tender } })).toEqual([]);
    expect(users(buildNotifications(event, ms, new Map(), DAY, [], { tender: { tender: { ...tender, apartmentId: APT } } }))).toEqual(['res-a']);
    expect(buildNotifications(event, ms, new Map(), DAY, [], { tender: null })).toEqual([]);
  });
});

describe('ihale tercih kategorisi ve e-posta', () => {
  it('olay ve sablon `tenders` kategorisinde; tercih ozniteligi duz (emailTenders); PUT kabul eder', () => {
    for (const type of ['TENDER_PUBLISHED', 'TENDER_DECIDED', 'TENDER_CANCELLED', 'TENDER_REPLIED']) expect(categoryOfEvent(type)).toBe('tenders');
    expect(categoryOfTemplate('tender_replied')).toBe('tenders');
    expect(CATEGORY_ATTRIBUTES.tenders).toBe('emailTenders');
    expect(parsePreferences({ email: { tenders: false } })).toEqual({ email: { tenders: false } });
  });

  it('e-posta kanali: ihale e-postalarini kapatan sakine gitmez, digerine gider; sablon portal baglantisi', async () => {
    const sentMail: { to: string; subject: string; text: string }[] = [];
    const person = (userId: string) => ({ apartmentId: APT, userId, fullName: `Kişi ${userId}`, email: `${userId}@example.com` }) as unknown as Person;
    const prefs: Record<string, { email: { enabled: boolean; tenders?: boolean } }> = { 'res-a': { email: { enabled: true, tenders: false } }, 'res-b': { email: { enabled: true } } };
    const notifier = createEmailNotifier({
      sender: { send: async (m: { to: string; subject: string; text: string }) => (sentMail.push({ to: m.to, subject: m.subject, text: m.text }), { messageId: 'x' }) },
      preferences: { get: async (u: string) => prefs[u] ?? { email: { enabled: true } } },
      people: { get: async (_a: string, u: string) => person(u) },
      core: { getSite: async () => ({ siteId: APT, name: 'Lale Sitesi' }) as never, listUnits: async () => [], listBlocks: async () => [] },
      sentLog: { has: async () => false, record: async () => {} },
      portalUrl: 'https://site.example/app',
      now: () => new Date(T0),
      log: { info: () => {}, error: () => {} },
    } as never);
    const note = (userId: string): Notification => ({ eventId: 'TENDER_DECIDED:t1', apartmentId: APT, userId, template: 'tender_decided', category: 'tenders', data: { tenderId: 't1', title: 'Mantolama', supplierName: 'Cephe Ltd.', totalKurus: 108_000_00, reason: 'En düşük teklif' } });
    expect(await notifier.send(note('res-a'))).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(await notifier.send(note('res-b'))).toEqual({ status: 'sent' });
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({ to: 'res-b@example.com', subject: expect.stringContaining('İhale sonuçlandı: Mantolama') });
    expect(sentMail[0]?.text).toContain('Cephe Ltd.');
    expect(sentMail[0]?.text).toContain('https://site.example/app/ihale/t1');
  });

  it('sablonlar: paylasim, iptal ve yanit metinleri; HTML escape', () => {
    const ctxEmail = { siteName: 'Lale', unitLabel: () => '', portalUrl: 'https://site.example/app' };
    const r = (template: Notification['template'], data: Notification['data']) => renderEmail({ eventId: 'e', apartmentId: APT, userId: 'u', template, data }, ctxEmail);
    const pub = r('tender_published', { tenderId: 't1', title: 'Çatı <onarımı>', quoteCount: 3, lowestTotalKurus: 50_000_00 });
    expect(pub?.subject).toMatch(/^İhale teklifleri paylaşıldı: Çatı <onarımı>/);
    expect(pub?.html).toContain('Çatı &lt;onarımı&gt;');
    expect(pub?.text).toMatch(/Teklif sayısı.*3/);
    expect(r('tender_cancelled', { tenderId: 't1', title: 'Çatı', reason: 'Bütçe yok' })?.text).toContain('Gerekçe: Bütçe yok');
    const replied = r('tender_replied', { tenderId: 't1', title: 'Çatı', reply: 'Garanti 10 yıl.' });
    expect(replied?.subject).toMatch(/^Sorunuz yanıtlandı: Çatı/);
    expect(replied?.text).toContain('Yanıt: Garanti 10 yıl.');
  });
});

describe('ihale deposu outbox yazimi (DynamoDB)', () => {
  it('olay ihale yazimiyla ayni TransactWriteItems icinde OUTBOX# kaydi (attribute_not_exists)', async () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
    ddb.on(TransactWriteCommand).resolves({});
    const event = buildEvent({ eventId: 'TENDER_PUBLISHED:tnd-1', type: 'TENDER_PUBLISHED', apartmentId: APT, actorId: 'mgr', occurredAt: T0, payload: { tenderId: 'tnd-1' } });
    const tender = { PK: `APT#${APT}`, SK: 'TENDER#tnd-1', entityType: 'TENDER', apartmentId: APT, tenderId: 'tnd-1', version: 3 } as never;
    await createTenderRepository().write(APT, { tender: { item: tender, expectedVersion: 2 }, outbox: [event] });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.map((i) => i.Put?.Item?.SK)).toEqual(['TENDER#tnd-1', 'OUTBOX#TENDER_PUBLISHED:tnd-1']);
    expect(items[1]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { status: 'pending', eventType: 'TENDER_PUBLISHED', GSI1PK: 'OUTBOX#PENDING' } });
    ddb.restore();
  });
});
