/**
 * Kategori bazli e-posta tercihleri: govde dogrulamasi, kayit bicimi (eski `ticketEmails` geriye
 * donuk), kismi guncellemede onceki secimin korunmasi, e-posta kanalinin her kategoriyi uygulamasi
 * (worker olay turunden kategori atar) ve `/api/me/notification-preferences` uclari.
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { type DomainEvent, EVENT_TYPES } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import type { Unit } from '../src/modules/core/types.js';
import { NOTIFICATION_CATEGORIES, type NotificationCategory, categoryOfEvent, categoryOfTemplate } from '../src/modules/notifications/categories.js';
import { createEmailNotifier } from '../src/modules/notifications/email.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import {
  type NotificationPreferences,
  type PreferencesRepository,
  createDynamoPreferencesRepository,
  createPreferencesService,
  parsePreferences,
} from '../src/modules/notifications/preferences.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createNotificationWorker } from '../src/workers/notification-worker.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-27T08:00:00.000Z');
const ts = NOW.toISOString();
const quiet = { info: () => {}, error: () => {} };

/** Her kategoriden bir sablon (oylama sablonu anket dalindan gelecek: on ek kurali). */
const SAMPLES: [Notification['template'], NotificationCategory][] = [
  ['payment_received', 'finance'],
  ['dues_batch_summary', 'finance'],
  ['dues_reminder_overdue_7', 'finance'],
  ['late_fee_posted', 'finance'],
  ['announcement_published', 'announcements'],
  ['ticket_comment', 'tickets'],
  ['operations_digest', 'tickets'],
  ['gate_courier_arrived', 'gate'],
  ['gate_guest_entered', 'gate'],
  ['reservation_rejected', 'reservations'],
  ['poll_published' as Notification['template'], 'polls'],
];

describe('kategori cozumleme', () => {
  it('her olay turunun bir kategorisi var; sablon on ekleri ayni kategoriye duser', () => {
    for (const type of EVENT_TYPES) expect(categoryOfEvent(type), type).toBeDefined();
    expect(categoryOfEvent('POLL_PUBLISHED')).toBe('polls');
    expect(categoryOfEvent('RESERVATION_CANCELLED')).toBe('reservations');
    expect(categoryOfEvent('OPERATIONS_DIGEST')).toBe('tickets');
    for (const [template, category] of SAMPLES) expect(categoryOfTemplate(template), template).toBe(category);
    expect(categoryOfTemplate('unknown_x')).toBeUndefined();
  });
});

describe('tercih govdesi ve kaydi', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('govde: alti kategori boolean; bilinmeyen alan ve boolean olmayan deger reddedilir', () => {
    const all = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, false]));
    expect(parsePreferences({ email: { enabled: true, ...all } })).toEqual({ email: { enabled: true, ...all } });
    expect(parsePreferences({ email: { enabled: true, gate: false } })).toEqual({ email: { enabled: true, gate: false } });
    for (const bad of [{ email: { enabled: true, gate: 'no' } }, { email: { enabled: true, sms: true } }, { email: { enabled: true, polls: null } }]) {
      expect(() => parsePreferences(bad)).toThrow(ValidationError);
    }
  });

  it('kayit: yalnizca secilen kategoriler `emailCategories` haritasinda; eski ticketEmails okunur, yeni harita onceliklidir', async () => {
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: { emailEnabled: true, ticketEmails: false, updatedAt: ts } })
      .resolvesOnce({ Item: { emailEnabled: true, ticketEmails: false, emailCategories: { tickets: true, gate: false, bogus: false }, updatedAt: ts } });
    const repo = createDynamoPreferencesRepository();
    expect(await repo.get('user-1')).toEqual({ email: { enabled: true, tickets: false }, updatedAt: ts });
    expect(await repo.get('user-1')).toEqual({ email: { enabled: true, tickets: true, gate: false }, updatedAt: ts });

    ddb.on(PutCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    await repo.put('user-1', { email: { enabled: true, reservations: false, finance: true }, updatedAt: ts });
    const put = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item ?? ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[0]?.Put?.Item;
    expect(put).toMatchObject({ PK: 'USER#user-1', SK: 'NOTIFPREF', emailEnabled: true, emailCategories: { finance: true, reservations: false } });
    expect(put).not.toHaveProperty('ticketEmails');
  });

  it('kismi guncelleme: verilmeyen kategoride onceki secim korunur; ana anahtar her istekte zorunlu', async () => {
    const store = new Map<string, NotificationPreferences>();
    const repository: PreferencesRepository = { get: async (u) => store.get(u) ?? { email: { enabled: true } }, put: async (u, p) => void store.set(u, p) };
    const service = createPreferencesService({ repository, now: () => NOW });
    await service.update('u', { email: { enabled: true, gate: false } });
    await service.update('u', { email: { enabled: true, reservations: false } });
    expect(await service.update('u', { email: { enabled: true, gate: true } })).toEqual({ email: { enabled: true, gate: true, reservations: false }, updatedAt: ts });
    // Eski istemci (yalnizca ana anahtar) kategori secimlerini silmez.
    expect((await service.update('u', { email: { enabled: false } })).email).toEqual({ enabled: false, gate: true, reservations: false });
  });
});

