/**
 * Site ozellik anahtarlari: `admin.assemblies` (genel kurul, yazili riza, tebligat; sakin portali) ve
 * `admin.tenders` (ihale; sakin portali) kapaliysa uclar 403 `feature_disabled`; bildirim worker'i
 * modulu kapali sitenin olaylarini gondermez (islenmis sayar). Varsayilanlar mevcut siteleri degistirmez.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { buildEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { AssemblyService } from '../src/modules/assemblies/service.js';
import { FEATURE_CATALOG, resolveFeatures } from '../src/modules/features/catalog.js';
import { staticSiteFeatureReader } from '../src/modules/features/guard.js';
import type { TenderService } from '../src/modules/tenders/service.js';
import { type Notification, createNotificationWorker, featureOfEvent } from '../src/workers/notification-worker.js';

const APT = 'apt-1';
const tok = (role: string) => `Bearer ${encodeMockToken({ sub: 'u1', role, apartmentId: APT })}`;
const stub = <T>() => new Proxy({}, { get: () => async () => ({ items: [] }) }) as T;

function app(off: Partial<Record<'admin.assemblies' | 'admin.tenders', boolean>>) {
  return createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    assemblyService: stub<AssemblyService>(),
    tenderService: stub<TenderService>(),
    siteFeatures: staticSiteFeatureReader(off),
  });
}

const get = async (a: ReturnType<typeof app>, path: string, role = 'apartment_manager') => {
  const res = await a.request(path, { headers: { authorization: tok(role) } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('ozellik anahtarlari', () => {
  it('varsayilan acik (eski ve sade profil): mevcut siteler degismez', () => {
    for (const key of ['admin.assemblies', 'admin.tenders'] as const) {
      expect(FEATURE_CATALOG[key].defaults).toEqual({ legacy: true, simple: true });
      expect(resolveFeatures(undefined)[key]).toBe(true);
      expect(resolveFeatures({ profile: 'simple', overrides: {} })[key]).toBe(true);
    }
  });

  it('genel kurul kapaliyken yonetim, yazili riza ve portal uclari 403; ihale etkilenmez', async () => {
    const a = app({ 'admin.assemblies': false });
    for (const path of ['/api/assemblies', '/api/assemblies/consents', '/api/assemblies/asm1/service']) {
      expect(await get(a, path)).toMatchObject({ status: 403, body: { error: 'feature_disabled', feature: 'admin.assemblies' } });
    }
    expect((await get(a, '/api/portal/assemblies', 'resident')).body).toMatchObject({ error: 'feature_disabled' });
    expect((await get(a, '/api/tenders')).status).toBe(200);
    expect((await get(app({}), '/api/assemblies')).status).toBe(200);
  });

  it('ihale kapaliyken yonetim ve portal uclari 403', async () => {
    const a = app({ 'admin.tenders': false });
    expect(await get(a, '/api/tenders')).toMatchObject({ status: 403, body: { error: 'feature_disabled', feature: 'admin.tenders' } });
    expect((await get(a, '/api/tenders/assembly-decisions')).status).toBe(403);
    expect((await get(a, '/api/portal/tenders', 'resident')).status).toBe(403);
    expect((await get(a, '/api/assemblies')).status).toBe(200);
  });

  it('ihale portali: genel kurul kapaliysa karar baglantisi (portalLink) verilmez', async () => {
    const tenderService = { portalGet: async () => ({ tender: { tenderId: 't1', assemblyDecision: { assemblyId: 'asm1', portalLink: true } } }) } as unknown as TenderService;
    const build = (off: boolean) =>
      createApp({ version: 'test', authenticate: createMockAuthenticator(), assemblyService: stub<AssemblyService>(), tenderService, siteFeatures: staticSiteFeatureReader({ 'admin.assemblies': !off }) });
    expect((await get(build(false), '/api/portal/tenders/t1', 'resident')).body).toMatchObject({ tender: { assemblyDecision: { portalLink: true } } });
    expect((await get(build(true), '/api/portal/tenders/t1', 'resident')).body).toMatchObject({ tender: { assemblyDecision: { portalLink: false } } });
  });

  it('worker: modulu kapali sitenin olayi gonderilmez, islenmis sayilir; diger olaylar etkilenmez', async () => {
    expect(featureOfEvent('ASSEMBLY_RESCHEDULED')).toBe('admin.assemblies');
    expect(featureOfEvent('TENDER_REPLIED')).toBe('admin.tenders');
    expect(featureOfEvent('POLL_PUBLISHED')).toBeUndefined();
    const sent: Notification[] = [];
    const processed: string[] = [];
    const logs: string[] = [];
    let reads = 0;
    const worker = createNotificationWorker({
      memberships: { list: async () => [] },
      core: { listUnits: async () => [] },
      roles: { list: async () => [] as ApartmentRole[] },
      assemblies: { get: async () => (reads++, undefined), getCall: async () => undefined, listCalls: async () => [] },
      tenders: { get: async () => (reads++, undefined), listComments: async () => [] },
      features: staticSiteFeatureReader({ 'admin.assemblies': false, 'admin.tenders': false }),
      notifier: { channel: 'test', send: async (n) => void sent.push(n) },
      isProcessed: async () => false,
      markProcessed: async (_a, id) => void processed.push(id),
      now: () => new Date('2026-11-27T09:00:00.000Z'),
      log: { info: (m: string) => void logs.push(m), error: () => {} },
    });
    const events = [
      buildEvent({ eventId: 'ASSEMBLY_CANCELLED:asm1', type: 'ASSEMBLY_CANCELLED', apartmentId: APT, actorId: 'm', payload: { assemblyId: 'asm1', scheduledAt: '2026-12-15T16:00:00.000Z', kind: 'ordinary' } }),
      buildEvent({ eventId: 'TENDER_PUBLISHED:t1', type: 'TENDER_PUBLISHED', apartmentId: APT, actorId: 'm', payload: { tenderId: 't1' } }),
    ];
    const res = await worker({ Records: events.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) });
    expect(res.batchItemFailures).toEqual([]);
    expect(sent).toEqual([]);
    expect(reads).toBe(0);
    expect(processed).toEqual(['ASSEMBLY_CANCELLED:asm1', 'TENDER_PUBLISHED:t1']);
    expect(logs.every((l) => JSON.parse(l).reason === 'feature_disabled')).toBe(true);
  });
});
