/**
 * Mobil bildirim (push) kanali: icerik (kisa, kisisel veri / serbest metin yok), Expo istemcisi
 * (100'luk parca, hata siniflari), kanal (alicilar e-postayla ayni, push tercihi, cihaz bazli tekrar
 * korumasi, DeviceNotRegistered, kismi hata yalnizca kalanlari tekrar dener) ve worker entegrasyonu.
 */
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { type DomainEvent, buildEvent } from '../src/events/publisher.js';
import type { Unit } from '../src/modules/core/types.js';
import { type NotificationCategory, NOTIFICATION_CATEGORIES } from '../src/modules/notifications/categories.js';
import { deviceIdOf } from '../src/modules/notifications/devices.js';
import { type ExpoMessage, type ExpoTicket, MixedProjectsError, PermanentPushError, TransientPushError, createExpoClient, secretsManagerAccessToken } from '../src/modules/notifications/expo.js';
import type { Notification, NotificationTemplate, Notifier } from '../src/modules/notifications/notifier.js';
import type { NotificationPreferences } from '../src/modules/notifications/preferences.js';
import { type PushChannelDeps, type PushMarkerStore, createDynamoPushMarkers, createPushChannel, createPushChannelFromEnv, pushChannelMode } from '../src/modules/notifications/push.js';
import type { ReceiptTicket } from '../src/modules/notifications/push-receipts.js';
import { renderPush } from '../src/modules/notifications/push-templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createNotificationWorker } from '../src/workers/notification-worker.js';
import { createFakeDeviceRepo } from './fakes/deviceRepo.js';

const NOW = new Date('2026-11-28T09:00:00.000Z');
const APT = 'apt-1';
const quiet = { info: () => {}, error: () => {} };
const token = (n: number | string) => `ExponentPushToken[tok${String(n).padStart(8, '0')}xyzABC]`;

// ---------------------------------------------------------------------------
// Icerik
// ---------------------------------------------------------------------------

const ALL_TEMPLATES: NotificationTemplate[] = [
  'due_generated', 'dues_batch_summary', 'dues_reversed', 'payment_received', 'announcement_published', 'poll_published', 'late_fee_posted',
  'ticket_created', 'ticket_assigned', 'ticket_status', 'ticket_resolved', 'ticket_reopened', 'ticket_comment', 'operations_digest',
  'gate_courier_arrived', 'gate_guest_entered', 'reservation_approved', 'reservation_rejected', 'reservation_cancelled', 'assembly_called',
  'tender_published', 'tender_decided', 'tender_cancelled', 'tender_replied',
  'dues_reminder_upcoming', 'dues_reminder_overdue_1', 'dues_reminder_overdue_7', 'dues_reminder_plan_default',
];

const DATA: Notification['data'] = {
  unitId: 'u1', amount: 150050, receiptNumber: 'MKB-000001', paidAt: '2026-11-05', dueDate: '2026-11-15', description: 'Kasım aidatı',
  items: [{ unitId: 'u1', amount: 100000 }, { unitId: 'u2', amount: 50000 }], period: '2026-10',
  announcementId: 'ann1', pollId: 'poll1', title: 'Su kesintisi', closesAt: '2026-11-30T18:00:00.000Z',
  ticketId: 'tk1', number: 'T-12', to: 'in_progress', priority: 'normal', date: '2026-11-29',
  courierId: 'c1', company: 'Hızlı Kargo', respondBy: '2026-11-28T09:10:00.000Z', passId: 'p1', entryMode: 'single', enteredAt: NOW.toISOString(),
  bookingId: 'b1', facilityName: 'Toplantı salonu', start: '2026-11-29T15:00:00.000Z', end: '2026-11-29T17:00:00.000Z', reason: 'Bakım çalışması nedeniyle',
  assemblyId: 'as1', scheduledAt: '2026-12-10T16:00:00.000Z', location: 'Yönetim ofisi, Gül Sk. 5', onlineUrl: 'https://meet.example/x',
  tenderId: 'tn1', reply: 'Firma yarın gelecek', supplierName: 'Usta İnşaat', totalKurus: 1200000,
  slaCount: 2, dueCount: 1,
};
const note = (template: NotificationTemplate, over: Partial<Notification> = {}): Notification => ({ eventId: 'E1', apartmentId: APT, userId: 'user-1', template, data: DATA, ...over });

