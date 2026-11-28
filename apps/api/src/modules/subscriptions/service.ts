import { DataAccessError } from '../../config/dynamodb.js';
import { type DomainEvent, buildEvent } from '../../events/publisher.js';
import type { ApartmentRoleRepository } from '../apartment-roles/repository.js';
import { apartmentRoleRepository } from '../apartment-roles/repository.js';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDate } from '../core/types.js';
import { SubscriptionError } from './errors.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, optInt, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { DocumentError } from '../documents/errors.js';
import { contentDisposition } from '../documents/keys.js';
import { renderReportPdf } from '../documents/reportPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import { type Entitlement, entitlementOf } from './entitlements.js';
import { invoicePdfContent, invoicePdfHash, invoicePdfKey } from './invoicePdf.js';
import { type AdvanceResult, type InvoiceDraft, type MachineEvent, SUBSCRIPTION_ACTIONS, TransitionError, advance, applyAction } from './machine.js';
import { PLACEHOLDER_PLANS, parsePlanContent } from './plans.js';
import { addDays, daysBetween, istanbulDay } from './pricing.js';
import { type SubscriptionRepository, type UnnumberedInvoice, subscriptionRepository } from './repository.js';
import {
  BILLING_PERIODS,
  type BillingPeriod,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PAYMENT_TERM_DAYS,
  PAYMENT_METHODS,
  PLAN_CATALOG_PK,
  PLAN_STATUSES,
  type PlanContent,
  type PlanHead,
  type PlanSnapshot,
  type PlanVersion,
  SUBSCRIPTION_STATUSES,
  type Subscription,
  type SubscriptionInvoice,
  type SubscriptionStatus,
  invoiceGsi,
  invoiceKeys,
  planKeys,
  subscriptionGsi,
  subscriptionKeys,
} from './types.js';

/**
 * Abonelik / lisans servisi.
 *  - Platform (`platform_admin`): plan katalogu (surumlu, silme yok), apartman aboneligi baslatma /
 *    plan degistirme / durum gecisleri, faturalari elle odendi isaretleme veya iptal.
 *  - Yonetici: kendi aboneligi, kullanim ve faturalar (PDF).
 *  - Zamanlayici (`subscriptions` isi, her gun): durum makinesi (machine.ts) - deneme bitisi,
 *    donem faturasi, gecikme, ek sure ve askiya alma. Idempotent; denetimli; olaylar outbox ile.
 *
 * Online odeme kancasi: `markPaid` `method: 'online'` ve saglayici referansini kabul eder; ileride
 * odeme saglayicisinin geri bildirimi ayni fonksiyonu sistem aktoruyle cagirir (`SubscriptionPaymentHook`).
 */

export { SubscriptionError };

/** Ileride online odeme: saglayici odeme sonucunu bu arayuzle bildirir (simdilik bagli degil). */
export type SubscriptionPaymentHook = {
  onPaid(input: { apartmentId: string; invoiceId: string; providerReference: string; paidOn: IsoDate }): Promise<void>;
};

export const SUBSCRIPTION_SYSTEM_ACTOR = 'system-subscriptions';

export type SubscriptionServiceDeps = {
  repository: SubscriptionRepository;
  core: Pick<CoreRepository, 'getSite' | 'listSiteIds' | 'listUnits'>;
  roles: Pick<ApartmentRoleRepository, 'list'>;
  store: DocumentStore | undefined;
  /** Yazimdan sonra ayni konteynerdeki yetki onbellegi temizlenir. */
  invalidate?: (apartmentId: string) => void;
  now: () => Date;
};

const REASON_MIN = 5;
const REASON_MAX = 500;
const MAX_ATTEMPTS = 3;

type Ctx = { userId: string };

function strip<T extends { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string }>(x: T) {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, ...rest } = x;
  return rest;
}

export const planView = (p: PlanHead) => strip(p);
export const subscriptionView = (s: Subscription) => strip(s);
export const invoiceView = (i: SubscriptionInvoice) => strip(i);

const snapshotOf = (p: PlanContent & { planVersion: number }): PlanSnapshot => ({
  code: p.code,
  name: p.name,
  pricing: p.pricing,
  features: p.features,
  limits: p.limits,
  planVersion: p.planVersion,
});

const isCurrentRole = (r: { status: string; startDate: IsoDate; endDate?: IsoDate }, day: IsoDate) =>
  r.status === 'active' && r.startDate <= day && (!r.endDate || r.endDate >= day);