describe('e-posta kanali tercihleri uygular', () => {
  const notifier = (prefs: NotificationPreferences['email']) => {
    const sent: string[] = [];
    const n = createEmailNotifier({
      sender: { send: async (m) => (sent.push(m.tags.template ?? ''), { messageId: 'm' }) },
      preferences: { get: async () => ({ email: prefs }) },
      people: { get: async () => ({ email: 'a@b.co', fullName: 'A' }) as never },
      core: { getSite: async () => ({ name: 'Site' }) as never, listUnits: async () => [], listBlocks: async () => [] },
      sentLog: { has: async () => false, record: async () => {} },
      portalUrl: 'https://site.example/app',
      now: () => NOW,
      log: quiet,
    });
    return { n, sent };
  };
  const note = (template: Notification['template'], extra: Partial<Notification> = {}): Notification => ({
    eventId: 'E1',
    apartmentId: APT,
    userId: 'user-1',
    template,
    data: { unitId: 'u1', title: 'Başlık', ticketId: 't1', number: 'T-1', category: 'other', link: 'portal', respondBy: ts, enteredAt: ts, entryMode: 'single', date: '2026-11-29', start: ts, end: ts, facilityName: 'Salon', feeKurus: 0, feeStatus: 'none' },
    ...extra,
  });

  it('her kategori ayri kapatilir; digerleri etkilenmez; ana anahtar kapaliysa hicbiri', async () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const { n } = notifier({ enabled: true, [category]: false });
      for (const [template, cat] of SAMPLES) {
        const r = await n.send(note(template));
        if (cat === category) expect(r, `${category}/${template}`).toEqual({ status: 'skipped', reason: 'opted_out' });
        else expect(r && r.status === 'skipped' ? r.reason : 'sent', `${category}/${template}`).not.toBe('opted_out');
      }
    }
    const off = notifier({ enabled: false, finance: true });
    expect(await off.n.send(note('payment_received'))).toEqual({ status: 'skipped', reason: 'opted_out' });
  });

  it('bildirimdeki kategori (worker atar) sablon adindan once gelir', async () => {
    const { n } = notifier({ enabled: true, polls: false });
    expect(await n.send(note('announcement_published', { category: 'polls' }))).toEqual({ status: 'skipped', reason: 'opted_out' });
  });
});