describe('push icerigi', () => {
  it('e-postasi olan her sablonun kisa push metni ve uygulama ici yolu var', () => {
    for (const t of ALL_TEMPLATES) {
      const c = renderPush(note(t), NOW);
      expect(c, t).toBeDefined();
      expect(c!.title.length, t).toBeGreaterThan(0);
      expect(c!.title.length, t).toBeLessThanOrEqual(80);
      expect(c!.body.length, t).toBeLessThanOrEqual(180);
      expect(c!.path, t).toMatch(/^\/[a-z-]+(\/[A-Za-z0-9_%-]+)?$/);
    }
    expect(renderPush(note('bilinmeyen' as NotificationTemplate), NOW)).toBeUndefined();
  });

  it('derin baglantilar: talep, duyuru, oylama, genel kurul, ihale kimlikli; kapi, borclar, rezervasyon sabit', () => {
    const path = (t: NotificationTemplate) => renderPush(note(t), NOW)?.path;
    expect(path('ticket_comment')).toBe('/talepler/tk1');
    expect(path('operations_digest')).toBe('/talepler');
    expect(path('announcement_published')).toBe('/duyurular/ann1');
    expect(path('poll_published')).toBe('/oylamalar/poll1');
    expect(path('assembly_called')).toBe('/genel-kurul/as1');
    expect(path('tender_replied')).toBe('/ihaleler/tn1');
    expect(path('gate_courier_arrived')).toBe('/kapi');
    expect(path('gate_guest_entered')).toBe('/kapi');
    expect(path('payment_received')).toBe('/borclar');
    expect(path('reservation_rejected')).toBe('/rezervasyonlar');
  });

  it('kapi bildirimleri en az bilgiyle: firma, bolum, saat yok; kurye yuksek oncelik, kapi kanali, yanit suresiyle sinirli', () => {
    const courier = renderPush(note('gate_courier_arrived'), NOW)!;
    const guest = renderPush(note('gate_guest_entered'), NOW)!;
    for (const c of [courier, guest]) {
      expect(`${c.title} ${c.body}`).not.toMatch(/Hızlı Kargo|u1|Daire|\d{2}:\d{2}/);
      expect(c.channelId).toBe('gate');
    }
    expect(courier).toMatchObject({ priority: 'high', ttlSeconds: 600, category: 'gate' });
    expect(renderPush(note('announcement_published'), NOW)).toMatchObject({ channelId: 'default', priority: 'default' });
  });

  it('serbest metin gerekce / yanit / adres / baglanti push metnine girmez', () => {
    const texts = ALL_TEMPLATES.map((t) => {
      const c = renderPush(note(t), NOW)!;
      return `${c.title} ${c.body}`;
    }).join('\n');
    for (const secret of ['Bakım çalışması', 'Firma yarın', 'Gül Sk', 'meet.example', 'Usta İnşaat']) expect(texts).not.toContain(secret);
  });

  it('kontrol karakterleri temizlenir, uzun metin kisaltilir', () => {
    const c = renderPush(note('announcement_published', { data: { ...DATA, title: `Satır\n\tbir${'x'.repeat(300)}` } }), NOW)!;
    expect(c.body).not.toMatch(/[\n\t]/);
    expect(c.body.length).toBe(180);
    expect(c.body.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Expo istemcisi
// ---------------------------------------------------------------------------

describe('Expo istemcisi', () => {
  const msg = (n: number): ExpoMessage => ({ to: token(n), title: 't', body: 'b', data: { url: '/kapi' }, sound: 'default', channelId: 'default', priority: 'default' });
  const respond = (status: number, json: unknown) => vi.fn(async () => ({ status, json: async () => json }));

  it('istek bicimi; erisim anahtari varsa Bearer, yoksa basliksiz', async () => {
    const fetch = respond(200, { data: [{ status: 'ok', id: 'r1' }, { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered', expoPushToken: token(2) } }] });
    expect(await createExpoClient({ fetch }).send([msg(1), msg(2)])).toEqual([{ status: 'ok', id: 'r1' }, { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.method).toBe('POST');
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(init.body)).toHaveLength(2);

    const authed = respond(200, { data: { r1: { status: 'ok' } } });
    expect(await createExpoClient({ fetch: authed, accessToken: 'sekret' }).getReceipts(['r1'])).toEqual({ r1: { status: 'ok' } });
    const [rurl, rinit] = authed.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(rurl).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(rinit.headers.authorization).toBe('Bearer sekret');
    expect(JSON.parse(rinit.body)).toEqual({ ids: ['r1'] });
  });

  it('100 mesaj siniri; bos parca istek atmaz', async () => {
    const fetch = respond(200, { data: [] });
    const client = createExpoClient({ fetch });
    expect(await client.send([])).toEqual([]);
    await expect(client.send(Array.from({ length: 101 }, (_, i) => msg(i)))).rejects.toThrow(/100/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gecici: ag, 429, 5xx, sayi uyusmazligi; kalici: 401/403 (auth) ve diger 4xx (hata kodu ile)', async () => {
    const send = (fetch: ReturnType<typeof respond>) => createExpoClient({ fetch }).send([msg(1)]);
    await expect(createExpoClient({ fetch: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) }).send([msg(1)])).rejects.toBeInstanceOf(TransientPushError);
    for (const status of [429, 500, 503]) await expect(send(respond(status, {})), String(status)).rejects.toBeInstanceOf(TransientPushError);
    for (const status of [401, 403]) await expect(send(respond(status, {})), String(status)).rejects.toMatchObject({ name: 'PermanentPushError', auth: true });
    await expect(send(respond(200, { data: [] }))).rejects.toBeInstanceOf(TransientPushError);
    await expect(send(respond(400, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x' }] }))).rejects.toMatchObject({ name: 'PermanentPushError', code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' });
    await expect(send(respond(400, { errors: [{ code: 'VALIDATION_ERROR', message: 'x' }] }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', auth: false });
  });

  it('karisik proje hatasi proje -> token gruplariyla doner', async () => {
    const details = { '@yonesist/app': [token(1), token(2)], '@someone/other': [token(3)] };
    const err = await createExpoClient({ fetch: respond(400, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x', details }] }) }).send([msg(1), msg(2), msg(3)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MixedProjectsError);
    expect((err as MixedProjectsError).groups).toEqual(details);
  });

  it('erisim anahtari Secrets Manager dan: duz metin / JSON, deger yoksa anahtarsiz, 5 dk bellekte', async () => {
    const sm = mockClient(SecretsManagerClient);
    sm.on(GetSecretValueCommand).resolvesOnce({ SecretString: ' tok_abc ' }).resolvesOnce({ SecretString: '{"accessToken":"tok_json"}' }).rejects(new ResourceNotFoundException({ message: 'no value', $metadata: {} }));
    let t = 0;
    const read = secretsManagerAccessToken('arn:aws:secretsmanager:eu-central-1:1:secret:x', { now: () => t });
    expect(await read()).toBe('tok_abc');
    expect(await read()).toBe('tok_abc');
    t += 5 * 60_000 + 1;
    expect(await read()).toBe('tok_json');
    t += 5 * 60_000 + 1;
    expect(await read()).toBeUndefined();
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(3);
    const fetch = respond(200, { data: [{ status: 'ok', id: 'r' }] });
    await createExpoClient({ fetch, accessToken: async () => 'tok_fn' }).send([msg(1)]);
    expect((fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers.authorization).toBe('Bearer tok_fn');
    sm.restore();
  });
});

// ---------------------------------------------------------------------------
// Kanal
// ---------------------------------------------------------------------------

type Responder = (messages: ExpoMessage[], call: number) => ExpoTicket[] | Promise<ExpoTicket[]>;

function fakeExpo(responder: Responder = (ms) => ms.map((_, i) => ({ status: 'ok', id: `r-${i}-${Math.random().toString(36).slice(2)}` }))) {
  const calls: ExpoMessage[][] = [];
  return {
    calls,
    client: {
      send: async (messages: ExpoMessage[]) => {
        calls.push(messages);
        return responder(messages, calls.length);
      },
    },
  };
}

function fakeMarkers() {
  const batches: { apartmentId: string; eventId: string; deviceIds: string[]; sent: number; deactivated: number; rejected: number }[] = [];
  const store: PushMarkerStore = {
    doneDevices: async (apt, eventId) => new Set(batches.filter((b) => b.apartmentId === apt && b.eventId === eventId).flatMap((b) => b.deviceIds)),
    record: async (apartmentId, eventId, batch) => void batches.push({ apartmentId, eventId, ...batch }),
  };
  return { store, batches };
}

function channel(over: Partial<PushChannelDeps> & { prefs?: Record<string, Partial<NotificationPreferences['push']>> } = {}) {
  const devices = createFakeDeviceRepo();
  const markers = fakeMarkers();
  const receipts: ReceiptTicket[][] = [];
  const expo = fakeExpo();
  const prefReads: string[] = [];
  const logs: string[] = [];
  const push = createPushChannel({
    devices: devices.repository,
    preferences: { get: async (u) => (prefReads.push(u), { push: { enabled: true, ...over.prefs?.[u] } }) },
    markers: markers.store,
    receipts: { record: async (e) => void receipts.push(e.tickets) },
    client: expo.client,
    siteName: async () => 'Lale Sitesi',
    now: () => NOW,
    log: { info: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) },
    ...over,
  });
  /** Kullaniciya n cihaz ekler (deviceId = token ozeti). */
  const addDevices = (userId: string, ...tokens: string[]) => {
    tokens.forEach((t, i) =>
      devices.seed({ deviceId: deviceIdOf(t), userId, platform: i % 2 ? 'android' : 'ios', status: 'active', createdAt: NOW.toISOString(), lastSeenAt: new Date(NOW.getTime() - i * 1000).toISOString(), token: t }),
    );
  };
  return { push, devices, markers, receipts, expo, prefReads, logs, addDevices };
}

const forUsers = (template: NotificationTemplate, ...userIds: string[]) => userIds.map((userId) => note(template, { userId, eventId: 'EV1' }));

describe('push kanali', () => {
  it('cihazi olmayan alici icin tercih okunmaz, Expo cagrilmaz, kayit yazilmaz', async () => {
    const c = channel();
    const out = await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a', 'b'));
    expect(out).toMatchObject({ recipients: 2, devices: 0, sent: 0, skipped: { no_device: 2 } });
    expect(c.prefReads).toEqual([]);
    expect(c.expo.calls).toEqual([]);
    expect(c.markers.batches).toEqual([]);
  });

  it('mesaj: cihaz tokenina baslik, govde, iOS alt basligi (site), data.url / apartmentId / type / category, Android kanali', async () => {
    const c = channel();
    c.addDevices('a', token(1));
    const out = await c.push.deliver(APT, 'EV1', forUsers('gate_courier_arrived', 'a'));
    expect(out).toMatchObject({ devices: 1, sent: 1 });
    expect(c.expo.calls[0]).toEqual([
      {
        to: token(1),
        title: 'Kapıda kuryeniz var',
        body: 'Kuryeyi içeri almak için onaylayın veya reddedin.',
        subtitle: 'Lale Sitesi',
        data: { url: '/kapi', apartmentId: APT, type: 'gate_courier_arrived', category: 'gate' },
        sound: 'default',
        channelId: 'gate',
        priority: 'high',
        ttl: 600,
      },
    ]);
    expect(c.receipts[0]).toEqual([{ id: expect.any(String), userId: 'a', deviceId: deviceIdOf(token(1)) }]);
    // Loglarda token, baslik, govde yok.
    expect(c.logs.join('\n')).not.toMatch(/ExponentPushToken|Kapıda/);
  });

  it('tercih: push ana anahtari veya kategori kapali -> atlanir; e-posta tercihinden bagimsiz', async () => {
    const c = channel({ prefs: { off: { enabled: false }, nogate: { gate: false }, noann: { announcements: false } } });
    for (const u of ['off', 'nogate', 'noann', 'on']) c.addDevices(u, token(u));
    const gate = await c.push.deliver(APT, 'EV1', forUsers('gate_guest_entered', 'off', 'nogate', 'noann', 'on'));
    expect(gate).toMatchObject({ sent: 2, skipped: { opted_out: 2 } });
    expect(c.expo.calls[0]!.map((m) => m.to).sort()).toEqual([token('noann'), token('on')].sort());
    // Worker olay turunden kategori atar: bildirimdeki kategori sablondan once gelir.
    const ann = await c.push.deliver(APT, 'EV2', [note('announcement_published', { userId: 'nogate', eventId: 'EV2', category: 'gate' as NotificationCategory })]);
    expect(ann).toMatchObject({ sent: 0, skipped: { opted_out: 1 } });
  });

  it('her kategori ayri kapatilir', async () => {
    const SAMPLE: Record<NotificationCategory, NotificationTemplate> = {
      finance: 'payment_received', announcements: 'announcement_published', tickets: 'ticket_comment', gate: 'gate_guest_entered',
      reservations: 'reservation_approved', polls: 'poll_published', assemblies: 'assembly_called', tenders: 'tender_decided',
      billing: 'billing_invoice_issued',
    };
    for (const category of NOTIFICATION_CATEGORIES) {
      const c = channel({ prefs: { u: { [category]: false } } });
      c.addDevices('u', token(1));
      for (const [cat, template] of Object.entries(SAMPLE)) {
        const out = await c.push.deliver(APT, `EV-${cat}`, [note(template, { userId: 'u', eventId: `EV-${cat}` })]);
        expect(out.sent, `${category}/${cat}`).toBe(cat === category ? 0 : 1);
      }
    }
  });

  it('parcalama: 250 cihaz -> 100 + 100 + 50; ayni cihaz olayda bir kez; en fazla 10 cihaz / kullanici', async () => {
    const c = channel();
    const users = Array.from({ length: 25 }, (_, i) => `u${i}`);
    for (const u of users) c.addDevices(u, ...Array.from({ length: 11 }, (_, k) => token(`${u}-${k}`)));
    const out = await c.push.deliver(APT, 'EV1', [...forUsers('announcement_published', ...users), ...forUsers('announcement_published', 'u0')]);
    expect(c.expo.calls.map((m) => m.length)).toEqual([100, 100, 50]);
    expect(out).toMatchObject({ recipients: 26, devices: 250, sent: 250 });
    expect(new Set(c.expo.calls.flat().map((m) => m.to)).size).toBe(250);
    expect(c.markers.batches).toHaveLength(3);
  });

  it('SQS yeniden teslimi: sonuclanmis cihazlara tekrar gonderilmez', async () => {
    const c = channel();
    c.addDevices('a', token(1), token(2));
    c.addDevices('b', token(3));
    await c.push.deliver(APT, 'EV1', forUsers('ticket_comment', 'a', 'b'));
    const again = await c.push.deliver(APT, 'EV1', forUsers('ticket_comment', 'a', 'b'));
    expect(c.expo.calls).toHaveLength(1);
    expect(again).toMatchObject({ devices: 0, sent: 0, alreadySent: 3 });
    // Baska olay ayni cihazlara gider.
    await c.push.deliver(APT, 'EV2', forUsers('ticket_comment', 'a').map((n) => ({ ...n, eventId: 'EV2' })));
    expect(c.expo.calls).toHaveLength(2);
  });

  it('DeviceNotRegistered: cihaz pasife alinir, tekrar denenmez; diger kalici hatalar loglanir, tekrar denenmez', async () => {
    const c = channel();
    c.addDevices('a', token(1), token(2), token(3));
    c.expo.calls.length = 0;
    const dead = deviceIdOf(token(2));
    const expo = fakeExpo((ms) =>
      ms.map((m): ExpoTicket => (m.to === token(2) ? { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } : m.to === token(3) ? { status: 'error', details: { error: 'MessageTooBig' } } : { status: 'ok', id: 'r1' })),
    );
    const c2 = channel({ client: expo.client, devices: c.devices.repository });
    const out = await c2.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'));
    expect(out).toMatchObject({ devices: 3, sent: 1, deactivated: 1, rejected: 1, retry: 0 });
    expect(await c.devices.repository.get('a', dead)).toMatchObject({ status: 'inactive', deactivationReason: 'device_not_registered' });
    expect(c.devices.devices.get(`a|${dead}`)).not.toHaveProperty('token');
    expect(c2.logs.some((l) => l.includes('push_rejected') && l.includes('MessageTooBig'))).toBe(true);
    // Tekrar: hicbiri yeniden gonderilmez.
    await c2.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'));
    expect(expo.calls).toHaveLength(1);
  });

  it('kismi hata: gecici hatali parca ve MessageRateExceeded cihazi icin firlatir; tekrarda yalnizca onlar gider', async () => {
    let failSecond = true;
    const expo = fakeExpo((ms, call) => {
      if (call === 2 && failSecond) throw new TransientPushError('Expo gecici hata: HTTP 503');
      return ms.map((m): ExpoTicket => (m.to === token('u0-0') && call === 1 ? { status: 'error', details: { error: 'MessageRateExceeded' } } : { status: 'ok', id: `r-${m.to}` }));
    });
    const c = channel({ client: expo.client });
    const users = Array.from({ length: 150 }, (_, i) => `u${i}`);
    for (const u of users) c.addDevices(u, token(`${u}-0`));
    await expect(c.push.deliver(APT, 'EV1', forUsers('announcement_published', ...users))).rejects.toBeInstanceOf(TransientPushError);
    expect(expo.calls.map((m) => m.length)).toEqual([100, 50]);
    expect(c.markers.batches.flatMap((b) => b.deviceIds)).toHaveLength(99);
    failSecond = false;
    const retry = await c.push.deliver(APT, 'EV1', forUsers('announcement_published', ...users));
    expect(expo.calls.slice(2).flat().map((m) => m.to).sort()).toEqual([token('u0-0'), ...users.slice(100).map((u) => token(`${u}-0`))].sort());
    expect(retry).toMatchObject({ devices: 51, sent: 51, alreadySent: 99 });
  });

  it('kalici istek hatasi (4xx): parca reddedildi olarak kaydedilir, firlatilmaz', async () => {
    const expo = fakeExpo(() => {
      throw new PermanentPushError('PUSH_TOO_MANY_EXPERIENCE_IDS', 'x');
    });
    const c = channel({ client: expo.client });
    c.addDevices('a', token(1));
    expect(await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'))).toMatchObject({ rejected: 1, sent: 0 });
    expect(await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'))).toMatchObject({ alreadySent: 1 });
    expect(expo.calls).toHaveLength(1);
  });

  describe('karisik Expo projeleri (PUSH_TOO_MANY_EXPERIENCE_IDS)', () => {
    const OURS = '@yonesist/app';
    /** Expo gibi: istekte birden fazla proje varsa 400; token -> proje eslemesi `projects`. */
    const projectExpo = (projects: Record<string, string>) =>
      fakeExpo((ms) => {
        const groups: Record<string, string[]> = {};
        for (const m of ms) (groups[projects[m.to] ?? OURS] ??= []).push(m.to);
        if (Object.keys(groups).length > 1) throw new MixedProjectsError(groups);
        return ms.map((m) => ({ status: 'ok' as const, id: `r-${m.to}` }));
      });

    it('yapilandirilan proje: yabanci token cihazi pasife, kalan parca yeniden gonderilir; tekrar teslimde gitmez', async () => {
      const foreign = token('expo-go');
      const expo = projectExpo({ [foreign]: '@someone/expo-go' });
      const c = channel({ client: expo.client, projectId: OURS });
      c.addDevices('a', token(1), token(2));
      c.addDevices('hostile', foreign);
      const out = await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a', 'hostile'));
      expect(expo.calls.map((m) => m.length)).toEqual([3, 2]);
      expect(expo.calls[1]!.map((m) => m.to).sort()).toEqual([token(1), token(2)].sort());
      expect(out).toMatchObject({ sent: 2, deactivated: 1, rejected: 0, retry: 0 });
      expect(await c.devices.repository.get('hostile', deviceIdOf(foreign))).toMatchObject({ status: 'inactive', deactivationReason: 'foreign_project' });
      expect(c.logs.join('\n')).not.toContain('ExponentPushToken');
      await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a', 'hostile'));
      expect(expo.calls).toHaveLength(2);
      // Sonraki olaylarda yabanci token artik parcayi bozmaz.
      await c.push.deliver(APT, 'EV2', forUsers('announcement_published', 'a', 'hostile'));
      expect(expo.calls.at(-1)!.map((m) => m.to).sort()).toEqual([token(1), token(2)].sort());
    });

    it('proje yapilandirilmamis: en buyuk grup once, diger gruplar kendi isteginde; kimse pasife alinmaz', async () => {
      const expo = projectExpo({ [token('x1')]: '@someone/other' });
      const c = channel({ client: expo.client });
      c.addDevices('a', token(1), token(2));
      c.addDevices('b', token('x1'));
      const out = await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a', 'b'));
      expect(expo.calls.map((m) => m.map((x) => x.to).sort())).toEqual([[token(1), token(2), token('x1')].sort(), [token(1), token(2)].sort(), [token('x1')]]);
      expect(out).toMatchObject({ sent: 3, deactivated: 0, rejected: 0 });
    });

    it('yapilandirilan proje parcada yoksa (yanlis EXPO_PROJECT_ID) toplu pasife alma yapilmaz', async () => {
      const expo = projectExpo({ [token('x1')]: '@someone/other' });
      const c = channel({ client: expo.client, projectId: '@typo/app' });
      c.addDevices('a', token(1));
      c.addDevices('b', token('x1'));
      const out = await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a', 'b'));
      expect(out).toMatchObject({ sent: 2, deactivated: 0 });
      expect(c.logs.some((l) => l.includes('push_project_mismatch'))).toBe(true);
    });
  });

  it('401/403 (erisim anahtari): kalici, olay yeniden denenmez; PushRejected metrigi (alarm)', async () => {
    const expo = fakeExpo(() => {
      throw new PermanentPushError('HTTP_401', 'Expo yetkilendirme hatasi', { auth: true });
    });
    const emit = vi.fn();
    const c = channel({ client: expo.client, metrics: { emit } });
    c.addDevices('a', token(1), token(2));
    expect(await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'))).toMatchObject({ rejected: 2, sent: 0, retry: 0 });
    expect(emit).toHaveBeenCalledWith({ PushSent: 0, PushRejected: 2, PushRetried: 0, PushDeactivated: 0 }, expect.objectContaining({ msg: 'push_delivery' }));
    expect(c.logs.some((l) => l.includes('push_rejected') && l.includes('"auth":true'))).toBe(true);
  });

  it('gonderim kaydi yazilamazsa: olu cihaz yine pasife alinir, makbuz yazilir, sonra hata firlatilir (parca tekrar gider)', async () => {
    const expo = fakeExpo((ms) => ms.map((m): ExpoTicket => (m.to === token(2) ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'r1' })));
    const markers = fakeMarkers();
    let failRecord = true;
    const flaky: PushMarkerStore = {
      doneDevices: markers.store.doneDevices,
      record: async (...args) => {
        if (failRecord) throw new Error('DynamoDB yazilamadi');
        return markers.store.record(...args);
      },
    };
    const c = channel({ client: expo.client, markers: flaky });
    c.addDevices('a', token(1), token(2));
    await expect(c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'))).rejects.toThrow(/yazilamadi/);
    expect(await c.devices.repository.get('a', deviceIdOf(token(2)))).toMatchObject({ status: 'inactive', deactivationReason: 'device_not_registered' });
    expect(c.receipts).toHaveLength(1);
    // En az bir kez: kayit olmadigi icin canli cihaza tekrar gider (olu cihaz artik listede yok).
    failRecord = false;
    await c.push.deliver(APT, 'EV1', forUsers('announcement_published', 'a'));
    expect(expo.calls.map((m) => m.map((x) => x.to))).toEqual([[token(1), token(2)], [token(1)]]);
  });

  it('PUSH_CHANNEL: varsayilan off (kanal yok), expo, gecersiz deger hata', () => {
    expect(pushChannelMode({})).toBe('off');
    expect(createPushChannelFromEnv({})).toBeNull();
    expect(createPushChannelFromEnv({ PUSH_CHANNEL: 'off' })).toBeNull();
    expect(createPushChannelFromEnv({ PUSH_CHANNEL: 'expo' })).not.toBeNull();
    expect(() => pushChannelMode({ PUSH_CHANNEL: 'fcm' })).toThrow(/PUSH_CHANNEL/);
  });
});

describe('push gonderim kaydi (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('olay basina tek Query (NOTIFPUSH#<eventId># on eki); parca kaydi kosullu, TTL 30 gun', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ deviceIds: ['d1', 'd2'] }, { deviceIds: ['d3'] }] });
    ddb.on(PutCommand).resolves({});
    const markers = createDynamoPushMarkers(() => NOW);
    expect([...(await markers.doneDevices(APT, 'PAYMENT_RECEIVED:p1'))]).toEqual(['d1', 'd2', 'd3']);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'APT#apt-1', ':skp': 'NOTIFPUSH#PAYMENT_RECEIVED:p1#' });
    await markers.record(APT, 'PAYMENT_RECEIVED:p1', { deviceIds: ['d1'], sent: 1, deactivated: 0, rejected: 0 });
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item).toMatchObject({ PK: 'APT#apt-1', entityType: 'NOTIFICATION_PUSH', deviceIds: ['d1'], ttl: Math.floor(NOW.getTime() / 1000) + 30 * 24 * 3600 });
    expect(String(put.Item?.SK)).toMatch(/^NOTIFPUSH#PAYMENT_RECEIVED:p1#[0-9a-f-]{36}$/);
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});

// ---------------------------------------------------------------------------
// Worker entegrasyonu
// ---------------------------------------------------------------------------

describe('worker + push', () => {
  const member = (userId: string, unitId: string, over: Partial<UnitMembership> = {}) =>
    ({ userId, unitId, apartmentId: APT, relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01', ...over }) as UnitMembership;
  const memberships = [member('a', 'u1'), member('b', 'u2'), member('old', 'u3', { endDate: '2026-06-30' }), member('other-apt', 'u1', { apartmentId: 'apt-2' })];
  const announcement = (id = 'ann1') =>
    buildEvent({ eventId: `ANNOUNCEMENT_PUBLISHED:${id}`, type: 'ANNOUNCEMENT_PUBLISHED', apartmentId: APT, actorId: 'mgr', payload: { announcementId: id, title: 'Su kesintisi', blockIds: [], publishAt: NOW.toISOString() } }, () => NOW);
  const sqs = (...events: DomainEvent[]) => ({ Records: events.map((e, i) => ({ messageId: `m${i + 1}`, body: JSON.stringify(e) })) });

  function setup(notifier?: Notifier) {
    const c = channel();
    for (const u of ['a', 'b', 'old', 'other-apt']) c.addDevices(u, token(u));
    const emailed: Notification[] = [];
    const processed = new Set<string>();
    const logs: string[] = [];
    const worker = createNotificationWorker({
      memberships: { list: async () => memberships },
      core: { listUnits: async () => [] as Unit[] },
      notifier: notifier ?? { channel: 'test', send: async (n) => void emailed.push(n) },
      push: c.push,
      isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
      markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
      now: () => NOW,
      log: { info: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) },
    });
    return { worker, c, emailed, processed, logs };
  }

  it('push alicilari e-posta alicilariyla ayni (eski uye ve baska apartman almaz); sonuc loga yazilir', async () => {
    const { worker, c, emailed, logs } = setup();
    expect((await worker(sqs(announcement()))).batchItemFailures).toEqual([]);
    expect(emailed.map((n) => n.userId).sort()).toEqual(['a', 'b']);
    expect(c.expo.calls.flat().map((m) => m.to).sort()).toEqual([token('a'), token('b')]);
    expect(c.expo.calls[0]![0]!.data).toMatchObject({ url: '/duyurular/ann1', category: 'announcements' });
    expect(JSON.parse(logs.find((l) => l.includes('event_processed')) ?? '{}')).toMatchObject({ recipients: 2, sent: 2, push: { devices: 2, sent: 2 } });
  });

  it("e-posta hatasi push'u engellemez; olay isaretlenmez, tekrarda push yinelenmez", async () => {
    let fail = true;
    const sent: string[] = [];
    const notifier: Notifier = {
      channel: 'email',
      send: async (n) => {
        if (fail) throw new Error('SES kisitlama');
        sent.push(n.userId);
      },
    };
    const { worker, c, processed } = setup(notifier);
    expect((await worker(sqs(announcement()))).batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(c.expo.calls.flat()).toHaveLength(2);
    expect(processed.size).toBe(0);
    fail = false;
    expect((await worker(sqs(announcement()))).batchItemFailures).toEqual([]);
    expect(sent.sort()).toEqual(['a', 'b']);
    expect(c.expo.calls.flat()).toHaveLength(2);
    expect(processed.size).toBe(1);
  });

  it('push gecici hatasi olayi yeniden denetir; islenmis olay tekrar gelirse hicbir kanal calismaz', async () => {
    let fail = true;
    const { c, processed } = setup();
    const expo = fakeExpo((ms) => {
      if (fail) throw new TransientPushError('HTTP 503');
      return ms.map(() => ({ status: 'ok' as const, id: 'r' }));
    });
    const pushOnly = createPushChannel({
      devices: c.devices.repository,
      preferences: { get: async () => ({}) },
      markers: c.markers.store,
      receipts: { record: async () => {} },
      client: expo.client,
      now: () => NOW,
      log: quiet,
    });
    const w = createNotificationWorker({
      memberships: { list: async () => memberships },
      core: { listUnits: async () => [] as Unit[] },
      notifier: { channel: 'log', send: async () => {} },
      push: pushOnly,
      isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
      markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
      now: () => NOW,
      log: quiet,
    });
    expect((await w(sqs(announcement()))).batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    fail = false;
    expect((await w(sqs(announcement()))).batchItemFailures).toEqual([]);
    expect((await w(sqs(announcement()))).batchItemFailures).toEqual([]);
    expect(expo.calls.map((m) => m.length)).toEqual([2, 2]);
  });
});