export function createSubscriptionService(overrides: Partial<SubscriptionServiceDeps> = {}) {
  const deps: SubscriptionServiceDeps = {
    repository: subscriptionRepository,
    core: coreRepository,
    roles: apartmentRoleRepository,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();
  const today = () => istanbulDay(deps.now());

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  async function requireSite(apartmentId: string) {
    assertId(apartmentId, 'apartmentId');
    const site = await deps.core.getSite(apartmentId);
    if (!site) throw new SubscriptionError('not_found', 'Apartman bulunamadı');
    return site;
  }

  async function requirePlan(code: string): Promise<PlanHead> {
    if (typeof code !== 'string' || !code) throw new ValidationError('planCode zorunludur', 'planCode');
    const p = await repo.getPlan(code);
    if (!p) throw new SubscriptionError('not_found', 'Plan bulunamadı');
    return p;
  }

  async function requireSubscription(apartmentId: string): Promise<Subscription> {
    const s = await repo.getSubscription(apartmentId);
    if (!s || s.apartmentId !== apartmentId) throw new SubscriptionError('not_found', 'Bu apartmanın aboneliği yok (legacy)');
    return s;
  }

  async function usage(apartmentId: string) {
    const [units, roles] = await Promise.all([deps.core.listUnits(apartmentId), deps.roles.list(apartmentId)]);
    const day = today();
    return {
      units: units.filter((u) => u.status === 'active').length,
      staffUsers: new Set(roles.filter((r) => r.apartmentId === apartmentId && isCurrentRole(r, day)).map((r) => r.userId)).size,
    };
  }

  const reason = (o: Obj) => reqString(o, 'reason', REASON_MAX, REASON_MIN);
  const reqVersion = (o: Obj) => reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);

  function reqDate(o: Obj, key: string): IsoDate {
    const v = reqString(o, key, 10, 10);
    if (!isIsoDate(v)) throw new ValidationError(`${key} YYYY-MM-DD biçiminde geçerli bir tarih olmalıdır`, key);
    return v;
  }

  /** Makine olayi -> domain olayi (eventId kayit surumuyle tekil: ayni gecis bir kez). */
  function toDomainEvents(apartmentId: string, version: number, machine: readonly MachineEvent[], invoices: readonly SubscriptionInvoice[], actorId: string): DomainEvent[] {
    const now = () => deps.now();
    const out: DomainEvent[] = machine.map(
      (e) => buildEvent({ eventId: `${e.eventId}:v${version}`, type: e.type, apartmentId, actorId, payload: e.payload } as Parameters<typeof buildEvent>[0], now) as DomainEvent,
    );
    for (const inv of invoices) {
      out.push(
        buildEvent(
          {
            eventId: `SUBSCRIPTION_INVOICE_ISSUED:${apartmentId}:${inv.invoiceId}`,
            type: 'SUBSCRIPTION_INVOICE_ISSUED',
            apartmentId,
            actorId,
            payload: {
              invoiceId: inv.invoiceId,
              invoiceNumber: inv.invoiceNumber,
              totalKurus: inv.totalKurus,
              dueDate: inv.dueDate,
              periodStart: inv.periodStart,
              periodEnd: inv.periodEnd,
            },
          },
          now,
        ),
      );
    }
    return out;
  }

  function draftToInvoice(sub: Subscription, siteName: string, d: InvoiceDraft, actor: string): UnnumberedInvoice {
    const ts = stamp();
    return {
      ...invoiceKeys(sub.apartmentId, d.invoiceId),
      ...invoiceGsi(d.issueDate, sub.apartmentId, d.invoiceId),
      entityType: 'SUBSCRIPTION_INVOICE',
      apartmentId: sub.apartmentId,
      invoiceId: d.invoiceId,
      siteName,
      status: 'issued',
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      billingPeriod: sub.billingPeriod,
      planCode: sub.plan.code,
      planVersion: sub.plan.planVersion,
      planName: sub.plan.name,
      unitCount: d.unitCount,
      lines: d.lines,
      netKurus: d.netKurus,
      vatRateBps: d.vatRateBps,
      vatKurus: d.vatKurus,
      totalKurus: d.totalKurus,
      issueDate: d.issueDate,
      dueDate: d.dueDate,
      createdAt: ts,
      createdBy: actor,
      updatedAt: ts,
      updatedBy: actor,
      version: 1,
    };
  }

  /**
   * Makine sonucunu tek atomik yazimla kaydeder (abonelik + faturalar + sayac + outbox + denetim).
   * `expectedVersion: null` yeni abonelik.
   */
  async function persist(
    result: AdvanceResult,
    opts: { expectedVersion: number | null; actor: string; system: boolean; action: string; reason?: string; details?: Record<string, unknown>; updatedInvoices?: { item: SubscriptionInvoice; expectedVersion: number }[] },
  ) {
    const site = await deps.core.getSite(result.sub.apartmentId);
    const ts = stamp();
    const nextVersion = (opts.expectedVersion ?? 0) + 1;
    const sub: Subscription = {
      ...result.sub,
      ...subscriptionGsi(result.sub.status, result.sub.apartmentId),
      ...(result.transitions.length ? { statusChangedAt: ts } : {}),
      updatedAt: ts,
      updatedBy: opts.actor,
      version: nextVersion,
    };
    const drafts = result.invoices.map((d) => draftToInvoice(sub, site?.name ?? sub.apartmentId, d, opts.actor));
    const audit: AuditDraft = {
      apartmentId: sub.apartmentId,
      action: opts.action,
      target: { type: 'subscription', id: sub.apartmentId },
      ...(opts.system ? { systemActor: true, actorId: opts.actor } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      details: {
        status: sub.status,
        plan: `${sub.plan.code}@${sub.plan.planVersion}`,
        version: nextVersion,
        ...(result.transitions.length ? { transitions: result.transitions } : {}),
        ...(drafts.length ? { invoices: drafts.map((d) => ({ invoiceId: d.invoiceId, totalKurus: d.totalKurus, dueDate: d.dueDate })) } : {}),
        ...(opts.details ?? {}),
      },
    };
    const { invoices } = await repo.commit({
      apartmentId: sub.apartmentId,
      subscription: { item: sub, expectedVersion: opts.expectedVersion },
      newInvoices: drafts,
      ...(opts.updatedInvoices ? { updatedInvoices: opts.updatedInvoices } : {}),
      events: (numbered) => toDomainEvents(sub.apartmentId, nextVersion, result.events, numbered, opts.actor),
      audits: [audit],
      createdAt: ts,
    });
    deps.invalidate?.(sub.apartmentId);
    return { subscription: sub, invoices };
  }

  /** Surum catismasinda yeniden okuyup tekrar dener (gunluk is ve platform islemleri). */
  async function retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict' && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Plan katalogu (platform)
  // -------------------------------------------------------------------------

  async function listPlans() {
    return (await repo.listPlans()).map(planView);
  }

  async function getPlan(code: string) {
    const head = await requirePlan(code);
    const versions = await repo.listPlanVersions(code);
    return { plan: planView(head), versions: versions.map((v) => strip(v)) };
  }

  function newHead(content: PlanContent, actor: string, idempotencyKey?: string): { head: PlanHead; version: PlanVersion } {
    const ts = stamp();
    const head: PlanHead = {
      ...planKeys.head(content.code),
      ...content,
      entityType: 'PLAN',
      status: 'active',
      planVersion: 1,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: ts,
      createdBy: actor,
      updatedAt: ts,
      updatedBy: actor,
      version: 1,
      GSI1PK: PLAN_CATALOG_PK,
      GSI1SK: content.code,
    };
    const version: PlanVersion = { ...planKeys.version(content.code, 1), ...content, entityType: 'PLAN_VERSION', planVersion: 1, createdAt: ts, createdBy: actor };
    return { head, version };
  }

  async function createPlan(ctx: Ctx, input: unknown) {
    const o = asObject(input);
    const idempotencyKey = reqString(o, 'idempotencyKey', 100, 8);
    const content = parsePlanContent(o);
    const existing = await repo.getPlan(content.code);
    if (existing) {
      if (existing.idempotencyKey === idempotencyKey) return { created: false, plan: planView(existing) };
      throw new SubscriptionError('conflict', 'Bu kodla bir plan zaten var');
    }
    const { head, version } = newHead(content, ctx.userId, idempotencyKey);
    try {
      await repo.createPlan(head, version, { action: 'subscription.plan.create', target: { type: 'plan', id: content.code }, details: { code: content.code, name: content.name, pricing: content.pricing, features: content.features, limits: content.limits } });
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        const again = await repo.getPlan(content.code);
        if (again?.idempotencyKey === idempotencyKey) return { created: false, plan: planView(again) };
        throw new SubscriptionError('conflict', 'Bu kodla bir plan zaten var');
      }
      throw err;
    }
    return { created: true, plan: planView(head) };
  }

  /** Icerik degisikligi = yeni degismez surum; mevcut abonelikler eski anlik goruntuyu korur. */
  async function updatePlan(ctx: Ctx, code: string, input: unknown) {
    const o = asObject(input);
    const expected = reqVersion(o);
    const why = reason(o);
    const head = await requirePlan(code);
    if (head.version !== expected) throw new SubscriptionError('conflict', 'Plan başka biri tarafından güncellendi (sürüm uyuşmazlığı)');
    const content = parsePlanContent({ ...o, code }, code);
    const planVersion = head.planVersion + 1;
    const ts = stamp();
    const next: PlanHead = { ...head, ...content, planVersion, placeholder: false, updatedAt: ts, updatedBy: ctx.userId, version: head.version + 1 };
    if (!content.description) delete next.description;
    const version: PlanVersion = { ...planKeys.version(code, planVersion), ...content, entityType: 'PLAN_VERSION', planVersion, createdAt: ts, createdBy: ctx.userId, reason: why };
    try {
      await repo.savePlan(next, expected, version, { action: 'subscription.plan.update', target: { type: 'plan', id: code }, reason: why, details: { planVersion, pricing: content.pricing, features: content.features, limits: content.limits } });
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new SubscriptionError('conflict', 'Plan başka biri tarafından güncellendi (sürüm uyuşmazlığı)');
      throw err;
    }
    return planView(next);
  }

  async function setPlanStatus(ctx: Ctx, code: string, input: unknown) {
    const o = asObject(input);
    const expected = reqVersion(o);
    const status = reqEnum(o, 'status', PLAN_STATUSES);
    const why = reason(o);
    const head = await requirePlan(code);
    if (head.version !== expected) throw new SubscriptionError('conflict', 'Plan başka biri tarafından güncellendi (sürüm uyuşmazlığı)');
    if (head.status === status) return planView(head);
    const next: PlanHead = { ...head, status, updatedAt: stamp(), updatedBy: ctx.userId, version: head.version + 1 };
    await repo.savePlan(next, expected, undefined, { action: 'subscription.plan.status', target: { type: 'plan', id: code }, reason: why, details: { from: head.status, to: status } });
    return planView(next);
  }

  /** Ornek (yer tutucu) planlar: eksik olanlari olusturur (tekrar calismasi zararsiz). */
  async function seedPlaceholderPlans(ctx: Ctx) {
    const created: string[] = [];
    for (const content of PLACEHOLDER_PLANS) {
      if (await repo.getPlan(content.code)) continue;
      const { head, version } = newHead(content, ctx.userId, `seed-${content.code}`);
      try {
        await repo.createPlan(head, version, { action: 'subscription.plan.create', target: { type: 'plan', id: content.code }, details: { code: content.code, placeholder: true } });
        created.push(content.code);
      } catch (err) {
        if (!(err instanceof DataAccessError && err.code === 'conflict')) throw err;
      }
    }
    return { created, plans: await listPlans() };
  }

  // -------------------------------------------------------------------------
  // Abonelikler (platform)
  // -------------------------------------------------------------------------

  type ListStatus = SubscriptionStatus | 'legacy' | 'all';

  async function listSubscriptions(filter: { status?: string } = {}) {
    const status = (filter.status ?? 'all') as ListStatus;
    if (!['all', 'legacy', ...SUBSCRIPTION_STATUSES].includes(status)) throw new ValidationError('status geçersiz', 'status');
    const [ids, subs] = await Promise.all([deps.core.listSiteIds(), repo.listSubscriptions()]);
    const byApt = new Map(subs.map((s) => [s.apartmentId, s]));
    const sites = await Promise.all(ids.map((id) => deps.core.getSite(id)));
    const day = today();
    const items = sites
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((site) => {
        const sub = byApt.get(site.siteId);
        return {
          apartmentId: site.siteId,
          siteName: site.name,
          city: site.address.city,
          siteStatus: site.status,
          status: (sub?.status ?? 'legacy') as SubscriptionStatus | 'legacy',
          ...(sub ? { subscription: subscriptionView(sub), daysLeft: sub.trialEndsAt && sub.status === 'trial' ? daysBetween(day, sub.trialEndsAt) : undefined } : {}),
        };
      })
      .filter((i) => status === 'all' || i.status === status)
      .sort((a, b) => a.siteName.localeCompare(b.siteName, 'tr-TR'));
    const counts = Object.fromEntries(['legacy', ...SUBSCRIPTION_STATUSES].map((s) => [s, 0])) as Record<string, number>;
    for (const site of sites) if (site) counts[byApt.get(site.siteId)?.status ?? 'legacy'] = (counts[byApt.get(site.siteId)?.status ?? 'legacy'] ?? 0) + 1;
    return { items, counts };
  }

  async function subscriptionDetail(apartmentId: string) {
    const site = await requireSite(apartmentId);
    const [sub, invoices, use] = await Promise.all([repo.getSubscription(apartmentId), repo.listInvoices(apartmentId), usage(apartmentId)]);
    return {
      apartmentId,
      siteName: site.name,
      status: sub?.status ?? 'legacy',
      subscription: sub ? subscriptionView(sub) : null,
      usage: use,
      invoices: invoices.sort((a, b) => b.invoiceId.localeCompare(a.invoiceId)).map(invoiceView),
    };
  }

  async function startSubscription(ctx: Ctx, apartmentId: string, input: unknown) {
    const o = asObject(input);
    const idempotencyKey = reqString(o, 'idempotencyKey', 100, 8);
    const site = await requireSite(apartmentId);
    const existing = await repo.getSubscription(apartmentId);
    if (existing) {
      if (existing.idempotencyKey === idempotencyKey) return { created: false, subscription: subscriptionView(existing) };
      throw new SubscriptionError('conflict', 'Bu apartmanın aboneliği zaten var; plan veya durum değişikliği kullanın');
    }
    const plan = await requirePlan(reqString(o, 'planCode', 32, 2));
    if (plan.status !== 'active') throw new SubscriptionError('conflict', 'Arşivlenmiş plan yeni aboneliğe atanamaz');
    const billingPeriod = (o.billingPeriod === undefined ? 'monthly' : reqEnum(o, 'billingPeriod', BILLING_PERIODS)) as BillingPeriod;
    const trialDays = optInt(o, 'trialDays', 0, 90) ?? plan.trialDays;
    const graceDays = optInt(o, 'graceDays', 0, 60) ?? DEFAULT_GRACE_DAYS;
    const paymentTermDays = optInt(o, 'paymentTermDays', 0, 60) ?? DEFAULT_PAYMENT_TERM_DAYS;
    const note = optString(o, 'reason', REASON_MAX);
    const day = today();
    const ts = stamp();
    const use = await usage(apartmentId);
    const base: Subscription = {
      ...subscriptionKeys(apartmentId),
      ...subscriptionGsi(trialDays > 0 ? 'trial' : 'active', apartmentId),
      entityType: 'SUBSCRIPTION',
      apartmentId,
      status: trialDays > 0 ? 'trial' : 'active',
      plan: snapshotOf(plan),
      billingPeriod,
      ...(trialDays > 0 ? { trialStartedAt: day, trialEndsAt: addDays(day, trialDays - 1) } : {}),
      unitCountSnapshot: use.units,
      graceDays,
      paymentTermDays,
      statusChangedAt: ts,
      idempotencyKey,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 0,
    };
    // Deneme yoksa ilk donem bugun baslar (makine ilk faturayi keser).
    const result = trialDays > 0 ? advance({ sub: base, day, invoices: [], unitCount: use.units }) : applyFirstPeriod(base, day, use.units);
    const out = await persist(
      { ...result, transitions: [] },
      {
        expectedVersion: null,
        actor: ctx.userId,
        system: false,
        action: 'subscription.start',
        ...(note ? { reason: note } : {}),
        details: { siteName: site.name, billingPeriod, trialDays, graceDays, paymentTermDays, units: use.units },
      },
    );
    return { created: true, subscription: subscriptionView(out.subscription), invoices: out.invoices.map(invoiceView) };
  }

  /** Denemesiz baslangic: ilk donem bugun (tabani bugun olan donem + ilk fatura). */
  function applyFirstPeriod(seed: Subscription, day: IsoDate, units: number): AdvanceResult {
    const trial: Subscription = { ...seed, status: 'trial', trialEndsAt: addDays(day, -1) };
    const r = advance({ sub: trial, day, invoices: [], unitCount: units });
    delete r.sub.trialEndsAt;
    return { ...r, transitions: [] };
  }

  async function changePlan(ctx: Ctx, apartmentId: string, input: unknown) {
    const o = asObject(input);
    const expected = reqVersion(o);
    const why = reason(o);
    const plan = await requirePlan(reqString(o, 'planCode', 32, 2));
    if (plan.status !== 'active') throw new SubscriptionError('conflict', 'Arşivlenmiş plan atanamaz');
    const billingPeriod = o.billingPeriod === undefined ? undefined : reqEnum(o, 'billingPeriod', BILLING_PERIODS);
    const sub = await requireSubscription(apartmentId);
    if (sub.version !== expected) throw new SubscriptionError('conflict', 'Abonelik başka biri tarafından güncellendi (sürüm uyuşmazlığı)');
    // Ozellik ve limitler hemen; fiyat bir sonraki donem faturasindan itibaren gecerlidir.
    const next: Subscription = { ...sub, plan: snapshotOf(plan), ...(billingPeriod && !sub.billingAnchor ? { billingPeriod } : {}) };
    const out = await persist(
      { sub: next, invoices: [], events: [], transitions: [], changed: true },
      { expectedVersion: sub.version, actor: ctx.userId, system: false, action: 'subscription.plan_change', reason: why, details: { from: `${sub.plan.code}@${sub.plan.planVersion}`, to: `${plan.code}@${plan.planVersion}` } },
    );
    return subscriptionView(out.subscription);
  }

  async function changeStatus(ctx: Ctx, apartmentId: string, input: unknown) {
    const o = asObject(input);
    const expected = reqVersion(o);
    const why = reason(o);
    const action = reqEnum(o, 'action', SUBSCRIPTION_ACTIONS);
    const trialEndsAt = action === 'extend_trial' ? reqDate(o, 'trialEndsAt') : undefined;
    const sub = await requireSubscription(apartmentId);
    if (sub.version !== expected) throw new SubscriptionError('conflict', 'Abonelik başka biri tarafından güncellendi (sürüm uyuşmazlığı)');
    const [invoices, use] = await Promise.all([repo.listInvoices(apartmentId), usage(apartmentId)]);
    let result: AdvanceResult;
    try {
      result = applyAction({ sub, day: today(), invoices, unitCount: use.units, action, ...(trialEndsAt ? { trialEndsAt } : {}) });
    } catch (err) {
      if (err instanceof TransitionError) throw new SubscriptionError('invalid_transition', err.message);
      throw err;
    }
    const out = await persist(result, { expectedVersion: sub.version, actor: ctx.userId, system: false, action: `subscription.${action}`, reason: why, ...(trialEndsAt ? { details: { trialEndsAt } } : {}) });
    return { subscription: subscriptionView(out.subscription), invoices: out.invoices.map(invoiceView) };
  }

  // -------------------------------------------------------------------------
  // Gunluk ilerleme (zamanlayici; platform "simdi calistir")
  // -------------------------------------------------------------------------

  /**
   * Bir apartmanin gunluk adimi. Abonelik yoksa (legacy) yazim yok. Ayni gun tekrar calismak
   * degisiklik uretmez (yazim da yok).
   */
  async function runDaily(apartmentId: string, day: IsoDate = today(), actor = SUBSCRIPTION_SYSTEM_ACTOR) {
    return retrying(async () => {
      const sub = await repo.getSubscription(apartmentId);
      if (!sub) return { status: 'skipped' as const, reason: 'legacy' };
      if (sub.status === 'cancelled') return { status: 'skipped' as const, reason: 'cancelled' };
      const [invoices, use] = await Promise.all([repo.listInvoices(apartmentId), usage(apartmentId)]);
      const result = advance({ sub, day, invoices, unitCount: use.units });
      if (!result.changed) return { status: 'unchanged' as const, subscriptionStatus: sub.status };
      result.sub.lastRunOn = day;
      const out = await persist(result, { expectedVersion: sub.version, actor, system: actor === SUBSCRIPTION_SYSTEM_ACTOR, action: 'subscription.advance', details: { day } });
      return {
        status: 'updated' as const,
        subscriptionStatus: out.subscription.status,
        transitions: result.transitions.map((t) => `${t.from}->${t.to}`),
        invoices: out.invoices.map((i) => i.invoiceNumber),
        events: result.events.length + out.invoices.length,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Faturalar
  // -------------------------------------------------------------------------

  async function listAllInvoices(filter: { status?: string; apartmentId?: string; cursor?: string; limit?: number }) {
    const status = filter.status && filter.status !== 'all' ? reqEnum({ status: filter.status }, 'status', ['issued', 'paid', 'void'] as const) : undefined;
    if (filter.apartmentId) {
      assertId(filter.apartmentId, 'apartmentId');
      const items = (await repo.listInvoices(filter.apartmentId)).filter((i) => !status || i.status === status).sort((a, b) => b.invoiceId.localeCompare(a.invoiceId));
      return { items: items.map(invoiceView), totals: totalsOf(items) };
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const page = await repo.listAllInvoices({ limit, ...(filter.cursor ? { cursor: filter.cursor } : {}) });
    const items = page.items.filter((i) => !status || i.status === status);
    return { items: items.map(invoiceView), totals: totalsOf(items), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  function totalsOf(items: readonly SubscriptionInvoice[]) {
    const live = items.filter((i) => i.status !== 'void');
    const sum = (f: (i: SubscriptionInvoice) => number, list = live) => list.reduce((s, i) => s + f(i), 0);
    return {
      net: sum((i) => i.netKurus),
      vat: sum((i) => i.vatKurus),
      total: sum((i) => i.totalKurus),
      unpaid: sum((i) => i.totalKurus, live.filter((i) => i.status === 'issued')),
    };
  }

  async function requireInvoice(apartmentId: string, invoiceId: string): Promise<SubscriptionInvoice> {
    assertId(apartmentId, 'apartmentId');
    if (!isIsoDate(invoiceId)) throw new ValidationError('invoiceId geçersiz', 'invoiceId');
    const inv = await repo.getInvoice(apartmentId, invoiceId);
    if (!inv || inv.apartmentId !== apartmentId) throw new SubscriptionError('not_found', 'Fatura bulunamadı');
    return inv;
  }

  /**
   * Fatura ve abonelik birlikte: odeme / iptal sonrasi durum makinesi ayni gun icin calisir
   * (odeme gelince `past_due` / odeme nedeniyle `suspended` -> `active`).
   */
  async function settleInvoice(ctx: Ctx, apartmentId: string, invoiceId: string, expected: number, mutate: (inv: SubscriptionInvoice) => SubscriptionInvoice, action: string, why: string | undefined, details: Record<string, unknown>) {
    const inv = await requireInvoice(apartmentId, invoiceId);
    if (inv.version !== expected) throw new SubscriptionError('conflict', 'Fatura başka biri tarafından güncellendi (sürüm uyuşmazlığı)');
    if (inv.status !== 'issued') throw new SubscriptionError('invalid_transition', inv.status === 'paid' ? 'Fatura zaten ödendi olarak işaretli' : 'İptal edilmiş fatura değiştirilemez');
    const updated: SubscriptionInvoice = { ...mutate(inv), updatedAt: stamp(), updatedBy: ctx.userId, version: inv.version + 1 };
    const sub = await requireSubscription(apartmentId);
    const [all, use] = await Promise.all([repo.listInvoices(apartmentId), usage(apartmentId)]);
    const invoices = all.map((i) => (i.invoiceId === invoiceId ? updated : i));
    const result = sub.status === 'cancelled' ? { sub, invoices: [], events: [], transitions: [], changed: false } : advance({ sub, day: today(), invoices, unitCount: use.units });
    const out = await persist(result, {
      expectedVersion: sub.version,
      actor: ctx.userId,
      system: false,
      action,
      ...(why ? { reason: why } : {}),
      details: { invoiceId, invoiceNumber: inv.invoiceNumber, totalKurus: inv.totalKurus, ...details },
      updatedInvoices: [{ item: updated, expectedVersion: inv.version }],
    });
    return { invoice: invoiceView(updated), subscription: subscriptionView(out.subscription) };
  }

  async function markPaid(ctx: Ctx, apartmentId: string, invoiceId: string, input: unknown) {
    const o = asObject(input);
    const expected = reqVersion(o);
    const paidOn = o.paidOn === undefined ? today() : reqDate(o, 'paidOn');
    if (paidOn > today()) throw new ValidationError('Ödeme tarihi ileri bir gün olamaz', 'paidOn');
    const method = reqEnum(o, 'method', PAYMENT_METHODS);
    const reference = reqString(o, 'reference', 100, 3);
    const note = optString(o, 'note', REASON_MAX);
    return settleInvoice(
      ctx,
      apartmentId,
      invoiceId,
      expected,
      (inv) => ({ ...inv, status: 'paid', paidOn, paymentMethod: method, paymentReference: reference, ...(note ? { paymentNote: note } : {}), paidBy: ctx.userId }),
      'subscription.invoice.paid',
      note,
      { paidOn, method, reference },
    );
  }

  async function voidInvoice(ctx: Ctx, apartmentId: string, invoiceId: string, input: unknown) {
    const o = asObject(input);
    const expected = reqVersion(o);
    const why = reason(o);
    return settleInvoice(ctx, apartmentId, invoiceId, expected, (inv) => ({ ...inv, status: 'void', voidReason: why, voidedBy: ctx.userId }), 'subscription.invoice.void', why, {});
  }

  async function invoicePdf(apartmentId: string, invoiceId: string) {
    if (!deps.store) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    const store = deps.store;
    const inv = await requireInvoice(apartmentId, invoiceId);
    const hash = invoicePdfHash(inv);
    const key = invoicePdfKey(inv, hash);
    if (!(await store.head(key))) await store.put(key, await renderReportPdf({ ...invoicePdfContent(inv), generatedAt: stamp(), dataHash: hash }), 'application/pdf');
    const fileName = `Abonelik faturası ${inv.invoiceNumber}.pdf`;
    const url = await store.presignGet(key, { contentDisposition: contentDisposition(fileName, 'inline'), contentType: 'application/pdf', expiresIn: URL_TTL_SECONDS });
    return { url, fileName, contentType: 'application/pdf', expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString() };
  }

  // -------------------------------------------------------------------------
  // Yonetici gorunumu
  // -------------------------------------------------------------------------

  /** Banner ve salt okunur bildirimi icin hafif durum (tum yonetim paneli rolleri). */
  async function statusView(apartmentId: string) {
    const sub = await repo.getSubscription(apartmentId);
    const e: Entitlement = entitlementOf(sub);
    const day = today();
    return {
      status: e.status,
      legacy: e.legacy,
      readOnly: e.readOnly,
      ...(sub?.status === 'trial' && sub.trialEndsAt ? { trialEndsAt: sub.trialEndsAt, daysLeft: daysBetween(day, sub.trialEndsAt) } : {}),
      ...(sub?.status === 'past_due' && sub.pastDueSince ? { pastDueSince: sub.pastDueSince, suspendOn: addDays(sub.pastDueSince, sub.graceDays) } : {}),
      ...(sub?.suspendedAt ? { suspendedAt: sub.suspendedAt } : {}),
    };
  }

  async function managerView(apartmentId: string) {
    const [sub, invoices, use] = await Promise.all([repo.getSubscription(apartmentId), repo.listInvoices(apartmentId), usage(apartmentId)]);
    const e = entitlementOf(sub);
    return {
      ...(await statusView(apartmentId)),
      features: e.features,
      limits: e.limits,
      usage: use,
      ...(sub
        ? {
            plan: { code: sub.plan.code, name: sub.plan.name, planVersion: sub.plan.planVersion, pricing: sub.plan.pricing },
            billingPeriod: sub.billingPeriod,
            ...(sub.trialStartedAt ? { trialStartedAt: sub.trialStartedAt } : {}),
            ...(sub.trialEndsAt ? { trialEndsAt: sub.trialEndsAt } : {}),
            ...(sub.currentPeriodStart ? { currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd } : {}),
            graceDays: sub.graceDays,
            paymentTermDays: sub.paymentTermDays,
          }
        : {}),
      invoices: invoices
        .filter((i) => i.status !== 'void')
        .sort((a, b) => b.invoiceId.localeCompare(a.invoiceId))
        .slice(0, 24)
        .map((i) => {
          const { paidBy: _p, voidedBy: _v, createdBy: _c, updatedBy: _u, paymentNote: _n, ...rest } = invoiceView(i);
          return rest;
        }),
    };
  }

  return {
    listPlans,
    getPlan,
    createPlan,
    updatePlan,
    setPlanStatus,
    seedPlaceholderPlans,
    listSubscriptions,
    subscriptionDetail,
    startSubscription,
    changePlan,
    changeStatus,
    runDaily,
    listAllInvoices,
    markPaid,
    voidInvoice,
    invoicePdf,
    statusView,
    managerView,
  };
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>;
