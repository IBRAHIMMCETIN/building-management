import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { createCoreService, defaultSiteSettings } from '../src/modules/core/service.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import { renderReportPdf } from '../src/modules/documents/reportPdf.js';
import { categoryOfEvent, categoryOfTemplate } from '../src/modules/notifications/categories.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import { renderPush } from '../src/modules/notifications/push-templates.js';
import type { SupportService } from '../src/modules/support/service.js';
import {
  EntitlementError,
  assertStaffCapacity,
  assertUnitCapacity,
  checkRequest,
  createEntitlementReader,
  entitlementOf,
  featureForRequest,
  legacyEntitlementReader,
  staticEntitlementReader,
  withEntitlements,
} from '../src/modules/subscriptions/entitlements.js';
import { invoicePdfContent, invoicePdfHash, invoicePdfKey } from '../src/modules/subscriptions/invoicePdf.js';
import { type AdvanceInput, TransitionError, advance, applyAction } from '../src/modules/subscriptions/machine.js';
import { billingRecipients } from '../src/modules/subscriptions/notifications.js';
import { PLACEHOLDER_PLANS, parsePlanContent } from '../src/modules/subscriptions/plans.js';
import { addMonths, invoiceAmounts, periodBounds, priceLines, vatOf } from '../src/modules/subscriptions/pricing.js';
import { createMemorySubscriptionRepository, numberInvoices } from '../src/modules/subscriptions/repository.js';
import { createSubscriptionService } from '../src/modules/subscriptions/service.js';
import { PLAN_FEATURES, type PlanSnapshot, type Subscription, allFeatures, subscriptionGsi, subscriptionKeys } from '../src/modules/subscriptions/types.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import type { DomainEvent } from '../src/events/publisher.js';

// ---------------------------------------------------------------------------
// Ortak kurulum
// ---------------------------------------------------------------------------

const APT = 'apt-1';
const APT2 = 'apt-2';

function plan(over: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    code: 'standart',
    name: 'Standart',
    planVersion: 1,
    pricing: { model: 'flat', monthlyKurus: 100_000, annualKurus: 1_000_000, vatRateBps: 2000 },
    features: allFeatures(),
    limits: { maxUnits: null, maxStaffUsers: null },
    ...over,
  };
}

function sub(over: Partial<Subscription> = {}): Subscription {
  const status = over.status ?? 'trial';
  return {
    ...subscriptionKeys(APT),
    ...subscriptionGsi(status, APT),
    entityType: 'SUBSCRIPTION',
    apartmentId: APT,
    status,
    plan: plan(),
    billingPeriod: 'monthly',
    trialStartedAt: '2026-11-01',
    trialEndsAt: '2026-11-30',
    unitCountSnapshot: 10,
    graceDays: 14,
    paymentTermDays: 10,
    statusChangedAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    createdBy: 'p1',
    updatedAt: '2026-11-01T00:00:00.000Z',
    updatedBy: 'p1',
    version: 1,
    ...over,
  };
}

const run = (s: Subscription, day: string, invoices: AdvanceInput['invoices'] = [], unitCount = 10) => advance({ sub: s, day, invoices, unitCount });

function site(id: string, name: string): Site {
  return {
    PK: `APT#${id}`,
    SK: 'SITE',
    entityType: 'SITE',
    siteId: id,
    tenantId: 't',
    name,
    type: 'site',
    address: { line1: 'x', district: 'Kayapınar', city: 'Diyarbakır' },
    fiscalYearStartMonth: 1,
    settings: defaultSiteSettings(),
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 1,
  } as Site;
}

const unit = (apt: string, id: string, status: 'active' | 'inactive' = 'active') => ({ unitId: id, siteId: apt, status }) as Unit;
const role = (apt: string, userId: string, r: ApartmentRole['role'], over: Partial<ApartmentRole> = {}) =>
  ({ apartmentId: apt, userId, role: r, status: 'active', startDate: '2026-01-01', ...over }) as ApartmentRole;

function fixture(now: { value: Date }) {
  const mem = createMemorySubscriptionRepository();
  const docs = createMemoryDocumentStore();
  const units = new Map<string, Unit[]>([
    [APT, Array.from({ length: 12 }, (_, i) => unit(APT, `u${i}`))],
    [APT2, [unit(APT2, 'x1')]],
  ]);
  const roles = new Map<string, ApartmentRole[]>([
    [APT, [role(APT, 'm1', 'apartment_manager'), role(APT, 's1', 'building_staff')]],
    [APT2, [role(APT2, 'm2', 'apartment_manager')]],
  ]);
  const invalidated: string[] = [];
  const service = createSubscriptionService({
    repository: mem.repo,
    core: {
      getSite: async (id) => (id === APT ? site(APT, 'Gül Sitesi') : id === APT2 ? site(APT2, 'Lale Apt.') : undefined),
      listSiteIds: async () => [APT, APT2, 'apt-3'],
      listUnits: async (id) => units.get(id) ?? [],
    },
    roles: { list: async (id) => roles.get(id) ?? [] },
    store: docs.store,
    invalidate: (id) => invalidated.push(id),
    now: () => now.value,
  });
  return { service, mem, docs, units, roles, invalidated };
}

const at = (iso: string) => new Date(`${iso}T09:00:00+03:00`);

// ---------------------------------------------------------------------------
// Fiyat ve KDV
// ---------------------------------------------------------------------------

