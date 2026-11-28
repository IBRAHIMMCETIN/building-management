/**
 * Bildirim devami: SES geri donus / sikayet olaylarinin islenmesi ve e-posta engeli.
 *  - SES bildirimi (kimlik: `notificationType`, yapilandirma seti: `eventType`) ayristirma.
 *  - Kayit: hash anahtar, maskeli adres; kalici geri donus / sikayet suresiz, gecici geri donus 7 gun
 *    TTL; gecici geri donus etkin kalici engeli zayiflatmaz; tekrar teslim ayni kayit.
 *  - Bildirim worker girisi SNS kaydini engel isleyicisine, SQS kaydini bildirime yonlendirir.
 *  - E-posta kanali engelli aliciya gondermez (`suppressed`, adres loga yazilmaz).
 *  - Platform API: yalnizca platform_admin (destek oturumu degil), arama govdede, kaldirma denetimli.
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { type EmailMessage, type SentLog, createEmailNotifier } from '../src/modules/notifications/email.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import {
  SOFT_BOUNCE_DAYS,
  createMemorySuppressionStore,
  createSuppressionService,
  emailHash,
  handleSesFeedback,
  isSnsEvent,
  maskEmail,
  parseSesFeedback,
} from '../src/modules/notifications/suppressions.js';
import type { Person } from '../src/modules/residents/repository.js';
import { createWorkerEntry } from '../src/workers/notification-worker.js';

const NOW = new Date('2026-11-28T09:00:00.000Z');
const quiet = { info: () => {}, error: () => {} };

const bounce = (email: string, bounceType = 'Permanent') => ({
  notificationType: 'Bounce',
  bounce: { bounceType, bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull', bouncedRecipients: [{ emailAddress: email }], timestamp: '2026-11-28T08:59:00.000Z', feedbackId: 'fb-1' },
  mail: { messageId: 'ses-1', destination: [email] },
});
const complaint = (email: string) => ({
  eventType: 'Complaint',
  complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: 'abuse', timestamp: '2026-11-28T08:58:00.000Z', feedbackId: 'fb-c' },
  mail: { messageId: 'ses-2' },
});
const TOPIC = 'arn:aws:sns:eu-north-1:1:bm-ses-feedback';
const snsEvent = (...messages: unknown[]) => ({
  Records: messages.map((m, i) => ({ EventSource: 'aws:sns', Sns: { MessageId: `sns-${i}`, TopicArn: TOPIC, Message: typeof m === 'string' ? m : JSON.stringify(m) } })),
});
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

function service(now = () => NOW) {
  const mem = createMemorySuppressionStore();
  return { ...mem, service: createSuppressionService({ store: mem.store, now, log: quiet }) };
}

describe('SES geri bildirim ayristirma', () => {
  it('kalici / gecici geri donus ve sikayet; teslim bildirimi yok sayilir', () => {
    expect(parseSesFeedback(bounce('Ali@Example.com'), NOW)).toEqual([
      { email: 'Ali@Example.com', reason: 'bounce', soft: false, bounceType: 'Permanent', bounceSubType: 'General', feedbackId: 'fb-1', at: '2026-11-28T08:59:00.000Z' },
    ]);
    expect(parseSesFeedback(bounce('b@example.com', 'Transient'), NOW)[0]).toMatchObject({ soft: true, bounceType: 'Transient' });
    expect(parseSesFeedback(bounce('b@example.com', 'Undetermined'), NOW)[0]).toMatchObject({ soft: true });
    expect(parseSesFeedback(complaint('c@example.com'), NOW)).toEqual([expect.objectContaining({ email: 'c@example.com', reason: 'complaint', soft: false, feedbackType: 'abuse' })]);
    expect(parseSesFeedback({ notificationType: 'Delivery', delivery: {} }, NOW)).toEqual([]);
    expect(parseSesFeedback('x', NOW)).toEqual([]);
    expect(maskEmail(' Ayse.Kaya@Ornek.com ')).toBe('a***@ornek.com');
    expect(emailHash('A@B.com ')).toBe(emailHash('a@b.com'));
  });

  it('icerik kaynakli geri donus yok sayilir; tek alicili iletide destination da engellenir', () => {
    for (const sub of ['ContentRejected', 'MessageTooLarge', 'AttachmentRejected']) {
      expect(parseSesFeedback({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bounceSubType: sub, bouncedRecipients: [{ emailAddress: 'a@example.com' }] } }, NOW)).toEqual([]);
    }
    const forwarded = { ...bounce('final@other.com'), mail: { destination: ['Ali@Example.com'] } };
    expect(parseSesFeedback(forwarded, NOW).map((e) => e.email)).toEqual(['final@other.com', 'Ali@Example.com']);
    // Ayni adres veya cok alicili ileti: ek kayit yok.
    expect(parseSesFeedback({ ...bounce('ali@example.com'), mail: { destination: ['ALI@example.com'] } }, NOW)).toHaveLength(1);
    expect(parseSesFeedback({ ...bounce('a@example.com'), mail: { destination: ['x@example.com', 'y@example.com'] } }, NOW)).toHaveLength(1);
    expect(parseSesFeedback({ ...complaint('final@other.com'), mail: { destination: ['ali@example.com'] } }, NOW).map((e) => e.email)).toEqual(['final@other.com', 'ali@example.com']);
  });
});

describe('engel kaydi', () => {
  it('kalici geri donus suresiz; adres saklanmaz (hash + maske); tekrar teslim ayni kayit', async () => {
    const s = service();
    await s.service.record(parseSesFeedback(bounce('ali@example.com'), NOW));
    await s.service.record(parseSesFeedback(bounce('ali@example.com'), NOW));
    expect(s.items.size).toBe(1);
    const item = s.items.get(emailHash('ali@example.com'));
    expect(item).toMatchObject({ PK: 'EMAILSUP', SK: `H#${emailHash('ali@example.com')}`, emailMasked: 'a***@example.com', reason: 'bounce', bounceType: 'Permanent', status: 'active' });
    expect(item?.ttl).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('ali@example.com');
    expect(await s.service.isSuppressed('ALI@example.com')).toBeTruthy();
  });

  it('gecici geri donus: 72 saatte 3. olayda 7 gunluk engel, oncesi yalnizca izlenir; pencere disi sayilmaz', async () => {
    let now = NOW;
    const s = service(() => now);
    const soft = () => s.service.record(parseSesFeedback(bounce('soft@example.com', 'Transient'), now));
    await soft();
    expect(s.items.get(emailHash('soft@example.com'))).toMatchObject({ status: 'observing', softBounces: [NOW.toISOString()] });
    expect(await s.service.isSuppressed('soft@example.com')).toBeUndefined();
    now = hours(80); // ilki pencere disinda kalir
    await soft();
    now = hours(90);
    await soft();
    expect(s.items.get(emailHash('soft@example.com'))).toMatchObject({ status: 'observing' });
    expect(s.items.get(emailHash('soft@example.com'))?.softBounces).toHaveLength(2);
    now = hours(100);
    await soft();
    expect(s.items.get(emailHash('soft@example.com'))).toMatchObject({ status: 'active', ttl: Math.floor(hours(100).getTime() / 1000) + SOFT_BOUNCE_DAYS * 86_400 });
    expect(await s.service.isSuppressed('soft@example.com')).toBeTruthy();
    now = new Date(hours(100).getTime() + (SOFT_BOUNCE_DAYS * 86_400 + 1) * 1000);
    // TTL silmesi gecikse de okuma sureyi kontrol eder.
    expect(await s.service.isSuppressed('soft@example.com')).toBeUndefined();
  });

  it('kalici geri donus / sikayet hemen; gecici geri donus etkin kalici engeli zayiflatmaz', async () => {
    const s = service();
    await s.service.record(parseSesFeedback(complaint('hard@example.com'), NOW));
    expect(await s.service.isSuppressed('hard@example.com')).toBeTruthy();
    expect(await s.service.record(parseSesFeedback(bounce('hard@example.com', 'Transient'), NOW))).toEqual({ recorded: 0, skipped: 1 });
    expect(s.items.get(emailHash('hard@example.com'))).toMatchObject({ reason: 'complaint', status: 'active', version: 1 });
    expect(s.items.get(emailHash('hard@example.com'))?.ttl).toBeUndefined();
  });

  it('yaris: gecici geri donusun yazimi sirasinda kalici engel gelirse yeniden okur ve ustune yazmaz', async () => {
    const s = service();
    const hash = emailHash('race@example.com');
    let injected = false;
    s.hooks.beforeWrite = (item) => {
      // Gecici yazimdan hemen once baska bir isleyici kalici engeli yazdi.
      if (!injected && item.status === 'observing') {
        injected = true;
        s.items.set(hash, { PK: 'EMAILSUP', SK: `H#${hash}`, entityType: 'EMAIL_SUPPRESSION', emailHash: hash, emailMasked: 'r***@example.com', reason: 'bounce', bounceType: 'Permanent', at: NOW.toISOString(), recordedAt: NOW.toISOString(), status: 'active', version: 1 });
      }
    };
    expect(await s.service.record(parseSesFeedback(bounce('race@example.com', 'Transient'), NOW))).toEqual({ recorded: 0, skipped: 1 });
    expect(s.items.get(hash)).toMatchObject({ status: 'active', bounceType: 'Permanent', version: 1 });
    expect(s.items.get(hash)?.ttl).toBeUndefined();
  });

  it('yaris: kaldirma okuduktan sonra yeni kalici geri donus gelirse 409, engel silinmez', async () => {
    const s = service();
    await s.service.record(parseSesFeedback(bounce('ali@example.com', 'Transient'), NOW));
    await s.service.record(parseSesFeedback(bounce('ali@example.com', 'Transient'), NOW));
    await s.service.record(parseSesFeedback(bounce('ali@example.com', 'Transient'), NOW));
    const hash = emailHash('ali@example.com');
    s.hooks.beforeWrite = (item) => {
      if (item.status === 'cleared') {
        s.hooks.beforeWrite = undefined;
        // Arada kalici geri donus islendi (surum artti).
        const cur = s.items.get(hash);
        if (cur) s.items.set(hash, { ...cur, bounceType: 'Permanent', ttl: undefined, version: cur.version + 1 });
      }
    };
    await expect(s.service.clear('p1', hash, { reason: 'Adres düzeltildi' })).rejects.toMatchObject({ httpStatus: 409 });
    expect(await s.service.isSuppressed('ali@example.com')).toBeTruthy();
    expect(s.audits).toEqual([]);
  });

  it('SNS isleyicisi: yalnizca yapilandirilmis topic; bozuk mesaj atlanir; worker girisi SNS / SQS ayrimi', async () => {
    const s = service();
    const out = await handleSesFeedback(snsEvent(bounce('a@example.com'), 'bozuk', { notificationType: 'Delivery' }, complaint('c@example.com')) as never, { service: s.service, topicArn: TOPIC, now: () => NOW, log: quiet });
    expect(out).toEqual({ recorded: 2, skipped: 0, ignored: 2, foreign: 0 });
    // Baska topic veya yapilandirma yok: hicbir sey yazilmaz.
    const other = service();
    expect(await handleSesFeedback(snsEvent(bounce('a@example.com')) as never, { service: other.service, topicArn: 'arn:aws:sns:eu-north-1:1:baska', log: quiet })).toMatchObject({ recorded: 0, foreign: 1 });
    expect(await handleSesFeedback(snsEvent(bounce('a@example.com')) as never, { service: other.service, topicArn: undefined, log: quiet })).toMatchObject({ recorded: 0, foreign: 1 });
    expect(other.items.size).toBe(0);
    expect(isSnsEvent(snsEvent())).toBe(false);
    expect(isSnsEvent(snsEvent(bounce('a@example.com')))).toBe(true);
    expect(isSnsEvent({ Records: [{ messageId: 'm1', body: '{}' }] })).toBe(false);

    const sqs = vi.fn(async () => ({ batchItemFailures: [] }));
    const record = vi.fn(async () => ({ recorded: 1, skipped: 0 }));
    const entry = createWorkerEntry({ sqs, suppressions: { record }, sesFeedbackTopicArn: TOPIC });
    await entry(snsEvent(bounce('x@example.com')) as never);
    expect(record).toHaveBeenCalledTimes(1);
    expect(sqs).not.toHaveBeenCalled();
    await entry({ Records: [{ messageId: 'm1', body: '{}' }] });
    expect(sqs).toHaveBeenCalledTimes(1);
  });

  it('liste: etkin olmayanlar sorguda elenir; sayfa dolana kadar devam eder, bos sayfa + imlec yok', async () => {
    const mem = createMemorySuppressionStore();
    const svc = createSuppressionService({ store: mem.store, now: () => NOW, log: quiet });
    // 5 izlenen (engel degil) + 2 etkin kayit; depo sayfasi 2'ser.
    for (let i = 0; i < 5; i++) await svc.record(parseSesFeedback(bounce(`o${i}@example.com`, 'Transient'), NOW));
    await svc.record(parseSesFeedback(bounce('h1@example.com'), NOW));
    await svc.record(parseSesFeedback(complaint('h2@example.com'), NOW));
    const page = await svc.list({ limit: 2 });
    expect(page.items.map((i) => i.status)).toEqual(['active', 'active']);
    const all = await svc.list({ limit: 100, status: 'all' });
    expect(all.items.filter((i) => i.status === 'observing').map((i) => i.softBounceCount)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('e-posta kanali', () => {
  const APT = 'apt-1';
  const person = (userId: string): Person =>
    ({ PK: `APT#${APT}`, SK: `PERSON#${userId}`, entityType: 'PERSON', apartmentId: APT, userId, fullName: `Kisi ${userId}`, email: `${userId}@example.com` }) as unknown as Person;
  const note = (userId: string): Notification => ({ eventId: 'ev-1', apartmentId: APT, userId, template: 'payment_received', data: { unitId: 'u1', amount: 1000, receiptNumber: 'M-1', paidAt: '2026-11-28' } });

  it('engelli aliciya gonderilmez (suppressed, adres loga yazilmaz); digerlerine gider', async () => {
    const s = service();
    await s.service.record(parseSesFeedback(bounce('user-1@example.com'), NOW));
    const sent: EmailMessage[] = [];
    const sentLog: SentLog = { has: async () => false, record: async () => {} };
    const log = { info: vi.fn(), error: vi.fn() };
    const notifier = createEmailNotifier({
      sender: { send: async (m) => (sent.push(m), { messageId: 'x' }) },
      preferences: { get: async () => ({ email: { enabled: true } }) },
      people: { get: async (_a, u) => person(u) },
      core: {
        getSite: async () => ({ siteId: APT, name: 'Lale Sitesi' }) as Site,
        listUnits: async () => [{ unitId: 'u1', blockId: 'A', number: '5' }] as Unit[],
        listBlocks: async () => [{ blockId: 'A', name: 'A Blok' }] as Block[],
      },
      sentLog,
      suppressions: s.service,
      now: () => NOW,
      log,
    });
    expect(await notifier.send(note('user-1'))).toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(await notifier.send(note('user-2'))).toEqual({ status: 'sent' });
    expect(sent.map((m) => m.to)).toEqual(['user-2@example.com']);
    const lines = log.info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"msg":"email_suppressed"') && l.includes('"reason":"bounce"'))).toBe(true);
    expect(lines.join('\n')).not.toContain('user-1@example.com');
  });
});

describe('platform API: /api/admin/email-suppressions', () => {
  const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${encodeMockToken(claims)}`, 'content-type': 'application/json' });
  const platform = { sub: 'p1', role: 'platform_admin' };

  async function app() {
    const s = service();
    await s.service.record(parseSesFeedback(bounce('ali@example.com'), NOW));
    await s.service.record(parseSesFeedback(complaint('veli@example.com'), NOW));
    const a = createApp({ version: 'test', authenticate: createMockAuthenticator(), identify: createMockIdentityResolver(), mfaPolicy: { mode: 'off', graceDays: 7 }, suppressionService: s.service });
    const call = async (method: string, path: string, claims: Record<string, unknown>, body?: unknown) => {
      const res = await a.request(path, { method, headers: bearer(claims), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : {}, cache: res.headers.get('cache-control') };
    };
    return { s, call };
  }

  it('yalnizca platform_admin; destek oturumu ve apartman rolleri 403', async () => {
    const { call } = await app();
    expect((await call('GET', '/api/admin/email-suppressions', { sub: 'm1', role: 'apartment_manager', apartmentId: 'apt-1' })).status).toBe(403);
    // Destek oturumu apartman baglaminda `observer` rolune iner: platform ekrani kapali.
    expect((await call('GET', '/api/admin/email-suppressions', { sub: 'p1', role: 'observer', apartmentId: 'apt-1' })).status).toBe(403);
    const list = await call('GET', '/api/admin/email-suppressions', platform);
    expect(list.status).toBe(200);
    expect(list.cache).toBe('no-store');
    expect(list.json.items).toHaveLength(2);
    expect(list.json.items[0]).not.toHaveProperty('PK');
    expect(JSON.stringify(list.json)).not.toContain('ali@example.com');
  });

  it('arama govdede; kaldirma gerekceli ve platform denetim zincirine; kaldirilan liste disi', async () => {
    const { s, call } = await app();
    expect((await call('POST', '/api/admin/email-suppressions/lookup', platform, { email: 'gecersiz' })).status).toBe(400);
    const found = await call('POST', '/api/admin/email-suppressions/lookup', platform, { email: 'ALI@example.com' });
    expect(found.json).toMatchObject({ emailHash: emailHash('ali@example.com'), suppression: { reason: 'bounce', emailMasked: 'a***@example.com', active: true } });
    expect((await call('POST', '/api/admin/email-suppressions/lookup', platform, { email: 'yok@example.com' })).json.suppression).toBeNull();

    const hash = found.json.emailHash as string;
    expect((await call('POST', `/api/admin/email-suppressions/${hash}/clear`, platform, { reason: 'kısa' })).status).toBe(400);
    const cleared = await call('POST', `/api/admin/email-suppressions/${hash}/clear`, platform, { reason: 'Adres düzeltildi, kullanıcı doğruladı' });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ status: 'cleared', clearedBy: 'p1', active: false });
    expect(s.audits).toEqual([expect.objectContaining({ action: 'notification_suppression.clear', target: { type: 'email_suppression', id: hash }, actorId: 'p1' })]);
    expect(s.audits[0]?.apartmentId).toBeUndefined();
    expect(await s.service.isSuppressed('ali@example.com')).toBeUndefined();
    expect((await call('POST', `/api/admin/email-suppressions/${hash}/clear`, platform, { reason: 'Adres düzeltildi tekrar' })).status).toBe(409);
    expect((await call('POST', `/api/admin/email-suppressions/${'0'.repeat(64)}/clear`, platform, { reason: 'Adres düzeltildi' })).status).toBe(404);
    expect((await call('GET', '/api/admin/email-suppressions', platform)).json.items).toHaveLength(1);
    expect((await call('GET', '/api/admin/email-suppressions?status=all', platform)).json.items).toHaveLength(2);
    // Kaldirmadan sonra yeni geri donus engeli yeniden etkinlestirir.
    await s.service.record(parseSesFeedback(bounce('ali@example.com'), NOW));
    expect(await s.service.isSuppressed('ali@example.com')).toBeTruthy();
  });
});