describe('worker + tercih: kategoriyi kapatan sakine e-posta gitmez', () => {
  it('ziyaretci kapali: kurye bildirimi opted_out, ayni olayda digeri gider; olay islenmis sayilir', async () => {
    const memberships = [
      { userId: 'res-off', unitId: 'u1', apartmentId: APT, relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01' },
      { userId: 'res-on', unitId: 'u1', apartmentId: APT, relation: 'owner', residesInUnit: true, status: 'active', startDate: '2026-01-01' },
    ] as UnitMembership[];
    const sent: string[] = [];
    const logs: string[] = [];
    const email = createEmailNotifier({
      sender: { send: async (m) => (sent.push(m.to), { messageId: 'm' }) },
      preferences: { get: async (u) => ({ email: u === 'res-off' ? { enabled: true, gate: false } : { enabled: true } }) },
      people: { get: async (_a, u) => ({ email: `${u}@b.co`, fullName: u }) as never },
      core: { getSite: async () => ({ name: 'Site' }) as never, listUnits: async () => [], listBlocks: async () => [] },
      sentLog: { has: async () => false, record: async () => {} },
      now: () => NOW,
      log: quiet,
    });
    const processed = new Set<string>();
    const worker = createNotificationWorker({
      memberships: { list: async () => memberships },
      core: { listUnits: async () => [] as Unit[] },
      roles: { list: async () => [] as ApartmentRole[] },
      gate: { get: async <T,>() => ({ courierId: 'c1', unitId: 'u1', status: 'waiting', apartmentId: APT }) as T },
      reservations: { getBooking: async () => undefined },
      notifier: email,
      isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
      markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
      now: () => NOW,
      log: { info: (m: string) => void logs.push(m), error: () => {} },
    });
    const event = {
      eventId: 'GATE_COURIER_ARRIVED:c1',
      type: 'GATE_COURIER_ARRIVED',
      version: 1,
      occurredAt: '2026-11-27T07:59:00.000Z',
      apartmentId: APT,
      actorId: 'guard-1',
      groupKey: APT,
      payload: { courierId: 'c1', unitId: 'u1', respondBy: '2026-11-27T08:59:00.000Z' },
    } as DomainEvent;
    const res = await worker({ Records: [{ messageId: 'm1', body: JSON.stringify(event) }] });
    expect(res.batchItemFailures).toEqual([]);
    expect(sent).toEqual(['res-on@b.co']);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ recipients: 2, sent: 1, skippedRecipients: { opted_out: 1 } });
    expect(processed.has(`${APT}|GATE_COURIER_ARRIVED:c1`)).toBe(true);
  });
});

describe('/api/me/notification-preferences', () => {
  it('GET varsayilan; PUT tek kategori gonderir, digerleri korunur; baska kullanici etkilenmez', async () => {
    const store = new Map<string, NotificationPreferences>();
    const repository: PreferencesRepository = { get: async (u) => store.get(u) ?? { email: { enabled: true } }, put: async (u, p) => void store.set(u, p) };
    const app = createApp({
      version: 'test',
      authenticate: createMockAuthenticator(),
      identify: createMockIdentityResolver(),
      notificationPreferences: createPreferencesService({ repository, now: () => NOW }),
    });
    const call = (method: string, sub: string, body?: unknown) =>
      app.request('/api/me/notification-preferences', {
        method,
        headers: { authorization: `Bearer ${encodeMockToken({ sub, role: 'resident', apartmentId: APT })}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect(await (await call('GET', 'res-1')).json()).toEqual({ email: { enabled: true } });
    expect((await call('PUT', 'res-1', { email: { enabled: true, gate: false } })).status).toBe(200);
    const second = await call('PUT', 'res-1', { email: { enabled: true, polls: false } });
    expect(await second.json()).toEqual({ email: { enabled: true, gate: false, polls: false }, updatedAt: ts });
    expect(await (await call('GET', 'res-1')).json()).toMatchObject({ email: { enabled: true, gate: false, polls: false } });
    expect((await call('PUT', 'res-1', { email: { enabled: true, rezervasyon: false } })).status).toBe(400);
    expect(await (await call('GET', 'res-2')).json()).toEqual({ email: { enabled: true } });
  });
});
