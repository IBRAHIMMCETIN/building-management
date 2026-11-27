import {
  AccountSuspendedException,
  BadRequestException,
  MessageRejected,
  SESv2Client,
  SendEmailCommand,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { buildEvent } from '../src/events/publisher.js';
import { type Block, type Site, type Unit, toKurus } from '../src/modules/core/types.js';
import {
  DEFAULT_FROM_ADDRESS,
  type EmailMessage,
  PermanentEmailError,
  type SentLog,
  createEmailNotifier,
  createNotifierFromEnv,
  createSesEmailSender,
  encodeFromAddress,
} from '../src/modules/notifications/email.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import {
  type PreferencesRepository,
  createDynamoPreferencesRepository,
  createPreferencesService,
  parsePreferences,
} from '../src/modules/notifications/preferences.js';
import { cleanSubject, durationText, escapeHtml, formatDate, formatDateTime, formatPeriod, formatTL, renderEmail, safeUrl } from '../src/modules/notifications/templates.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import type { Person } from '../src/modules/residents/repository.js';
import { createNotificationWorker } from '../src/workers/notification-worker.js';
import { createFakePreferencesRepo } from './fakes/preferencesRepo.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const quiet = { info: vi.fn(), error: vi.fn() };
const ts = NOW.toISOString();
const audit = { createdAt: ts, createdBy: 's', updatedAt: ts, updatedBy: 's', version: 1 };

const XSS = '<script>alert("x")</script> & \'Çiçek\'';

const ctx = (over = {}) => ({
  siteName: 'Lale <Sitesi>',
  recipientName: 'Ayşe <b>Yılmaz</b>',
  unitLabel: (id: string) => (id === 'u1' ? 'A Blok - 5' : id === 'u2' ? 'B Blok - 12' : 'Bağımsız bölüm'),
  portalUrl: 'https://site.example/app',
  ...over,
});

const note = (template: Notification['template'], data: Notification['data']): Notification => ({
  eventId: 'E1',
  apartmentId: APT,
  userId: 'user-1',
  template,
  data,
});

// ---------------------------------------------------------------------------
// Bicimlendirme ve sablonlar
// ---------------------------------------------------------------------------