describe('abonelik fiyati ve KDV', () => {
  it('KDV toplam matrah uzerinden yarim yukari yuvarlanir (kurus, kayan nokta yok)', () => {
    expect(vatOf(100_000, 2000)).toBe(20_000);
    expect(vatOf(33_333, 2000)).toBe(6_667); // 6666,6 -> 6667
    expect(vatOf(12_345, 2000)).toBe(2_469); // 2469,0
    expect(vatOf(5, 1000)).toBe(1); // 0,5 -> 1
    expect(vatOf(4, 1000)).toBe(0); // 0,4 -> 0
    expect(vatOf(0, 2000)).toBe(0);
    expect(() => vatOf(1.5, 2000)).toThrow();
    expect(invoiceAmounts([{ description: 'a', quantity: 1, unitPriceKurus: 33_333, amountKurus: 33_333 }], 2000)).toEqual({ netKurus: 33_333, vatRateBps: 2000, vatKurus: 6_667, totalKurus: 40_000 });
  });

  it('sabit, bolum basi ve kademeli fiyat satirlari', () => {
    expect(priceLines(plan(), 'monthly', 40)).toEqual([{ description: 'Standart (aylık)', quantity: 1, unitPriceKurus: 100_000, amountKurus: 100_000 }]);
    expect(priceLines(plan(), 'annual', 40)[0]!.amountKurus).toBe(1_000_000);
    const perUnit = plan({ pricing: { model: 'per_unit', monthlyKurus: 25_000, annualKurus: 250_000, perUnitMonthlyKurus: 1_200, perUnitAnnualKurus: 12_000, vatRateBps: 2000 } });
    const lines = priceLines(perUnit, 'monthly', 40);
    expect(lines.map((l) => l.amountKurus)).toEqual([25_000, 48_000]);
    expect(lines[1]).toMatchObject({ quantity: 40, unitPriceKurus: 1_200 });
    const tiered = plan({
      pricing: {
        model: 'tiered',
        monthlyKurus: 0,
        annualKurus: 0,
        vatRateBps: 2000,
        tiers: [
          { maxUnits: 250, monthlyKurus: 150_000, annualKurus: 1_500_000 },
          { maxUnits: 1000, monthlyKurus: 350_000, annualKurus: 3_500_000 },
          { maxUnits: null, monthlyKurus: 600_000, annualKurus: 6_000_000 },
        ],
      },
    });
    expect(priceLines(tiered, 'monthly', 250)[0]!.amountKurus).toBe(150_000);
    expect(priceLines(tiered, 'monthly', 251)[0]!.amountKurus).toBe(350_000);
    expect(priceLines(tiered, 'annual', 5000)[0]!.amountKurus).toBe(6_000_000);
    // Bedelsiz plan: satir yok.
    expect(priceLines(plan({ pricing: { model: 'flat', monthlyKurus: 0, annualKurus: 0, vatRateBps: 2000 } }), 'monthly', 10)).toEqual([]);
  });

  it('donemler tabandan turetilir: ay sonu kaymasi yok', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(periodBounds('2026-01-31', 0, 'monthly')).toEqual({ start: '2026-01-31', end: '2026-02-27' });
    expect(periodBounds('2026-01-31', 2, 'monthly')).toEqual({ start: '2026-03-31', end: '2026-04-29' });
    expect(periodBounds('2026-12-01', 0, 'annual')).toEqual({ start: '2026-12-01', end: '2027-11-30' });
  });

  it('plan dogrulamasi: kademe sirasi, sinirsiz yalnizca son kademe, bilinmeyen ozellik', () => {
    const ok = parsePlanContent({ code: 'Test-1', name: 'Test', pricing: { model: 'flat', monthlyKurus: 100, annualKurus: 1000 }, features: { gate: true } });
    expect(ok).toMatchObject({ code: 'test-1', trialDays: 30, pricing: { vatRateBps: 2000 }, limits: { maxUnits: null, maxStaffUsers: null } });
    expect(ok.features.gate).toBe(true);
    expect(ok.features.tenders).toBe(false);
    expect(() => parsePlanContent({ code: 'x1', name: 'XX', pricing: { model: 'flat', monthlyKurus: 1.5, annualKurus: 1 } })).toThrow(/kuruş/);
    expect(() =>
      parsePlanContent({ code: 'x1', name: 'XX', pricing: { model: 'tiered', tiers: [{ maxUnits: null, monthlyKurus: 1, annualKurus: 1 }, { maxUnits: 10, monthlyKurus: 1, annualKurus: 1 }] } }),
    ).toThrow(/sonuncusu/);
    expect(() => parsePlanContent({ code: 'x1', name: 'XX', pricing: { model: 'flat', monthlyKurus: 1, annualKurus: 1 }, features: { sms: true } })).toThrow(/Bilinmeyen/);
    expect(PLACEHOLDER_PLANS.every((p) => p.placeholder)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Durum makinesi
// ---------------------------------------------------------------------------

describe('abonelik durum makinesi (tarih bazli)', () => {
  it('deneme bitis bildirimleri 7 ve 1 gun kala, her biri bir kez', () => {
    const d23 = run(sub(), '2026-11-23');
    expect(d23.events.map((e) => e.eventId)).toEqual(['SUBSCRIPTION_TRIAL_ENDING:apt-1:2026-11-30:7']);
    expect(d23.sub.notices).toEqual({ trial7: '2026-11-23' });
    expect(run(d23.sub, '2026-11-24').changed).toBe(false);
    const d29 = run(d23.sub, '2026-11-29');
    expect(d29.events).toEqual([expect.objectContaining({ type: 'SUBSCRIPTION_TRIAL_ENDING', payload: expect.objectContaining({ daysLeft: 1 }) })]);
    expect(run(d29.sub, '2026-11-30').events).toEqual([]);
    // Bildirim kacirildiysa (gec calisma) yalnizca 1 gun bildirimi gider, 7 gun sonradan gitmez.
    const late = run(sub(), '2026-11-30');
    expect(late.events.map((e) => (e.type === 'SUBSCRIPTION_TRIAL_ENDING' ? e.payload.daysLeft : -1))).toEqual([0]);
    expect(run(late.sub, '2026-11-30').changed).toBe(false);
  });

  it('deneme bitince ilk donem baslar ve fatura kesilir; ayni gun tekrari degisiklik uretmez', () => {
    const r = run(sub(), '2026-12-01');
    expect(r.transitions).toEqual([{ from: 'trial', to: 'active', reason: 'trial_ended' }]);
    expect(r.sub).toMatchObject({ status: 'active', billingAnchor: '2026-12-01', periodIndex: 0, currentPeriodStart: '2026-12-01', currentPeriodEnd: '2026-12-31', GSI1SK: 'active#apt-1' });
    expect(r.invoices).toEqual([expect.objectContaining({ invoiceId: '2026-12-01', dueDate: '2026-12-11', netKurus: 100_000, vatKurus: 20_000, totalKurus: 120_000, unitCount: 10 })]);
    const again = run(r.sub, '2026-12-01', [{ invoiceId: '2026-12-01', dueDate: '2026-12-11', status: 'issued', totalKurus: 120_000 }]);
    expect(again.changed).toBe(false);
    expect(again.invoices).toEqual([]);
  });

  it('vade gecince past_due, ek sure dolunca suspended; odeme gelince yeniden acilir', () => {
    const active = run(sub(), '2026-12-01').sub;
    const open = [{ invoiceId: '2026-12-01', dueDate: '2026-12-11', status: 'issued' as const, totalKurus: 120_000 }];
    expect(run(active, '2026-12-11', open).changed).toBe(false);
    const pd = run(active, '2026-12-12', open);
    expect(pd.sub).toMatchObject({ status: 'past_due', pastDueSince: '2026-12-12' });
    expect(pd.events).toEqual([expect.objectContaining({ type: 'SUBSCRIPTION_PAST_DUE', payload: { pastDueSince: '2026-12-12', suspendOn: '2026-12-26', overdueTotalKurus: 120_000, invoiceCount: 1 } })]);
    expect(run(pd.sub, '2026-12-25', open).sub.status).toBe('past_due');
    const susp = run(pd.sub, '2026-12-26', open);
    expect(susp.sub).toMatchObject({ status: 'suspended', suspendedAt: '2026-12-26', suspendedReason: 'non_payment' });
    expect(susp.events.map((e) => e.type)).toEqual(['SUBSCRIPTION_SUSPENDED']);
    // Askida yeni donem faturasi kesilmez.
    expect(run(susp.sub, '2027-01-05', open).invoices).toEqual([]);
    // Odeme: yeniden acilir, askida biten donem yenilenir.
    const paid = [{ ...open[0]!, status: 'paid' as const }];
    const re = run(susp.sub, '2027-01-05', paid);
    expect(re.sub.status).toBe('active');
    expect(re.events.map((e) => e.type)).toEqual(['SUBSCRIPTION_REACTIVATED']);
    expect(re.invoices.map((i) => i.invoiceId)).toEqual(['2027-01-01']);
    expect(re.sub.pastDueSince).toBeUndefined();
  });

  it('past_due iken odeme: active, olay yok', () => {
    const active = run(sub(), '2026-12-01').sub;
    const pd = run(active, '2026-12-12', [{ invoiceId: '2026-12-01', dueDate: '2026-12-11', status: 'issued', totalKurus: 1 }]).sub;
    const r = run(pd, '2026-12-13', [{ invoiceId: '2026-12-01', dueDate: '2026-12-11', status: 'paid', totalKurus: 1 }]);
    expect(r.sub.status).toBe('active');
    expect(r.events).toEqual([]);
  });

  it('kacirilmis gunler tek calismada yakalanir (donem yenileme + vade)', () => {
    const active = run(sub(), '2026-12-01').sub;
    const r = run(active, '2027-02-15', [{ invoiceId: '2026-12-01', dueDate: '2026-12-11', status: 'paid', totalKurus: 1 }]);
    expect(r.invoices.map((i) => i.invoiceId)).toEqual(['2027-01-01', '2027-02-01']);
    expect(r.sub).toMatchObject({ periodIndex: 2, currentPeriodEnd: '2027-02-28', status: 'past_due' });
  });

  it('bedelsiz plan fatura kesmez ve vadesi gecmez', () => {
    const free = sub({ plan: plan({ pricing: { model: 'flat', monthlyKurus: 0, annualKurus: 0, vatRateBps: 2000 } }) });
    const r = run(free, '2027-03-01');
    expect(r.sub.status).toBe('active');
    expect(r.invoices).toEqual([]);
  });

  it('elle gecisler: uzatma, erken etkinlestirme, askiya alma (kendiliginden acilmaz), iptal ve iptalden donus', () => {
    const ext = applyAction({ sub: sub({ notices: { trial7: '2026-11-23' } }), day: '2026-11-25', invoices: [], unitCount: 5, action: 'extend_trial', trialEndsAt: '2026-12-31' });
    expect(ext.sub).toMatchObject({ status: 'trial', trialEndsAt: '2026-12-31' });
    expect(ext.sub.notices).toBeUndefined();
    expect(() => applyAction({ sub: sub(), day: '2026-11-25', invoices: [], unitCount: 5, action: 'extend_trial', trialEndsAt: '2026-11-20' })).toThrow(TransitionError);

    const act = applyAction({ sub: sub(), day: '2026-11-10', invoices: [], unitCount: 5, action: 'activate' });
    expect(act.sub).toMatchObject({ status: 'active', billingAnchor: '2026-11-10', currentPeriodEnd: '2026-12-09', trialEndsAt: '2026-11-09' });
    expect(act.invoices).toHaveLength(1);

    const manual = applyAction({ sub: act.sub, day: '2026-11-12', invoices: [], unitCount: 5, action: 'suspend' });
    expect(manual.sub).toMatchObject({ status: 'suspended', suspendedReason: 'manual' });
    // Odenmemis fatura yok ama elle askiya alinmis: gunluk is acmaz.
    expect(run(manual.sub, '2026-11-13').sub.status).toBe('suspended');

    const cancelled = applyAction({ sub: manual.sub, day: '2026-11-14', invoices: [], unitCount: 5, action: 'cancel' });
    expect(cancelled.sub).toMatchObject({ status: 'cancelled', cancelledAt: '2026-11-14', GSI1SK: 'cancelled#apt-1' });
    expect(() => applyAction({ sub: cancelled.sub, day: '2026-11-14', invoices: [], unitCount: 5, action: 'suspend' })).toThrow(/iptal edilmiş/);

    const back = applyAction({ sub: cancelled.sub, day: '2026-11-20', invoices: [{ invoiceId: '2026-11-10', dueDate: '2026-11-20', status: 'paid', totalKurus: 1 }], unitCount: 7, action: 'reactivate' });
    expect(back.sub).toMatchObject({ status: 'active', billingAnchor: '2026-11-20', periodIndex: 0, unitCountSnapshot: 7 });
    expect(back.events.map((e) => e.type)).toEqual(['SUBSCRIPTION_REACTIVATED']);
    expect(back.invoices.map((i) => i.invoiceId)).toEqual(['2026-11-20']);
  });

  it('elle yeniden acmada odenmemis fatura icin ek sure bugunden baslar', () => {
    const active = run(sub(), '2026-12-01').sub;
    const open = [{ invoiceId: '2026-12-01', dueDate: '2026-12-11', status: 'issued' as const, totalKurus: 1 }];
    const susp = run(run(active, '2026-12-12', open).sub, '2026-12-26', open).sub;
    const back = applyAction({ sub: susp, day: '2026-12-28', invoices: open, unitCount: 10, action: 'reactivate' });
    expect(back.sub).toMatchObject({ status: 'past_due', pastDueSince: '2026-12-28' });
    expect(run(back.sub, '2027-01-10', open).sub.status).toBe('past_due');
    expect(run(back.sub, '2027-01-11', open).sub.status).toBe('suspended');
  });
});

// ---------------------------------------------------------------------------
// Yetki kurallari
// ---------------------------------------------------------------------------

describe('abonelik yetkileri (entitlement)', () => {
  const suspended = entitlementOf(sub({ status: 'suspended' }));
  const noTenders = entitlementOf(sub({ status: 'active', plan: plan({ features: { ...allFeatures(), tenders: false, bulk_jobs: false } }) }));

  it('legacy (abonelik kaydi yok): her sey acik, limit yok', () => {
    const legacy = entitlementOf(undefined);
    expect(legacy).toMatchObject({ legacy: true, status: 'legacy', readOnly: false, limits: { maxUnits: null, maxStaffUsers: null } });
    expect(PLAN_FEATURES.every((f) => legacy.features[f])).toBe(true);
    expect(checkRequest(legacy, { method: 'POST', path: '/api/tenders' })).toBeUndefined();
  });

  it('askida: yazimlar 423, okumalar / sakin portali / abonelik ekrani / zincir dogrulamasi acik', () => {
    const err = checkRequest(suspended, { method: 'POST', path: '/api/announcements' });
    expect(err).toBeInstanceOf(EntitlementError);
    expect(err).toMatchObject({ code: 'subscription_read_only', httpStatus: 423 });
    expect(err?.message).toMatch(/salt okunur/);
    expect(checkRequest(suspended, { method: 'DELETE', path: '/api/sites/apt-1/units/u1' })?.code).toBe('subscription_read_only');
    expect(checkRequest(suspended, { method: 'GET', path: '/api/finance/reports/trial-balance' })).toBeUndefined();
    expect(checkRequest(suspended, { method: 'POST', path: '/api/portal/payments/intents' })).toBeUndefined();
    expect(checkRequest(suspended, { method: 'POST', path: '/api/portal/tickets' })).toBeUndefined();
    expect(checkRequest(suspended, { method: 'POST', path: '/api/audit/verify' })).toBeUndefined();
    expect(checkRequest(suspended, { method: 'GET', path: '/api/subscription' })).toBeUndefined();
    // Onek benzerligi: /api/portalx portal degildir.
    expect(checkRequest(suspended, { method: 'POST', path: '/api/portalx' })?.code).toBe('subscription_read_only');
    expect(entitlementOf(sub({ status: 'cancelled' })).readOnly).toBe(true);
    expect(entitlementOf(sub({ status: 'past_due' })).readOnly).toBe(false);
  });

  it('plan ozelligi kapali modul 403 feature_not_in_plan (okuma dahil); toplu is yalnizca baslatmada', () => {
    expect(checkRequest(noTenders, { method: 'GET', path: '/api/tenders' })).toMatchObject({ code: 'feature_not_in_plan', httpStatus: 403, details: { feature: 'tenders' } });
    expect(checkRequest(noTenders, { method: 'GET', path: '/api/portal/tenders/t1' })?.code).toBe('feature_not_in_plan');
    expect(checkRequest(noTenders, { method: 'POST', path: '/api/finance/dues/jobs' })?.code).toBe('feature_not_in_plan');
    expect(checkRequest(noTenders, { method: 'POST', path: '/api/finance/dues' })).toBeUndefined();
    expect(checkRequest(noTenders, { method: 'GET', path: '/api/jobs/j1' })).toBeUndefined();
    expect(featureForRequest('GET', '/api/gate/plates')).toBe('gate');
    expect(featureForRequest('GET', '/api/gateway')).toBeUndefined();
  });

  it('sarmalayici: dogrudan platform_admin muaf, destek oturumu ve apartmansiz istek', async () => {
    const reader = staticEntitlementReader(suspended);
    const call = async (claims: Record<string, unknown> | null, method = 'POST', path = '/api/announcements') => {
      const auth = withEntitlements(() => claims as never, reader);
      const headers = new Map<string, string>();
      const c = { req: { method, path }, header: (k: string, v: string) => headers.set(k, v) } as never;
      try {
        return { claims: await auth(c), headers };
      } catch (err) {
        return { err, headers };
      }
    };
    expect((await call({ userId: 'p', role: 'platform_admin', apartmentId: APT })).claims).toBeTruthy();
    expect((await call({ userId: 'p', role: 'observer', apartmentId: APT, supportSessionId: 's' })).err).toBeInstanceOf(EntitlementError);
    const blocked = await call({ userId: 'm', role: 'apartment_manager', apartmentId: APT });
    expect(blocked.err).toBeInstanceOf(EntitlementError);
    expect(blocked.headers.get('Cache-Control')).toBe('no-store');
    expect((await call({ userId: 'p', role: 'platform_admin' })).claims).toBeTruthy();
    expect((await call(null)).claims).toBeNull();
  });

  it('okuma onbellegi (TTL) ve hata: varsayilan fail closed, acikca istenirse fail open', async () => {
    let t = 0;
    const get = vi.fn(async () => sub({ status: 'suspended' }));
    const reader = createEntitlementReader({ getSubscription: get, ttlMs: 1000, now: () => t });
    expect((await reader.resolve(APT)).readOnly).toBe(true);
    await reader.resolve(APT);
    expect(get).toHaveBeenCalledTimes(1);
    t = 1500;
    await reader.resolve(APT);
    expect(get).toHaveBeenCalledTimes(2);
    reader.invalidate(APT);
    await reader.resolve(APT);
    expect(get).toHaveBeenCalledTimes(3);

    const boom = async () => {
      throw new Error('ddb down');
    };
    await expect(createEntitlementReader({ getSubscription: boom }).resolve(APT)).rejects.toThrow('ddb down');
    const log = { error: vi.fn() };
    expect(await createEntitlementReader({ getSubscription: boom, failOpen: true, log }).resolve(APT)).toMatchObject({ legacy: true });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('bolum ve ekip limitleri (legacy sinirsiz)', async () => {
    const limited = staticEntitlementReader(entitlementOf(sub({ status: 'active', plan: plan({ limits: { maxUnits: 12, maxStaffUsers: 2 } }) })));
    await expect(assertUnitCapacity(limited, APT, 12)).resolves.toBeUndefined();
    await expect(assertUnitCapacity(limited, APT, 13)).rejects.toMatchObject({ code: 'plan_limit_exceeded', httpStatus: 403, details: { limit: 'maxUnits', max: 12, current: 12 } });
    await expect(assertStaffCapacity(limited, APT, 3)).rejects.toMatchObject({ details: { limit: 'maxStaffUsers', max: 2 } });
    await expect(assertUnitCapacity(legacyEntitlementReader, APT, 100_000)).resolves.toBeUndefined();
  });

  it('bolum ekleme ve toplu aktarim ayni cekirdek kuraldan gecer (403 plan_limit_exceeded)', async () => {
    const units: Unit[] = [unit(APT, 'a'), unit(APT, 'b'), unit(APT, 'c', 'inactive')];
    const block = { blockId: 'b1', siteId: APT, status: 'active', name: 'A' } as Block;
    const repo = {
      getSite: async () => site(APT, 'Gül'),
      getBlock: async () => block,
      listUnits: async () => units,
      createUnit: async (u: Unit) => void units.push(u),
    } as unknown as CoreRepository;
    const reader = staticEntitlementReader(entitlementOf(sub({ status: 'active', plan: plan({ limits: { maxUnits: 3, maxStaffUsers: null } }) })));
    const core = createCoreService({ repository: repo, assertUnitCapacity: (apt, n) => assertUnitCapacity(reader, apt, n) });
    const input = (n: string) => ({ blockId: 'b1', number: n, type: 'flat', grossAreaM2: 90 });
    await core.createUnit('m1', APT, input('3'));
    await expect(core.createUnit('m1', APT, input('4'))).rejects.toMatchObject({ code: 'plan_limit_exceeded' });
    expect(units.filter((u) => u.status === 'active')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Servis (bellek ici depo)
// ---------------------------------------------------------------------------

describe('abonelik servisi', () => {
  const platform = { userId: 'p1' };

  it('ornek planlar, idempotent abonelik baslatma, gunluk ilerleme, numara serisi, odeme ve denetim', async () => {
    const now = { value: at('2026-11-01') };
    const f = fixture(now);
    expect((await f.service.seedPlaceholderPlans(platform)).created).toEqual(['pilot', 'temel', 'standart', 'profesyonel']);
    expect((await f.service.seedPlaceholderPlans(platform)).created).toEqual([]);

    const body = { idempotencyKey: 'start-apt-1-0001', planCode: 'standart' };
    const started = await f.service.startSubscription(platform, APT, body);
    expect(started.created).toBe(true);
    expect(started.subscription).toMatchObject({ status: 'trial', trialStartedAt: '2026-11-01', trialEndsAt: '2026-11-30', unitCountSnapshot: 12, version: 1 });
    expect((await f.service.startSubscription(platform, APT, body)).created).toBe(false);
    await expect(f.service.startSubscription(platform, APT, { ...body, idempotencyKey: 'start-apt-1-0002' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.invalidated).toContain(APT);

    // Ikinci apartman denemesiz: ilk donem bugun, fatura no 1.
    const second = await f.service.startSubscription(platform, APT2, { idempotencyKey: 'start-apt-2-0001', planCode: 'temel', trialDays: 0 });
    expect(second.subscription).toMatchObject({ status: 'active', currentPeriodStart: '2026-11-01', currentPeriodEnd: '2026-11-30' });
    expect(second.invoices?.map((i) => i.invoiceNumber)).toEqual(['YNS-2026-000001']);
    expect(second.invoices?.[0]).toMatchObject({ unitCount: 1, netKurus: 1_500, vatKurus: 300, totalKurus: 1_800, siteName: 'Lale Apt.' });

    now.value = at('2026-12-01');
    const d1 = await f.service.runDaily(APT, '2026-12-01');
    expect(d1).toMatchObject({ status: 'updated', subscriptionStatus: 'active', transitions: ['trial->active'], invoices: ['YNS-2026-000002'] });
    expect(await f.service.runDaily(APT, '2026-12-01')).toMatchObject({ status: 'unchanged' });
    expect(await f.service.runDaily('apt-3', '2026-12-01')).toEqual({ status: 'skipped', reason: 'legacy' });

    // Olaylar: deterministik kimlik, ayni atomik yazimda (outbox).
    const types = f.mem.events.filter((e) => e.apartmentId === APT).map((e) => e.eventId);
    expect(types).toContain('SUBSCRIPTION_INVOICE_ISSUED:apt-1:2026-12-01');
    const issued = f.mem.events.find((e) => e.eventId === 'SUBSCRIPTION_INVOICE_ISSUED:apt-1:2026-12-01');
    // Standart (ornek): 250,00 TL + 12 bolum x 12,00 TL = 394,00 TL + %20 KDV = 472,80 TL.
    expect(issued?.payload).toMatchObject({ invoiceNumber: 'YNS-2026-000002', totalKurus: 47_280, dueDate: '2026-12-11' });

    // Gecikme ve askiya alma.
    now.value = at('2026-12-12');
    expect(await f.service.runDaily(APT, '2026-12-12')).toMatchObject({ subscriptionStatus: 'past_due' });
    now.value = at('2026-12-26');
    expect(await f.service.runDaily(APT, '2026-12-26')).toMatchObject({ subscriptionStatus: 'suspended' });
    expect(f.mem.events.map((e) => e.type)).toEqual(expect.arrayContaining(['SUBSCRIPTION_PAST_DUE', 'SUBSCRIPTION_SUSPENDED']));

    // Odendi: surum kosullu; abonelik ayni yazimda acilir.
    const inv = (await f.mem.repo.listInvoices(APT))[0]!;
    await expect(f.service.markPaid(platform, APT, inv.invoiceId, { version: 99, method: 'bank_transfer', reference: 'EFT-123' })).rejects.toMatchObject({ code: 'conflict' });
    const paid = await f.service.markPaid(platform, APT, inv.invoiceId, { version: inv.version, method: 'bank_transfer', reference: 'EFT-123', paidOn: '2026-12-26' });
    expect(paid.invoice).toMatchObject({ status: 'paid', paymentReference: 'EFT-123', paidOn: '2026-12-26', paidBy: 'p1', version: 2 });
    expect(paid.subscription.status).toBe('active');
    expect(f.mem.events.some((e) => e.type === 'SUBSCRIPTION_REACTIVATED')).toBe(true);
    await expect(f.service.markPaid(platform, APT, inv.invoiceId, { version: 2, method: 'cash', reference: 'x123' })).rejects.toMatchObject({ code: 'invalid_transition' });

    // Denetim: her durum degisikligi apartman kapsaminda.
    const actions = f.mem.audits.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['subscription.plan.create', 'subscription.start', 'subscription.advance', 'subscription.invoice.paid']));
    expect(f.mem.audits.filter((a) => a.action === 'subscription.advance').every((a) => a.systemActor && a.apartmentId === APT)).toBe(true);
    expect(f.mem.audits.find((a) => a.action === 'subscription.plan.create')?.apartmentId).toBeUndefined();
  });

  it('plan surumleri: duzenleme yeni surum, mevcut abonelik eski anlik goruntuyu korur; arsiv yeni aboneligi engeller', async () => {
    const now = { value: at('2026-11-01') };
    const f = fixture(now);
    await f.service.seedPlaceholderPlans(platform);
    await f.service.startSubscription(platform, APT, { idempotencyKey: 'start-apt-1-0001', planCode: 'temel' });
    const head = (await f.service.getPlan('temel')).plan;
    const updated = await f.service.updatePlan(platform, 'temel', {
      version: head.version,
      reason: 'Fiyat güncellemesi',
      name: 'Temel',
      pricing: { model: 'per_unit', monthlyKurus: 0, annualKurus: 0, perUnitMonthlyKurus: 2_000, perUnitAnnualKurus: 20_000 },
      features: { online_payment: true },
      limits: { maxUnits: 100, maxStaffUsers: 5 },
    });
    expect(updated).toMatchObject({ planVersion: 2, version: 2, placeholder: false });
    expect((await f.service.getPlan('temel')).versions.map((v) => v.planVersion)).toEqual([2, 1]);
    const detail = await f.service.subscriptionDetail(APT);
    expect(detail.subscription?.plan).toMatchObject({ planVersion: 1, pricing: { perUnitMonthlyKurus: 1_500 } });
    await expect(f.service.updatePlan(platform, 'temel', { version: 1, reason: 'eski sürüm', name: 'X', pricing: { model: 'flat', monthlyKurus: 1, annualKurus: 1 } })).rejects.toMatchObject({ code: 'conflict' });
    await f.service.setPlanStatus(platform, 'temel', { version: 2, status: 'archived', reason: 'Satıştan kaldırıldı' });
    await expect(f.service.startSubscription(platform, APT2, { idempotencyKey: 'start-apt-2-0001', planCode: 'temel' })).rejects.toMatchObject({ code: 'conflict' });
    // Plan degisikligi: ozellik / limit hemen.
    const sub1 = (await f.service.subscriptionDetail(APT)).subscription!;
    const changed = await f.service.changePlan(platform, APT, { version: sub1.version, planCode: 'profesyonel', reason: 'Yükseltme talebi' });
    expect(changed.plan).toMatchObject({ code: 'profesyonel', limits: { maxUnits: null } });
  });

  it('numara serisi: yil bazli, bosluksuz; sayac yarisinda tekrar', () => {
    const base = { issueDate: '2026-12-01' } as never;
    const r = numberInvoices([base, { issueDate: '2027-01-01' } as never, { issueDate: '2026-12-15' } as never], new Map([['2026', 41]]));
    expect(r.numbered.map((i) => i.invoiceNumber)).toEqual(['YNS-2026-000042', 'YNS-2027-000001', 'YNS-2026-000043']);
    expect(r.updates).toEqual([
      { year: '2026', from: 41, to: 43 },
      { year: '2027', from: 0, to: 1 },
    ]);
  });

  it('kiraci izolasyonu ve PDF: fatura apartman anahtariyla; S3 apartman oneki; yonetici gorunumu', async () => {
    const now = { value: at('2026-11-01') };
    const f = fixture(now);
    await f.service.seedPlaceholderPlans(platform);
    await f.service.startSubscription(platform, APT2, { idempotencyKey: 'start-apt-2-0001', planCode: 'temel', trialDays: 0 });
    await expect(f.service.invoicePdf(APT, '2026-11-01')).rejects.toMatchObject({ code: 'not_found' });
    const pdf = await f.service.invoicePdf(APT2, '2026-11-01');
    expect(pdf.url).toMatch(/^memory:\/\/get\/apartments\/apt-2\/billing\/2026\/11\/subscription-invoice-YNS-2026-000001-[0-9a-f]{16}\.pdf/);
    expect(pdf.fileName).toBe('Abonelik faturası YNS-2026-000001.pdf');
    expect([...f.docs.objects.keys()].every((k) => k.startsWith('apartments/apt-2/billing/'))).toBe(true);
    // Ayni icerik ikinci kez uretilmez.
    await f.service.invoicePdf(APT2, '2026-11-01');
    expect(f.docs.objects.size).toBe(1);

    const view = await f.service.managerView(APT2);
    expect(view).toMatchObject({ status: 'active', legacy: false, readOnly: false, usage: { units: 1, staffUsers: 1 }, limits: { maxUnits: 100, maxStaffUsers: 5 } });
    expect(view.invoices).toHaveLength(1);
    expect(view.invoices[0]).not.toHaveProperty('paidBy');
    expect(await f.service.managerView(APT)).toMatchObject({ status: 'legacy', legacy: true, invoices: [] });

    const list = await f.service.listSubscriptions();
    expect(list.items.map((i) => [i.apartmentId, i.status])).toEqual([
      [APT, 'legacy'],
      [APT2, 'active'],
    ]);
    expect(list.counts).toMatchObject({ legacy: 1, active: 1 });
    expect((await f.service.listSubscriptions({ status: 'legacy' })).items.map((i) => i.apartmentId)).toEqual([APT]);
  });

  it('fatura PDF icerigi gomulu fontla uretilir (Turkce karakter, KDV satirlari)', async () => {
    const inv = {
      ...subscriptionKeys(APT),
      apartmentId: APT,
      invoiceId: '2026-12-01',
      invoiceNumber: 'YNS-2026-000002',
      siteName: 'Gül Sitesi',
      status: 'issued',
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      billingPeriod: 'monthly',
      planCode: 'standart',
      planVersion: 1,
      planName: 'Standart',
      unitCount: 12,
      lines: [{ description: 'Standart (aylık)', quantity: 1, unitPriceKurus: 100_000, amountKurus: 100_000 }],
      netKurus: 100_000,
      vatRateBps: 2000,
      vatKurus: 20_000,
      totalKurus: 120_000,
      issueDate: '2026-12-01',
      dueDate: '2026-12-11',
    } as never;
    const content = invoicePdfContent(inv);
    expect(content.sections[1]!.rows.at(-1)!.cells).toEqual(['Genel toplam', '', '', '1.200,00 ₺']);
    expect(invoicePdfKey(inv, invoicePdfHash(inv))).toMatch(/^apartments\/apt-1\/billing\/2026\/12\//);
    const bytes = await renderReportPdf({ ...content, generatedAt: '2026-12-01T06:15:00.000Z', dataHash: invoicePdfHash(inv) });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });
});

// ---------------------------------------------------------------------------
// HTTP: platform uclari, yonetici gorunumu, uygulama genelinde zorlama
// ---------------------------------------------------------------------------

describe('abonelik HTTP uclari', () => {
  const bearer = (claims: Record<string, unknown>, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${encodeMockToken(claims)}`, 'content-type': 'application/json', ...extra });
  const platformAdmin = { sub: 'p1', role: 'platform_admin' };
  const manager = { sub: 'm1', role: 'apartment_manager', apartmentId: APT };
  const staff = { sub: 's1', role: 'building_staff', apartmentId: APT };
  const resident = { sub: 'r1', role: 'resident', apartmentId: APT };

  function app(entitlements = legacyEntitlementReader) {
    const now = { value: at('2026-11-01') };
    const f = fixture(now);
    const support = {
      resolve: async () => ({ sessionId: 'sess1', apartmentId: APT }),
      recordRequest: async () => {},
    } as unknown as SupportService;
    const a = createApp({ version: 'test', authenticate: createMockAuthenticator(), subscriptionService: f.service, supportService: support, entitlements });
    const req = (method: string, path: string, claims: Record<string, unknown>, body?: unknown, extra?: Record<string, string>) =>
      a.request(path, { method, headers: bearer(claims, extra), ...(body ? { body: JSON.stringify(body) } : {}) });
    return { f, req, now };
  }

  it('platform uclari yalnizca dogrudan platform_admin (yonetici ve destek oturumu 403)', async () => {
    const { req } = app();
    expect((await req('GET', '/api/admin/billing/plans', manager)).status).toBe(403);
    expect((await req('GET', '/api/admin/billing/plans', platformAdmin, undefined, { 'x-support-session': `${APT}.sess1` })).status).toBe(403);
    const seeded = await req('POST', '/api/admin/billing/plans/seed', platformAdmin);
    expect(seeded.status).toBe(200);
    const plans = (await (await req('GET', '/api/admin/billing/plans', platformAdmin)).json()) as { items: { code: string }[] };
    expect(plans.items.map((p) => p.code)).toEqual(['pilot', 'profesyonel', 'standart', 'temel']);
    // Plan olusturma idempotent: ayni anahtar 200 + ayni kayit; farkli anahtarla ayni kod 409.
    const planBody = { idempotencyKey: 'plan-ozel-0001', code: 'ozel', name: 'Özel', pricing: { model: 'flat', monthlyKurus: 50_000, annualKurus: 500_000 } };
    expect((await req('POST', '/api/admin/billing/plans', platformAdmin, planBody)).status).toBe(201);
    expect((await req('POST', '/api/admin/billing/plans', platformAdmin, planBody)).status).toBe(200);
    expect((await req('POST', '/api/admin/billing/plans', platformAdmin, { ...planBody, idempotencyKey: 'plan-ozel-0002' })).status).toBe(409);
    const start = await req('POST', `/api/admin/billing/subscriptions/${APT}`, platformAdmin, { idempotencyKey: 'http-start-0001', planCode: 'standart', trialDays: 0 });
    expect(start.status).toBe(201);
    const again = await req('POST', `/api/admin/billing/subscriptions/${APT}`, platformAdmin, { idempotencyKey: 'http-start-0001', planCode: 'standart', trialDays: 0 });
    expect(again.status).toBe(200);
    const invoices = (await (await req('GET', '/api/admin/billing/invoices', platformAdmin)).json()) as { items: { invoiceNumber: string; version: number }[]; totals: { total: number } };
    expect(invoices.items.map((i) => i.invoiceNumber)).toEqual(['YNS-2026-000001']);
    expect(invoices.totals.total).toBe(47_280);
    const bad = await req('POST', `/api/admin/billing/invoices/${APT}/2026-11-01/paid`, platformAdmin, { version: 1, method: 'bank_transfer' });
    expect(bad.status).toBe(400);
    const paid = await req('POST', `/api/admin/billing/invoices/${APT}/2026-11-01/paid`, platformAdmin, { version: 1, method: 'bank_transfer', reference: 'EFT-1' });
    expect(paid.status).toBe(200);
    expect((await req('POST', `/api/admin/billing/subscriptions/${APT}/status`, platformAdmin, { version: 1, action: 'suspend', reason: 'Test askısı' })).status).toBe(409);
  });

  it('yonetici kendi aboneligini gorur; gorevli yalnizca durumu; sakin 403', async () => {
    const { req } = app();
    const status = await req('GET', '/api/subscription/status', staff);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'legacy', legacy: true, readOnly: false });
    expect((await req('GET', '/api/subscription', staff)).status).toBe(403);
    expect((await req('GET', '/api/subscription/status', resident)).status).toBe(403);
    const view = await req('GET', '/api/subscription', manager);
    expect(view.status).toBe(200);
    expect(view.headers.get('cache-control')).toBe('no-store');
  });

  it('askidaki apartmanda yazim 423 (Turkce mesaj), okuma ve abonelik ekrani acik; plan disi modul 403', async () => {
    const reader = staticEntitlementReader(entitlementOf(sub({ status: 'suspended', plan: plan({ features: { ...allFeatures(), tenders: false } }) })));
    const { req } = app(reader);
    const write = await req('POST', '/api/announcements', manager, { title: 'x' });
    expect(write.status).toBe(423);
    const body = (await write.json()) as { error: string; message: string; status: string };
    expect(body).toMatchObject({ error: 'subscription_read_only', status: 'suspended' });
    expect(body.message).toMatch(/salt okunur/);
    expect((await req('GET', '/api/subscription/status', manager)).status).toBe(200);
    const tenders = await req('GET', '/api/tenders', manager);
    expect(tenders.status).toBe(403);
    expect(await tenders.json()).toMatchObject({ error: 'feature_not_in_plan', feature: 'tenders' });
    // Gorevli de salt okunur hatasini ayni bicimde alir (mobil: mesaj gosterilir).
    expect((await req('POST', '/api/tickets', staff, {})).status).toBe(423);
    // Dogrudan platform_admin muaf: platform ucunda islem yapabilir.
    expect((await req('GET', '/api/admin/billing/plans', platformAdmin)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Bildirimler ve zamanlayici
// ---------------------------------------------------------------------------

describe('abonelik bildirimleri', () => {
  const event = (type: DomainEvent['type'], payload: Record<string, unknown>, apartmentId = APT) =>
    ({ eventId: `${type}:x`, type, version: 1, occurredAt: '2026-12-01T03:15:00.000Z', apartmentId, actorId: 'system-subscriptions', groupKey: apartmentId, payload }) as DomainEvent;

  it('alicilar: yalnizca guncel yonetici ve yonetim firmasi (sakin, denetci, gorevli, eski yonetici ve baska apartman almaz)', () => {
    const roles = [
      role(APT, 'm1', 'apartment_manager'),
      role(APT, 'c1', 'management_company'),
      role(APT, 'o1', 'observer'),
      role(APT, 's1', 'building_staff'),
      role(APT, 'old', 'apartment_manager', { endDate: '2026-10-01' }),
      role(APT, 'gone', 'apartment_manager', { status: 'inactive' }),
      role(APT2, 'm2', 'apartment_manager'),
    ];
    const e = event('SUBSCRIPTION_PAST_DUE', { pastDueSince: '2026-12-12', suspendOn: '2026-12-26', overdueTotalKurus: 120_000, invoiceCount: 1 });
    const out = billingRecipients(e as never, roles, '2026-12-12');
    expect(out.map((r) => r.userId).sort()).toEqual(['c1', 'm1']);
    const viaWorker = buildNotifications(e, [{ apartmentId: APT, unitId: 'u1', userId: 'r1', relation: 'owner', status: 'active', startDate: '2026-01-01' } as never], new Map(), '2026-12-12', roles);
    expect(viaWorker.map((n) => [n.userId, n.template])).toEqual(
      expect.arrayContaining([
        ['m1', 'billing_past_due'],
        ['c1', 'billing_past_due'],
      ]),
    );
    expect(viaWorker.some((n) => n.userId === 'r1')).toBe(false);
  });

  it('tercih kategorisi billing; e-posta ve push sablonlari Turkce', () => {
    for (const t of ['SUBSCRIPTION_TRIAL_ENDING', 'SUBSCRIPTION_INVOICE_ISSUED', 'SUBSCRIPTION_PAST_DUE', 'SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_REACTIVATED']) expect(categoryOfEvent(t)).toBe('billing');
    const cases = [
      ['billing_trial_ending', { trialEndsAt: '2026-11-30', daysLeft: 7, planName: 'Standart' }, /7 gün sonra/],
      ['billing_invoice_issued', { invoiceNumber: 'YNS-2026-000002', totalKurus: 120_000, dueDate: '2026-12-11', periodStart: '2026-12-01', periodEnd: '2026-12-31' }, /YNS-2026-000002/],
      ['billing_past_due', { suspendOn: '2026-12-26', overdueTotalKurus: 120_000, invoiceCount: 1 }, /gecikti/],
      ['billing_suspended', { suspendedAt: '2026-12-26', reason: 'non_payment' }, /askıya alındı/],
      ['billing_reactivated', { reactivatedOn: '2027-01-05' }, /yeniden açıldı/],
    ] as const;
    for (const [template, data, re] of cases) {
      expect(categoryOfTemplate(template)).toBe('billing');
      const n = { eventId: 'e', apartmentId: APT, userId: 'm1', template, data: data as never };
      const mail = renderEmail(n, { siteName: 'Gül Sitesi', unitLabel: () => '', portalUrl: 'https://app.example/app' });
      expect(mail?.subject).toMatch(re);
      expect(mail?.html).toContain('https://app.example/admin/settings');
      const push = renderPush(n);
      expect(push).toMatchObject({ path: '/abonelik', category: 'billing' });
    }
  });

  it('zamanlayici: subscriptions isi her aktif site icin gunluk adimi calistirir; legacy atlanir', async () => {
    const calls: [string, string][] = [];
    const worker = createSchedulerWorker({
      core: {
        listSiteIds: async () => [APT, APT2],
        getSite: async (id) => site(id, id),
      },
      subscriptions: {
        runDaily: async (apt: string, day?: string) => {
          calls.push([apt, day ?? '']);
          return apt === APT ? ({ status: 'updated', subscriptionStatus: 'active', transitions: [], invoices: [], events: 0 } as never) : ({ status: 'skipped', reason: 'legacy' } as never);
        },
      },
      log: { info: () => {}, error: () => {} },
    });
    const outcomes = await worker.runJob({ job: 'subscriptions', scheduledTime: '2026-12-01T03:15:00.000Z' });
    expect(calls).toEqual([
      [APT, '2026-12-01'],
      [APT2, '2026-12-01'],
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'skipped']);
  });
});