describe('sablon yardimcilari', () => {
  it('kurus -> Turk lirasi (tam sayi aritmetigi), tarih ve donem', () => {
    expect(formatTL(150050)).toBe('1.500,50 TL');
    expect(formatTL(5)).toBe('0,05 TL');
    expect(formatTL(123456789)).toBe('1.234.567,89 TL');
    expect(() => formatTL(1.5)).toThrow();
    expect(formatDate('2026-11-15')).toBe('15.11.2026');
    expect(formatPeriod('2026-10')).toBe('Ekim 2026');
    expect(formatPeriod('2026-02')).toBe('Şubat 2026');
  });

  it('Istanbul saatiyle tarih-saat (genel kurul / oylama / kapi): 15.12.2026 19:00, gece yarisi 00:05; sure metni', () => {
    // Genel kurul toplantisi 15.12.2026 19:00 (Istanbul) = 16:00Z.
    expect(formatDateTime('2026-12-15T16:00:00.000Z')).toBe('15.12.2026 19:00');
    // 21:05Z = ertesi gun 00:05 Istanbul (24:05 degil, gun ilerler).
    expect(formatDateTime('2026-12-15T21:05:00.000Z')).toBe('16.12.2026 00:05');
    expect(formatDateTime('2026-12-15T21:05:00.000Z', true)).toBe('00:05');
    expect(formatDateTime('gecersiz')).toBe('gecersiz');
    expect(durationText(120)).toBe('2 saat');
    expect(durationText(90)).toBe('1 saat 30 dakika');
    expect(durationText(45)).toBe('45 dakika');
  });

  it('HTML escape ve konu temizligi', () => {
    expect(escapeHtml(XSS)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Çiçek&#39;');
    expect(cleanSubject('Satir\r\nBcc: kotu@x.com')).toBe('Satir Bcc: kotu@x.com');
    expect(cleanSubject('x'.repeat(200))).toHaveLength(150);
  });

  it('baglanti yalnizca https (yerelde localhost); javascript: ve diger semalar reddedilir', () => {
    expect(safeUrl('https://site.example/app', 'dues')).toBe('https://site.example/app/dues');
    expect(safeUrl('http://localhost:5173/app', 'odeme')).toBe('http://localhost:5173/app/odeme');
    expect(safeUrl('http://site.example/app', 'dues')).toBeUndefined();
    expect(safeUrl('javascript:alert(1)//', 'dues')).toBeUndefined();
    expect(safeUrl(undefined, 'dues')).toBeUndefined();
  });
});

describe('Turkce e-posta sablonlari', () => {
  it('tahsilat: tutar, tarih, makbuz no; HTML ve duz metin, mobil uyumlu yerlesim', () => {
    const e = renderEmail(note('payment_received', { unitId: 'u1', amount: 150050, receiptNumber: 'MKB-000042', paidAt: '2026-11-05' }), ctx())!;
    expect(e.subject).toBe('Ödemeniz alındı - A Blok - 5 - Lale <Sitesi>');
    for (const part of ['1.500,50 TL', '05.11.2026', 'MKB-000042', 'A Blok - 5']) {
      expect(e.html).toContain(part);
      expect(e.text).toContain(part);
    }
    expect(e.html).toContain('href="https://site.example/app/dues"');
    expect(e.html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(e.html).toContain('max-width:560px');
    expect(e.html).toContain('lang="tr"');
    expect(e.text).toContain('Makbuzu görüntüle: https://site.example/app/dues');
  });

  it('tekil tahakkuk, gecikme tazminati, hatirlatma ve duyuru sablonlari', () => {
    const due = renderEmail(note('due_generated', { unitId: 'u2', amount: 100000, dueDate: '2026-11-15', description: 'Kasım aidatı' }), ctx())!;
    expect(due.subject).toBe('Yeni borç kaydı: Kasım aidatı - Lale <Sitesi>');
    expect(due.text).toContain('Son ödeme tarihi: 15.11.2026');
    expect(due.text).toContain('Bağımsız bölüm: B Blok - 12');

    const fee = renderEmail(note('late_fee_posted', { unitId: 'u1', amount: 8667, period: '2026-10' }), ctx())!;
    expect(fee.subject).toContain('Gecikme tazminatı: Ekim 2026');
    expect(fee.text).toContain('Tutar: 86,67 TL');
    expect(fee.text).toContain('kıstelyevm');

    const overdue = renderEmail(note('dues_reminder_overdue_7', { unitId: 'u1', amount: 100000, dueDate: '2026-11-05' }), ctx())!;
    expect(overdue.subject).toContain('7 gündür');
    expect(overdue.html).toContain('href="https://site.example/app/odeme"');

    const ann = renderEmail(note('announcement_published', { announcementId: 'a1', title: 'Su kesintisi' }), ctx())!;
    expect(ann.subject).toBe('Yeni duyuru: Su kesintisi - Lale <Sitesi>');
  });

  it('toplu tahakkuk ozeti: daire tablosu, toplam ve son odeme; tek dairede toplam satiri yok', () => {
    const many = renderEmail(
      note('dues_batch_summary', {
        batchId: 'b1',
        description: 'Kasım aidatı',
        dueDate: '2026-11-15',
        total: 220000,
        items: [
          { unitId: 'u1', amount: 100000 },
          { unitId: 'u2', amount: 120000 },
        ],
      }),
      ctx(),
    )!;
    expect(many.subject).toBe('Kasım aidatı tahakkuk edildi - Lale <Sitesi>');
    expect(many.text).toContain('- A Blok - 5: 1.000,00 TL');
    expect(many.text).toContain('- B Blok - 12: 1.200,00 TL');
    expect(many.text).toContain('Toplam: 2.200,00 TL');
    expect(many.html).toContain('2 bağımsız bölümünüz');

    const one = renderEmail(
      note('dues_batch_summary', { batchId: 'b1', description: 'Kasım aidatı', dueDate: '2026-11-15', total: 100000, items: [{ unitId: 'u1', amount: 100000 }] }),
      ctx(),
    )!;
    expect(one.text).not.toContain('Toplam:');
  });

  it('XSS: site, alici, daire, aciklama, baslik ve makbuz metinleri her yerde escape edilir', () => {
    const c = ctx({ siteName: XSS, recipientName: XSS, unitLabel: () => XSS });
    const cases = [
      note('due_generated', { unitId: 'u1', amount: 1, dueDate: '2026-11-15', description: XSS }),
      note('announcement_published', { announcementId: 'a', title: XSS }),
      note('dues_batch_summary', { batchId: 'b', description: XSS, dueDate: '2026-11-15', total: 1, items: [{ unitId: 'u1', amount: 1 }] }),
      note('payment_received', { unitId: 'u1', amount: 1, receiptNumber: XSS, paidAt: '2026-11-05' }),
      note('late_fee_posted', { unitId: 'u1', amount: 1, period: XSS }),
    ];
    for (const n of cases) {
      const { html } = renderEmail(n, c)!;
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<b>');
      expect(html).toContain('&lt;script&gt;');
    }
  });

  it('guvensiz portal adresinde buton uretilmez; bilinmeyen sablon undefined', () => {
    const e = renderEmail(note('payment_received', { unitId: 'u1', amount: 1, receiptNumber: 'M', paidAt: '2026-11-05' }), ctx({ portalUrl: 'javascript:alert(1)' }))!;
    expect(e.html).not.toContain('href=');
    expect(renderEmail(note('yok' as never, {}), ctx())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SES gonderici
// ---------------------------------------------------------------------------

describe('SES gonderici', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());
  const message: EmailMessage = {
    to: 'ayse@example.com',
    subject: 'Konu',
    html: '<p>x</p>',
    text: 'x',
    tags: { template: 'payment_received', apartment: 'apt-1' },
  };
  const client = () => new SESv2Client({ region: 'eu-north-1' });

  it('gonderen adres: ASCII disi gorunen ad MIME encoded-word ile kodlanir', () => {
    const enc = encodeFromAddress(DEFAULT_FROM_ADDRESS);
    expect(DEFAULT_FROM_ADDRESS).toBe('YÖNESİST <bildirim@yonetimsistemim.com>');
    expect(enc.address).toBe('bildirim@yonetimsistemim.com');
    expect(enc.header).toBe(`=?UTF-8?B?${Buffer.from('YÖNESİST', 'utf8').toString('base64')}?= <bildirim@yonetimsistemim.com>`);
    expect(encodeFromAddress('Bina Yonetim <no-reply@ornek.com>').header).toBe('"Bina Yonetim" <no-reply@ornek.com>');
    expect(encodeFromAddress('no-reply@ornek.com').header).toBe('no-reply@ornek.com');
    expect(() => encodeFromAddress('gecersiz')).toThrow();
  });

  it('SendEmailCommand: UTF-8 HTML + metin, yapilandirma seti ve etiketler', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'mid-1' });
    const sender = createSesEmailSender({ from: DEFAULT_FROM_ADDRESS, configurationSet: 'bm-dev', client: client() });
    expect(await sender.send(message)).toEqual({ messageId: 'mid-1' });
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: encodeFromAddress(DEFAULT_FROM_ADDRESS).header,
      Destination: { ToAddresses: ['ayse@example.com'] },
      ConfigurationSetName: 'bm-dev',
      Content: {
        Simple: {
          Subject: { Data: 'Konu', Charset: 'UTF-8' },
          Body: { Html: { Data: '<p>x</p>', Charset: 'UTF-8' }, Text: { Data: 'x', Charset: 'UTF-8' } },
        },
      },
    });
    expect(input.EmailTags).toEqual([
      { Name: 'template', Value: 'payment_received' },
      { Name: 'apartment', Value: 'apt-1' },
    ]);
  });

  it('yapilandirma seti yoksa alan gonderilmez', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'm' });
    await createSesEmailSender({ from: 'a@b.com', client: client() }).send(message);
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input).not.toHaveProperty('ConfigurationSetName');
  });

  it('hata siniflandirmasi: reddedilen ileti kalici; kisitlama/hesap sorunu tekrar denenir', async () => {
    const sender = createSesEmailSender({ from: 'a@b.com', client: client() });
    ses
      .on(SendEmailCommand)
      .rejectsOnce(new MessageRejected({ message: 'unverified', $metadata: {} }))
      .rejectsOnce(new BadRequestException({ message: 'bad', $metadata: {} }))
      .rejectsOnce(new TooManyRequestsException({ message: 'slow', $metadata: {} }))
      .rejectsOnce(new AccountSuspendedException({ message: 'x', $metadata: {} }));
    await expect(sender.send(message)).rejects.toBeInstanceOf(PermanentEmailError);
    await expect(sender.send(message)).rejects.toBeInstanceOf(PermanentEmailError);
    await expect(sender.send(message)).rejects.toBeInstanceOf(TooManyRequestsException);
    await expect(sender.send(message)).rejects.toBeInstanceOf(AccountSuspendedException);
    await expect(sender.send({ ...message, to: 'gecersiz' })).rejects.toBeInstanceOf(PermanentEmailError);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// E-posta kanali (tercih, adres, idempotency, hata)
// ---------------------------------------------------------------------------

function person(userId: string, over: Partial<Person> = {}): Person {
  return {
    PK: `APT#${APT}`,
    SK: `PERSON#${userId}`,
    entityType: 'PERSON',
    apartmentId: APT,
    userId,
    fullName: `Kisi ${userId}`,
    email: `${userId}@example.com`,
    ...audit,
    ...over,
  };
}

function channel(
  over: { people?: Person[]; prefs?: Record<string, boolean>; send?: (m: EmailMessage) => Promise<{ messageId?: string }>; roles?: ApartmentRole[] } = {},
) {
  const sentMessages: EmailMessage[] = [];
  const sentRecords = new Map<string, string>();
  const people = over.people ?? [person('user-1')];
  const sentLog: SentLog = {
    has: async (apt, e, u) => sentRecords.has(`${apt}|${e}|${u}`),
    record: async (apt, e, u, info) => void sentRecords.set(`${apt}|${e}|${u}`, info.status),
  };
  const preferences: Pick<PreferencesRepository, 'get'> = {
    get: async (u) => ({ email: { enabled: over.prefs?.[u] ?? true } }),
  };
  const core = {
    getSite: vi.fn(async () => ({ siteId: APT, name: 'Lale Sitesi' }) as Site),
    listUnits: vi.fn(async () => [{ unitId: 'u1', blockId: 'A', number: '5' }, { unitId: 'u2', blockId: 'B', number: '12' }] as Unit[]),
    listBlocks: vi.fn(async () => [{ blockId: 'A', name: 'A Blok' }, { blockId: 'B', name: 'B Blok' }] as Block[]),
  };
  const log = { info: vi.fn(), error: vi.fn() };
  const rolesList = vi.fn(async () => over.roles ?? []);
  const notifier = createEmailNotifier({
    sender: { send: over.send ?? (async (m) => (sentMessages.push(m), { messageId: `m${sentMessages.length}` })) },
    preferences,
    people: { get: async (_a, u) => people.find((p) => p.userId === u) },
    ...(over.roles ? { roles: { list: rolesList } } : {}),
    core,
    sentLog,
    portalUrl: 'https://site.example/app',
    now: () => NOW,
    log,
  });
  return { notifier, sentMessages, sentRecords, core, log, rolesList };
}

const pay = (userId = 'user-1'): Notification => ({
  ...note('payment_received', { unitId: 'u1', amount: 150050, receiptNumber: 'MKB-000001', paidAt: '2026-11-05' }),
  userId,
});

describe('e-posta kanali', () => {
  it('kisinin adresine gonderir, site ve daire etiketini kullanir, gonderimi kaydeder', async () => {
    const c = channel();
    expect(await c.notifier.send(pay())).toEqual({ status: 'sent' });
    expect(c.sentMessages).toHaveLength(1);
    expect(c.sentMessages[0]).toMatchObject({ to: 'user-1@example.com', tags: { template: 'payment_received', apartment: APT } });
    expect(c.sentMessages[0]!.subject).toBe('Ödemeniz alındı - A Blok - 5 - Lale Sitesi');
    expect(c.sentMessages[0]!.text).toContain('Sayın Kisi user-1,');
    expect(c.sentRecords.get(`${APT}|E1|user-1`)).toBe('sent');
  });

  it('tek blokta daire etiketi "Daire <no>"', async () => {
    const c = channel();
    c.core.listBlocks.mockResolvedValueOnce([{ blockId: 'A', name: 'A Blok' }] as Block[]);
    await c.notifier.send(pay());
    expect(c.sentMessages[0]!.subject).toBe('Ödemeniz alındı - Daire 5 - Lale Sitesi');
  });

  it('ayni olay-alici ikinci kez gonderilmez (alici bazli idempotency)', async () => {
    const c = channel();
    await c.notifier.send(pay());
    expect(await c.notifier.send(pay())).toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(c.sentMessages).toHaveLength(1);
  });

  it('tercih kapaliysa, adres yoksa/gecersizse veya dogrulanmamissa guvenle atlanir', async () => {
    const c = channel({
      prefs: { 'off-user': false },
      people: [
        person('off-user'),
        person('no-mail', { email: '' }),
        person('bad-mail', { email: 'yok' }),
        person('unverified', { emailVerified: false }),
      ],
    });
    expect(await c.notifier.send(pay('off-user'))).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(await c.notifier.send(pay('no-mail'))).toEqual({ status: 'skipped', reason: 'no_email' });
    expect(await c.notifier.send(pay('bad-mail'))).toEqual({ status: 'skipped', reason: 'no_email' });
    expect(await c.notifier.send(pay('ghost'))).toEqual({ status: 'skipped', reason: 'no_email' });
    expect(await c.notifier.send(pay('unverified'))).toEqual({ status: 'skipped', reason: 'email_unverified' });
    expect(c.sentMessages).toHaveLength(0);
    expect(c.sentRecords.size).toBe(0);
  });

  it('kalici ret kaydedilir ve tekrar denenmez; gecici hata firlatilir (olay yeniden denenir)', async () => {
    const rejected = channel({
      send: async () => {
        throw new PermanentEmailError('SES alici/ileti reddi: MessageRejected');
      },
    });
    expect(await rejected.notifier.send(pay())).toEqual({ status: 'skipped', reason: 'rejected' });
    expect(rejected.sentRecords.get(`${APT}|E1|user-1`)).toBe('rejected');
    expect(rejected.log.error.mock.calls.flat().join(' ')).toContain('email_rejected');
    expect(await rejected.notifier.send(pay())).toEqual({ status: 'skipped', reason: 'already_sent' });

    const throttled = channel({
      send: async () => {
        throw new TooManyRequestsException({ message: 'x', $metadata: {} });
      },
    });
    await expect(throttled.notifier.send(pay())).rejects.toBeInstanceOf(TooManyRequestsException);
    expect(throttled.sentRecords.size).toBe(0);
  });

  it('site/daire bilgisi alicilar arasinda onbellekten okunur', async () => {
    const c = channel({ people: [person('a'), person('b')] });
    await c.notifier.send(pay('a'));
    await c.notifier.send(pay('b'));
    expect(c.core.getSite).toHaveBeenCalledTimes(1);
  });
});

describe('e-posta kanali: ekip kaydindan yedek adres', () => {
  const teamRole = (userId: string, over: Partial<ApartmentRole> = {}): ApartmentRole =>
    ({
      PK: `APT#${APT}`,
      SK: `ROLE#${userId}#building_staff`,
      entityType: 'APARTMENT_ROLE',
      userId,
      apartmentId: APT,
      role: 'building_staff',
      fullName: `Ekip ${userId}`,
      email: `${userId}@ekip.example`,
      status: 'active',
      startDate: '2026-01-01',
      ...audit,
      ...over,
    }) as ApartmentRole;
  const ticketNote = (userId: string): Notification => ({
    eventId: `ev-${userId}`,
    apartmentId: APT,
    userId,
    template: 'ticket_assigned',
    data: { ticketId: 't1', number: 'T-000001', title: 'Koridor lambası', category: 'electrical', area: 'A blok koridor', link: 'admin' },
  });

  it('kisi kaydi olmayan ekip uyesine aktif ekip kaydindaki davet e-postasiyla gonderir (ad da oradan)', async () => {
    const c = channel({ people: [], roles: [teamRole('staff-1')] });
    expect(await c.notifier.send(ticketNote('staff-1'))).toEqual({ status: 'sent' });
    expect(c.sentMessages[0]?.to).toBe('staff-1@ekip.example');
    expect(c.sentMessages[0]?.text).toContain('Ekip staff-1');
  });

  it('kisi kaydinda gecerli adres varsa o kullanilir; dogrulanmamis kisi adresi ekip adresine dusmez', async () => {
    const c = channel({ people: [person('staff-1', { email: 'kisi@example.com' })], roles: [teamRole('staff-1')] });
    await c.notifier.send(ticketNote('staff-1'));
    expect(c.sentMessages[0]?.to).toBe('kisi@example.com');

    const u = channel({ people: [person('staff-1', { emailVerified: false })], roles: [teamRole('staff-1')] });
    expect(await u.notifier.send(ticketNote('staff-1'))).toEqual({ status: 'skipped', reason: 'email_unverified' });

    // Kisi kaydi var ama adresi yok / gecersiz: ekip adresi kullanilir.
    const e = channel({ people: [person('staff-1', { email: 'gecersiz' })], roles: [teamRole('staff-1')] });
    await e.notifier.send(ticketNote('staff-1'));
    expect(e.sentMessages[0]?.to).toBe('staff-1@ekip.example');
  });

  it('bitmis, pasif, henuz baslamamis veya e-postasiz ekip kaydina gonderilmez; birden cok rolde en son baslayan', async () => {
    const roles = [
      teamRole('ended', { endDate: '2026-11-01' }),
      teamRole('inactive', { status: 'inactive' }),
      teamRole('future', { startDate: '2026-12-01' }),
      teamRole('noemail', { email: undefined }),
      teamRole('multi', { email: 'eski@ekip.example', startDate: '2026-02-01' }),
      teamRole('multi', { role: 'apartment_manager', email: 'yeni@ekip.example', startDate: '2026-06-01' }),
    ];
    const c = channel({ people: [], roles });
    for (const u of ['ended', 'inactive', 'future', 'noemail']) expect(await c.notifier.send(ticketNote(u))).toEqual({ status: 'skipped', reason: 'no_email' });
    await c.notifier.send(ticketNote('multi'));
    expect(c.sentMessages.map((m) => m.to)).toEqual(['yeni@ekip.example']);
    // Ekip listesi apartman basina kisa sureli onbellekten okunur.
    expect(c.rolesList).toHaveBeenCalledTimes(1);
  });

  it('yedek kaynak verilmemisse eski davranis: no_email', async () => {
    const c = channel({ people: [] });
    expect(await c.notifier.send(ticketNote('staff-1'))).toEqual({ status: 'skipped', reason: 'no_email' });
  });
});

describe('kanal secimi (ortam)', () => {
  it('varsayilan log; ses secilince e-posta kanali; gecersiz deger reddedilir', () => {
    expect(createNotifierFromEnv({}).channel).toBe('log');
    expect(createNotifierFromEnv({ NOTIFICATION_CHANNEL: 'log' }).channel).toBe('log');
    expect(createNotifierFromEnv({ NOTIFICATION_CHANNEL: 'ses', AWS_REGION: 'eu-north-1' }).channel).toBe('email');
    expect(() => createNotifierFromEnv({ NOTIFICATION_CHANNEL: 'sms' })).toThrow(/NOTIFICATION_CHANNEL/);
    expect(() => createNotifierFromEnv({ NOTIFICATION_CHANNEL: 'ses', SES_FROM_ADDRESS: 'gecersiz' })).toThrow(/gonderen/);
  });
});

// ---------------------------------------------------------------------------
// Worker uctan uca: SES hatasinda yeniden deneme, onceki aliciya tekrar yok
// ---------------------------------------------------------------------------

describe('worker + e-posta kanali', () => {
  const members = [
    { userId: 'ok-user', unitId: 'u1', apartmentId: APT, relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01' },
    { userId: 'flaky-user', unitId: 'u1', apartmentId: APT, relation: 'owner', residesInUnit: true, status: 'active', startDate: '2026-01-01' },
  ] as UnitMembership[];
  const event = buildEvent(
    {
      eventId: 'PAYMENT_RECEIVED:p1',
      type: 'PAYMENT_RECEIVED',
      apartmentId: APT,
      actorId: 'mgr',
      payload: {
        paymentId: 'p1',
        transactionId: 't1',
        receiptNumber: 'MKB-000001',
        unitId: 'u1',
        liableParty: 'occupant',
        amount: toKurus(1000),
        method: 'cash',
        paidAt: '2026-11-05',
      },
    },
    () => NOW,
  );

  it('bir alicida gecici SES hatasi: mesaj tekrar denenir, basarili aliciya ikinci e-posta gitmez', async () => {
    let flaky = true;
    const delivered: string[] = [];
    const c = channel({
      people: [person('ok-user'), person('flaky-user')],
      send: async (m) => {
        if (m.to.startsWith('flaky') && flaky) throw new TooManyRequestsException({ message: 'x', $metadata: {} });
        delivered.push(m.to);
        return { messageId: m.to };
      },
    });
    const processed = new Set<string>();
    const log = { info: vi.fn(), error: vi.fn() };
    const worker = createNotificationWorker({
      memberships: { list: async () => members },
      core: { listUnits: async () => [] },
      notifier: c.notifier,
      isProcessed: async (_a, id) => processed.has(id),
      markProcessed: async (_a, id) => void processed.add(id),
      now: () => NOW,
      log,
    });
    const sqs = { Records: [{ messageId: 'm1', body: JSON.stringify(event) }] };

    expect((await worker(sqs)).batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(processed.size).toBe(0);
    flaky = false;
    expect((await worker(sqs)).batchItemFailures).toEqual([]);
    expect(delivered.sort()).toEqual(['flaky-user@example.com', 'ok-user@example.com']);
    const line = JSON.parse(log.info.mock.calls.at(-1)![0] as string);
    expect(line).toMatchObject({ msg: 'event_processed', channel: 'email', recipients: 2, sent: 1, skippedRecipients: { already_sent: 1 } });
  });

  it('tercihi kapali alici skipped olarak loglanir, olay basariyla islenir', async () => {
    const c = channel({ people: [person('ok-user'), person('flaky-user')], prefs: { 'flaky-user': false } });
    const log = { info: vi.fn(), error: vi.fn() };
    const worker = createNotificationWorker({
      memberships: { list: async () => members },
      core: { listUnits: async () => [] },
      notifier: c.notifier,
      isProcessed: async () => false,
      markProcessed: async () => {},
      now: () => NOW,
      log,
    });
    expect((await worker({ Records: [{ messageId: 'm1', body: JSON.stringify(event) }] })).batchItemFailures).toEqual([]);
    expect(c.sentMessages.map((m) => m.to)).toEqual(['ok-user@example.com']);
    expect(JSON.parse(log.info.mock.calls.at(-1)![0] as string)).toMatchObject({ sent: 1, skippedRecipients: { opted_out: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Tercihler: depo + /api/me uclari
// ---------------------------------------------------------------------------

describe('bildirim tercihleri', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('kayit yoksa varsayilan acik; kayit USER#<id> / NOTIFPREF', async () => {
    ddb.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { emailEnabled: false, updatedAt: ts } });
    const repo = createDynamoPreferencesRepository();
    expect(await repo.get('user-1')).toEqual({ email: { enabled: true } });
    expect(await repo.get('user-1')).toEqual({ email: { enabled: false }, updatedAt: ts });
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ PK: 'USER#user-1', SK: 'NOTIFPREF' });

    ddb.on(UpdateCommand).resolves({});
    await repo.patch('user-1', { enabled: false, categories: {}, updatedAt: ts });
    const update = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.Key).toEqual({ PK: 'USER#user-1', SK: 'NOTIFPREF' });
    expect(update.UpdateExpression).toBe('SET #et = :et, #uid = :uid, #upd = :upd, #a3 = :v3');
    expect(update.ExpressionAttributeNames).toMatchObject({ '#a3': 'emailEnabled' });
    expect(update.ExpressionAttributeValues).toEqual({ ':et': 'NOTIFICATION_PREFERENCES', ':uid': 'user-1', ':upd': ts, ':v3': false });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    await expect(repo.get('a#b')).rejects.toThrow(/userId/);
  });

  it('govde dogrulamasi: yalnizca email.enabled (boolean)', () => {
    expect(parsePreferences({ email: { enabled: false } })).toEqual({ email: { enabled: false } });
    for (const bad of [null, {}, { email: { enabled: 'no' } }, { email: { enabled: true }, sms: true }]) {
      expect(() => parsePreferences(bad)).toThrow();
    }
  });

  function api() {
    const { repository, store } = createFakePreferencesRepo();
    const app = createApp({
      version: 'test',
      authenticate: createMockAuthenticator(),
      identify: createMockIdentityResolver(),
      notificationPreferences: createPreferencesService({ repository, now: () => NOW }),
    });
    const call = (method: string, sub: string | undefined, body?: unknown) =>
      app.request('/api/me/notification-preferences', {
        method,
        headers: {
          ...(sub ? { authorization: `Bearer ${encodeMockToken({ sub, role: 'resident', apartmentId: APT })}` } : {}),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { call, store };
  }

  it("GET varsayilan acik; PUT kullanicinin KENDI tercihini kaydeder (kimlik JWT'den)", async () => {
    const { call, store } = api();
    expect(await (await call('GET', 'res-1')).json()).toEqual({ email: { enabled: true } });
    const put = await call('PUT', 'res-1', { email: { enabled: false } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ email: { enabled: false }, updatedAt: ts });
    expect(store.get('res-1')).toEqual({ email: { enabled: false }, updatedAt: ts });
    expect(await (await call('GET', 'res-1')).json()).toMatchObject({ email: { enabled: false } });
    // Baska kullanici etkilenmez.
    expect(await (await call('GET', 'res-2')).json()).toEqual({ email: { enabled: true } });
  });

  it('kimliksiz 401, gecersiz govde 400, govdeden baska kullanici hedeflenemez', async () => {
    const { call, store } = api();
    expect((await call('GET', undefined)).status).toBe(401);
    expect((await call('PUT', 'res-1', { email: { enabled: 'evet' } })).status).toBe(400);
    expect((await call('PUT', 'res-1', { userId: 'baska', email: { enabled: false } })).status).toBe(400);
    expect(store.size).toBe(0);
  });
});
