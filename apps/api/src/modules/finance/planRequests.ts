/**
 * Finans 2.2 sonrasi - Sakin portalindan yapilandirma (taksit) talebi.
 *
 * Akis:
 *  1. Sakin (vadesi gecmis borcu olan alt carinin sorumlu tarafi) portaldan taksit sayisi (+ istege
 *     bagli not) ile talep acar. Sinirlar yonetimin ayarlarindan gelir (`PLANREQCFG`): en fazla taksit,
 *     en dusuk taksit tutari, dondurulan gecikme tazminatinin taksitlere dahil olup olmadigi. Tutar
 *     tahmini: vadesi gecmis (plana bagli olmayan) kalemler + (dahilse) bugune kadar islemis tazminat.
 *  2. Cari basina tek acik talep: `PLANREQHEAD#<cari>` (sira + acik talep) surum kosullu yazilir;
 *     ayni anda iki talep ayni sira numarasiyla (`PLNRQ_<cari ozeti>_<sira>` idempotency) yarisir,
 *     ikincisi 409 alir.
 *  3. Yonetim talebi oldugu gibi veya degisiklikle onaylar (taksit sayisi, ilk vade, kalemler,
 *     tazminatin dahil olmasi, muacceliyet esikleri) ya da gerekceyle reddeder. Onay, planlari
 *     olusturan MEVCUT yapilandirma servisinden (`plans.ts createFromRequest`) gecer: ayni defter
 *     kayitlari (tazminat dondurma, hedefli kapama, taksitler); talep, cari basligi, bildirim olayi ve
 *     denetim ayni atomik yazimdadir. Yeni defter mantigi yoktur.
 *  4. Bildirim (outbox, kategori `finance`): talep -> yonetim (`RESTRUCTURE_REQUESTED`), onay / ret ->
 *     talebi acan sakin (`RESTRUCTURE_APPROVED` / `_REJECTED`).
 *
 * KVKK: talebi yalnizca acan sakin (kendi talepleri) ve yonetim (yonetici + firma; denetci degil)
 * gorur. Ayni cariyi goren diger uyeye yalnizca "bekleyen talep var" bilgisi verilir (not, kisi yok).
 */
import { createHash, randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type DomainEvent, type NewEvent, buildEvent } from '../../events/publisher.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, type TableKeys, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqString } from '../core/validation.js';
import type { PortalContext, PortalService } from '../portal/service.js';
import { MAX_INSTALLMENTS, type PlanRule, type PlanService, addMonths } from './plans.js';
import { type FinanceRepository, LedgerConflictError, type ReplaceRecord, financeRepository } from './repository.js';
import { FinanceError, MAX_AMOUNT } from './service.js';

// ---------------------------------------------------------------------------
// Kayitlar
// ---------------------------------------------------------------------------

export type PlanRequestSettings = {
  /** Kapaliysa sakin yeni talep acamaz (mevcut talepler sonuclandirilabilir). */
  enabled: boolean;
  /** Sakinin isteyebilecegi en fazla taksit (2-60). */
  maxInstallments: number;
  /** En kucuk taksit tutari (kurus); taksit sayisi buna gore sinirlanir. */
  minInstallmentAmount: Kurus;
  /** Yapilandirma aninda dondurulan gecikme tazminati taksitlere dahil edilir mi (plan kurali). */
  includeLateFees: boolean;
};

export const DEFAULT_PLAN_REQUEST_SETTINGS: PlanRequestSettings = { enabled: true, maxInstallments: 6, minInstallmentAmount: toKurus(50_000), includeLateFees: true };
export const MIN_REQUEST_INSTALLMENTS = 2;

/** PK = `APT#<apartmentId>`, SK = `PLANREQCFG` */
export type PlanRequestSettingsDoc = TableKeys &
  PlanRequestSettings & { entityType: 'PLAN_REQUEST_SETTINGS'; apartmentId: string; updatedAt: IsoDateTime; updatedBy: string; version: number };

/** PK = `APT#<apartmentId>`, SK = `PLANREQHEAD#<accountId>` (cari basina tek acik talep). */
export type PlanRequestHead = TableKeys & {
  entityType: 'PLAN_REQUEST_HEAD';
  apartmentId: string;
  accountId: string;
  /** Bu caride acilmis talep sayisi (sira). */
  seq: number;
  openRequestId?: string;
  updatedAt: IsoDateTime;
  version: number;
};

export const PLAN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type PlanRequestStatus = (typeof PLAN_REQUEST_STATUSES)[number];

export type PlanRequestDecision = {
  at: IsoDateTime;
  by: string;
  /** as_is: talep edildigi gibi; changed: yonetim degisikligiyle; rejected; withdrawn (sakin geri cekti). */
  mode: 'as_is' | 'changed' | 'rejected' | 'withdrawn';
  reason: string;
  planId?: string;
  installments?: number;
  firstDueDate?: IsoDate;
  total?: Kurus;
};

/** PK = `APT#<apartmentId>`, SK = `PLANREQ#<requestId>` */
export type PlanRequest = TableKeys & {
  entityType: 'PLAN_REQUEST';
  requestId: string;
  apartmentId: string;
  /** Talebi acan sakin. */
  userId: string;
  unitId: string;
  accountId: string;
  liableParty: LiableParty;
  /** Istenen taksit sayisi. */
  installments: number;
  note?: string;
  /** Talep anindaki tahmin (bilgi amacli; plan onay aninda defterden yeniden hesaplanir). */
  estimate: { overdue: Kurus; accruedLateFee: Kurus; total: Kurus; installmentAmount: Kurus };
  status: PlanRequestStatus;
  decision?: PlanRequestDecision;
  /** Sakinin idempotency anahtari ve istek ozeti (tekrar gonderim ayni talebi dondurur). */
  clientKey: string;
  fingerprint: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const planRequestKeys = {
  request: (apartmentId: string, requestId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('PLANREQ', requestId) }),
  head: (apartmentId: string, accountId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('PLANREQHEAD', accountId) }),
  settings: (apartmentId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: 'PLANREQCFG' }),
};

export type PlanRequestRepository = {
  get(apartmentId: string, requestId: string): Promise<PlanRequest | undefined>;
  list(apartmentId: string): Promise<PlanRequest[]>;
  getHead(apartmentId: string, accountId: string): Promise<PlanRequestHead | undefined>;
  getSettings(apartmentId: string): Promise<PlanRequestSettingsDoc | undefined>;
};

export const planRequestRepository: PlanRequestRepository = {
  get: (apartmentId, requestId) => getTenantItem<PlanRequest>(planRequestKeys.request(apartmentId, requestId)),
  // `PLANREQ#` oneki `PLANREQHEAD#` / `PLANREQCFG` kayitlarini kapsamaz.
  list: async (apartmentId) =>
    (await queryTenantAll<PlanRequest>(apartmentId, 'PLANREQ#', { ConsistentRead: true })).filter((r) => r.entityType === 'PLAN_REQUEST'),
  getHead: (apartmentId, accountId) => getTenantItem<PlanRequestHead>(planRequestKeys.head(apartmentId, accountId)),
  getSettings: (apartmentId) => getTenantItem<PlanRequestSettingsDoc>(planRequestKeys.settings(apartmentId)),
};

// ---------------------------------------------------------------------------
// Saf yardimcilar
// ---------------------------------------------------------------------------

/**
 * Sinirlar icindeki en fazla taksit: ayar, plan ust siniri (60) ve en dusuk taksit tutari.
 * Taksitler kurus kaybi olmadan bolunur; en kucuk taksit = floor(toplam / n).
 */
export function maxAllowedInstallments(total: number, s: Pick<PlanRequestSettings, 'maxInstallments' | 'minInstallmentAmount'>): number {
  if (total <= 0) return 0;
  const byAmount = s.minInstallmentAmount > 0 ? Math.floor(total / s.minInstallmentAmount) : MAX_INSTALLMENTS;
  return Math.max(0, Math.min(s.maxInstallments, MAX_INSTALLMENTS, byAmount));
}

/** Bir sonraki ayin aidat son odeme gunu (ilk taksit vadesi varsayilani). */
export function defaultFirstDueDate(today: IsoDate, dueDayOfMonth = 10): IsoDate {
  const next = addMonths(`${today.slice(0, 8)}01`, 1);
  const day = Math.min(Math.max(1, Math.trunc(dueDayOfMonth)), 28);
  return `${next.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type PlanRequestContext = { apartmentId: string; userId: string };

export type PlanRequestServiceDeps = {
  plans: Pick<PlanService, 'openItems' | 'createFromRequest' | 'get'>;
  financeRepo: Pick<FinanceRepository, 'postBatch' | 'getAccount'>;
  requests: PlanRequestRepository;
  portal?: Pick<PortalService, 'resolveUnit'>;
  core: Partial<Pick<CoreRepository, 'getSite'>>;
  now: () => Date;
  newId: () => string;
};

const LIABLE_PARTIES: readonly LiableParty[] = ['owner', 'occupant'];
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accountTag = (accountId: string) => createHash('sha256').update(accountId).digest('hex').slice(0, 24);

function reqKey(o: Record<string, unknown>): string {
  const key = reqString(o, 'idempotencyKey', 100);
  if (key.length < 8 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ValidationError('idempotencyKey 8-100 karakter, yalnizca harf/rakam/-/_ olmalidir', 'idempotencyKey');
  }
  return key;
}

function intField(o: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ValidationError(`${key} ${min}-${max} arasi tam sayi olmalidir`, key);
  return v;
}

function boolField(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${key} boolean olmalidir`, key);
  return v;
}

export function createPlanRequestService(overrides: Partial<PlanRequestServiceDeps> & Pick<PlanRequestServiceDeps, 'plans'>) {
  const deps: PlanRequestServiceDeps = {
    financeRepo: financeRepository,
    requests: planRequestRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.financeRepo;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const shortId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const toEvent = (e: NewEvent): DomainEvent => buildEvent(e, deps.now) as DomainEvent;

  // ----- Ayarlar -----

  async function settingsOf(apartmentId: string): Promise<{ settings: PlanRequestSettings; version: number }> {
    const doc = await deps.requests.getSettings(apartmentId);
    if (!doc || doc.apartmentId !== apartmentId) return { settings: { ...DEFAULT_PLAN_REQUEST_SETTINGS }, version: 0 };
    const { enabled, maxInstallments, minInstallmentAmount, includeLateFees } = doc;
    return { settings: { enabled, maxInstallments, minInstallmentAmount, includeLateFees }, version: doc.version };
  }

  async function getSettings(ctx: PlanRequestContext) {
    return settingsOf(ctx.apartmentId);
  }

  async function updateSettings(ctx: PlanRequestContext, body: unknown) {
    const o = asObject(body);
    const version = o.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new ValidationError('version (okunan surum) zorunlu', 'version');
    const current = await settingsOf(ctx.apartmentId);
    if (current.version !== version) throw new FinanceError('conflict', 'Ayarlar baska bir kullanici tarafindan degistirildi; sayfayi yenileyin');
    const next: PlanRequestSettings = {
      enabled: boolField(o, 'enabled') ?? current.settings.enabled,
      maxInstallments: intField(o, 'maxInstallments', MIN_REQUEST_INSTALLMENTS, MAX_INSTALLMENTS) ?? current.settings.maxInstallments,
      minInstallmentAmount: toKurus(intField(o, 'minInstallmentAmount', 100, MAX_AMOUNT) ?? current.settings.minInstallmentAmount),
      includeLateFees: boolField(o, 'includeLateFees') ?? current.settings.includeLateFees,
    };
    const ts = stamp();
    const doc: PlanRequestSettingsDoc = {
      ...planRequestKeys.settings(ctx.apartmentId),
      entityType: 'PLAN_REQUEST_SETTINGS',
      apartmentId: ctx.apartmentId,
      ...next,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [],
        // Ayni surumden iki es zamanli kayit ayni anahtarla yarisir: ikincisi reddedilir.
        idempotency: { id: `PLNRQCFG_v${version + 1}`, fingerprint: fingerprint({ op: 'plan_request_settings', ...next }) },
        ...(version === 0 ? { newDocs: [doc] } : { replaceRecords: [{ item: doc, expectedVersion: version, label: 'plan_request_settings' }] }),
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.plan_request_settings',
          target: { type: 'plan_request_settings', id: ctx.apartmentId },
          actorId: ctx.userId,
          details: { before: current.settings, after: next },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) throw new FinanceError('conflict', 'Ayarlar es zamanli degisti; sayfayi yenileyin');
      throw err;
    }
    return { settings: next, version: version + 1 };
  }

  // ----- Ortak hesap -----

  /** Carinin talep icin durumu (yazmaz). */
  async function accountState(ctx: PlanRequestContext, accountId: string, settings: PlanRequestSettings) {
    const [open, head] = await Promise.all([
      // Hic hareketi olmayan (henuz acilmamis) cari: acik kalem yok.
      deps.plans.openItems(ctx, accountId).catch((err: unknown) => {
        if (err instanceof FinanceError && err.code === 'not_found') return { accountId, date: today(), lateFeeMonthlyBasisPoints: 0, accruedLateFee: toKurus(0), items: [] as Awaited<ReturnType<PlanService['openItems']>>['items'] } as Awaited<ReturnType<PlanService['openItems']>>;
        throw err;
      }),
      deps.requests.getHead(ctx.apartmentId, accountId),
    ]);
    const overdueItems = open.items.filter((i) => i.overdue && !i.planId && i.remaining > 0);
    const overdue = toKurus(overdueItems.reduce((s, i) => s + i.remaining, 0));
    const accruedLateFee = settings.includeLateFees ? open.accruedLateFee : toKurus(0);
    const total = toKurus(overdue + accruedLateFee);
    const maxInstallments = maxAllowedInstallments(total, settings);
    const pendingRequestId = head?.apartmentId === ctx.apartmentId ? head.openRequestId : undefined;
    let reason: 'disabled' | 'no_overdue' | 'active_plan' | 'pending_request' | 'too_small' | undefined;
    if (!settings.enabled) reason = 'disabled';
    else if (pendingRequestId) reason = 'pending_request';
    else if (open.activePlanId) reason = 'active_plan';
    else if (overdue <= 0) reason = 'no_overdue';
    else if (maxInstallments < MIN_REQUEST_INSTALLMENTS) reason = 'too_small';
    return { open, head, overdueItems, overdue, accruedLateFee: open.accruedLateFee, total, maxInstallments, pendingRequestId, eligible: !reason, reason };
  }

  function requirePortal(): Pick<PortalService, 'resolveUnit'> {
    if (!deps.portal) throw new FinanceError('unprocessable', 'Portal baglantisi yok');
    return deps.portal;
  }

  /** Sakinin gordugu (sorumlu oldugu) alt cariler. */
  async function residentAccounts(ctx: PortalContext, unitId?: string) {
    const resolved = await requirePortal().resolveUnit(ctx, unitId);
    return { unitId: resolved.unit.unitId, parties: resolved.parties.map((party) => ({ party, accountId: resolved.accounts[party] })) };
  }

  /** Sakin gorunumu: idempotency ozeti, yonetici kimligi ve ic alanlar yok. */
  function residentView(r: PlanRequest) {
    return {
      requestId: r.requestId,
      unitId: r.unitId,
      accountId: r.accountId,
      liableParty: r.liableParty,
      installments: r.installments,
      ...(r.note ? { note: r.note } : {}),
      estimate: r.estimate,
      status: r.status,
      ...(r.decision
        ? {
            decision: {
              at: r.decision.at,
              mode: r.decision.mode,
              reason: r.decision.reason,
              ...(r.decision.planId ? { planId: r.decision.planId } : {}),
              ...(r.decision.installments ? { installments: r.decision.installments } : {}),
              ...(r.decision.firstDueDate ? { firstDueDate: r.decision.firstDueDate } : {}),
              ...(r.decision.total !== undefined ? { total: r.decision.total } : {}),
            },
          }
        : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  function managerView(r: PlanRequest) {
    const { PK: _pk, SK: _sk, clientKey: _k, fingerprint: _f, ...rest } = r;
    return rest;
  }

  // ----- Sakin -----

  async function portalOptions(ctx: PortalContext, unitId?: string) {
    const { unitId: u, parties } = await residentAccounts(ctx, unitId);
    const { settings } = await settingsOf(ctx.apartmentId);
    const mine = (await deps.requests.list(ctx.apartmentId)).filter((r) => r.apartmentId === ctx.apartmentId && r.userId === ctx.userId);
    const accounts = await Promise.all(
      parties.map(async ({ party, accountId }) => {
        const st = await accountState(ctx, accountId, settings);
        const own = st.pendingRequestId ? mine.find((r) => r.requestId === st.pendingRequestId) : undefined;
        return {
          accountId,
          liableParty: party,
          overdue: st.overdue,
          accruedLateFee: st.accruedLateFee,
          total: st.total,
          maxInstallments: st.maxInstallments,
          eligible: st.eligible,
          ...(st.reason ? { reason: st.reason } : {}),
          // Ayni cariyi goren baska uyenin talebi: yalnizca var oldugu bilinir (KVKK).
          ...(st.pendingRequestId ? { pendingRequest: own ? ('mine' as const) : ('other' as const) } : {}),
          ...(own ? { pendingRequestId: own.requestId } : {}),
        };
      }),
    );
    return {
      unitId: u,
      settings: { enabled: settings.enabled, maxInstallments: settings.maxInstallments, minInstallmentAmount: settings.minInstallmentAmount, includeLateFees: settings.includeLateFees },
      minInstallments: MIN_REQUEST_INSTALLMENTS,
      accounts,
    };
  }

  async function myRequests(ctx: PortalContext) {
    const items = (await deps.requests.list(ctx.apartmentId))
      .filter((r) => r.apartmentId === ctx.apartmentId && r.userId === ctx.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(residentView);
    return { items };
  }

  async function createRequest(ctx: PortalContext, body: unknown): Promise<{ request: ReturnType<typeof residentView>; replayed: boolean }> {
    const o = asObject(body);
    const key = reqKey(o);
    const unitId = o.unitId === undefined ? undefined : assertId(o.unitId, 'unitId');
    const party = o.liableParty === undefined ? undefined : o.liableParty;
    if (party !== undefined && !(LIABLE_PARTIES as readonly unknown[]).includes(party)) throw new ValidationError('liableParty owner veya occupant olmalidir', 'liableParty');
    const installments = intField(o, 'installments', 1, MAX_INSTALLMENTS);
    if (installments === undefined) throw new ValidationError('installments zorunlu', 'installments');
    const note = (optString(o, 'note', 300) ?? '').trim();
    const fp = fingerprint({ op: 'plan_request', unitId, party, installments, note });

    // Tekrar gonderim: ayni sakinin ayni anahtarli talebi.
    const replay = async () => {
      const prior = (await deps.requests.list(ctx.apartmentId)).find((r) => r.apartmentId === ctx.apartmentId && r.userId === ctx.userId && r.clientKey === key);
      if (!prior) return undefined;
      if (prior.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
      return { request: residentView(prior), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    const resolved = await residentAccounts(ctx, unitId);
    const choice = party ? resolved.parties.find((p) => p.party === party) : resolved.parties.length === 1 ? resolved.parties[0] : undefined;
    if (!choice) {
      if (party) throw new ValidationError('Bu dairede bu cariyi göremezsiniz', 'liableParty');
      throw new ValidationError('Birden fazla cariniz var; liableParty seçin', 'liableParty');
    }
    const { settings } = await settingsOf(ctx.apartmentId);
    const st = await accountState(ctx, choice.accountId, settings);
    if (st.reason === 'disabled') throw new FinanceError('unprocessable', 'Yönetim şu anda yapılandırma talebi kabul etmiyor');
    if (st.reason === 'pending_request') throw new FinanceError('conflict', 'Bu cari için bekleyen bir yapılandırma talebi var');
    if (st.reason === 'active_plan') throw new FinanceError('conflict', 'Bu caride zaten aktif bir taksit planı var');
    if (st.reason === 'no_overdue') throw new FinanceError('unprocessable', 'Vadesi geçmiş borcunuz yok; yapılandırma talebi açılamaz');
    if (st.reason === 'too_small') throw new FinanceError('unprocessable', 'Gecikmiş borç tutarı taksitlendirme için çok düşük');
    if (installments < MIN_REQUEST_INSTALLMENTS || installments > st.maxInstallments) {
      throw new ValidationError(`Taksit sayısı ${MIN_REQUEST_INSTALLMENTS}-${st.maxInstallments} arasında olmalıdır`, 'installments');
    }

    const requestId = shortId();
    const ts = stamp();
    const request: PlanRequest = {
      ...planRequestKeys.request(ctx.apartmentId, requestId),
      entityType: 'PLAN_REQUEST',
      requestId,
      apartmentId: ctx.apartmentId,
      userId: ctx.userId,
      unitId: resolved.unitId,
      accountId: choice.accountId,
      liableParty: choice.party,
      installments,
      ...(note ? { note } : {}),
      estimate: { overdue: st.overdue, accruedLateFee: st.accruedLateFee, total: st.total, installmentAmount: toKurus(Math.floor(st.total / installments)) },
      status: 'pending',
      clientKey: key,
      fingerprint: fp,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    const seq = (st.head?.seq ?? 0) + 1;
    const head: PlanRequestHead = {
      ...planRequestKeys.head(ctx.apartmentId, choice.accountId),
      entityType: 'PLAN_REQUEST_HEAD',
      apartmentId: ctx.apartmentId,
      accountId: choice.accountId,
      seq,
      openRequestId: requestId,
      updatedAt: ts,
      version: (st.head?.version ?? 0) + 1,
    };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: `PLNRQ_${accountTag(choice.accountId)}_${seq}`, fingerprint: fp, recordId: requestId },
        newDocs: [request, ...(st.head ? [] : [head])],
        ...(st.head ? { replaceRecords: [{ item: head, expectedVersion: st.head.version, label: 'plan_request_head' }] } : {}),
        outbox: [
          toEvent({ eventId: `RESTRUCTURE_REQUESTED:${requestId}`, type: 'RESTRUCTURE_REQUESTED', apartmentId: ctx.apartmentId, actorId: ctx.userId, groupKey: resolved.unitId, payload: { requestId } }),
        ],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.plan_request',
          target: { type: 'plan_request', id: requestId },
          actorId: ctx.userId,
          details: { accountId: choice.accountId, unitId: resolved.unitId, installments, estimate: request.estimate, settings },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        // Ayni anahtarla es zamanli tekrar: kaydedilmis talep doner; baska talep yaristiysa 409.
        const again = await replay();
        if (again) return again;
        throw new FinanceError('conflict', 'Bu cari için bekleyen bir yapılandırma talebi var');
      }
      throw err;
    }
    return { request: residentView(request), replayed: false };
  }

  async function requireRequest(ctx: PlanRequestContext, requestId: string): Promise<PlanRequest> {
    assertId(requestId, 'requestId');
    const r = await deps.requests.get(ctx.apartmentId, requestId);
    if (!r || r.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Yapılandırma talebi bulunamadı');
    return r;
  }

  /** Talep sonuclaninca cari basligi serbest kalir (yeni talep acilabilir). */
  async function releasedHead(ctx: PlanRequestContext, r: PlanRequest, ts: IsoDateTime): Promise<ReplaceRecord[]> {
    const head = await deps.requests.getHead(ctx.apartmentId, r.accountId);
    if (!head || head.openRequestId !== r.requestId) return [];
    const { openRequestId: _o, ...rest } = head;
    const next: PlanRequestHead = { ...rest, updatedAt: ts, version: head.version + 1 };
    return [{ item: next, expectedVersion: head.version, label: 'plan_request_head' }];
  }

  async function withdraw(ctx: PortalContext, requestId: string, body: unknown) {
    const o = body === undefined ? {} : asObject(body);
    const reason = (optString(o, 'reason', 300) ?? '').trim() || 'Sakin talebini geri çekti';
    const r = await requireRequest(ctx, requestId);
    // Baskasinin talebi ile var olmayan talep ayni yaniti alir.
    if (r.userId !== ctx.userId) throw new FinanceError('not_found', 'Yapılandırma talebi bulunamadı');
    if (r.status !== 'pending') throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış');
    const ts = stamp();
    const next: PlanRequest = { ...r, status: 'withdrawn', decision: { at: ts, by: ctx.userId, mode: 'withdrawn', reason }, updatedAt: ts, updatedBy: ctx.userId, version: r.version + 1 };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: `PLNRQ_DEC_${requestId}`, fingerprint: fingerprint({ op: 'plan_request_withdraw', requestId }), recordId: requestId },
        replaceRecords: [{ item: next, expectedVersion: r.version, label: 'plan_request' }, ...(await releasedHead(ctx, r, ts))],
        audit: { apartmentId: ctx.apartmentId, action: 'finance.plan_request_withdraw', target: { type: 'plan_request', id: requestId }, actorId: ctx.userId, reason, details: { accountId: r.accountId } },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış veya eş zamanlı değişti');
      throw err;
    }
    return residentView(next);
  }

  // ----- Yonetim -----

  async function list(ctx: PlanRequestContext, q: { status?: string } = {}) {
    if (q.status !== undefined && !(PLAN_REQUEST_STATUSES as readonly string[]).includes(q.status)) {
      throw new ValidationError(`status su degerlerden biri olmalidir: ${PLAN_REQUEST_STATUSES.join(', ')}`, 'status');
    }
    const items = (await deps.requests.list(ctx.apartmentId))
      .filter((r) => r.apartmentId === ctx.apartmentId && (!q.status || r.status === q.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(managerView);
    return { items, pendingCount: items.filter((r) => r.status === 'pending').length };
  }

  /** Talep + carinin guncel durumu + "oldugu gibi onay" varsayilanlari (sihirbaz onizlemesi icin). */
  async function get(ctx: PlanRequestContext, requestId: string) {
    const r = await requireRequest(ctx, requestId);
    const { settings } = await settingsOf(ctx.apartmentId);
    if (r.status !== 'pending') return { request: managerView(r), settings };
    const [st, site] = await Promise.all([accountState(ctx, r.accountId, settings), deps.core.getSite ? deps.core.getSite(ctx.apartmentId) : undefined]);
    return {
      request: managerView(r),
      settings,
      current: {
        overdue: st.overdue,
        accruedLateFee: st.accruedLateFee,
        total: st.total,
        ...(st.open.activePlanId ? { activePlanId: st.open.activePlanId } : {}),
        items: st.open.items,
      },
      asIs: {
        accountId: r.accountId,
        chargeIds: st.overdueItems.map((i) => i.chargeId),
        installments: r.installments,
        firstDueDate: defaultFirstDueDate(today(), site?.settings.dueDayOfMonth),
        includeLateFees: settings.includeLateFees,
      },
    };
  }

  async function approve(ctx: PlanRequestContext, requestId: string, body: unknown) {
    const o = body === undefined ? {} : asObject(body);
    const r = await requireRequest(ctx, requestId);
    if (r.status !== 'pending') throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış');
    const { settings } = await settingsOf(ctx.apartmentId);
    const [st, site] = await Promise.all([accountState(ctx, r.accountId, settings), deps.core.getSite ? deps.core.getSite(ctx.apartmentId) : undefined]);
    const asIsIds = st.overdueItems.map((i) => i.chargeId);
    const firstDefault = defaultFirstDueDate(today(), site?.settings.dueDayOfMonth);
    const installments = intField(o, 'installments', 1, MAX_INSTALLMENTS) ?? r.installments;
    const firstDueDate = o.firstDueDate === undefined ? firstDefault : o.firstDueDate;
    if (typeof firstDueDate !== 'string' || !isIsoDate(firstDueDate)) throw new ValidationError('firstDueDate YYYY-MM-DD olmalidir', 'firstDueDate');
    const chargeIds = o.chargeIds === undefined ? asIsIds : o.chargeIds;
    if (!Array.isArray(chargeIds) || chargeIds.length === 0) {
      throw new FinanceError('unprocessable', 'Carinin vadesi geçmiş açık kalemi kalmamış; kalem seçerek onaylayın veya reddedin');
    }
    const includeLateFees = boolField(o, 'includeLateFees') ?? settings.includeLateFees;
    const rule = o.rule as PlanRule | undefined;
    const reason = (optString(o, 'reason', 300) ?? '').trim() || `Sakin yapılandırma talebi onaylandı${r.note ? `: ${r.note}` : ''}`.slice(0, 300);
    const sameIds = chargeIds.length === asIsIds.length && [...chargeIds].sort().join(',') === [...asIsIds].sort().join(',');
    const mode: 'as_is' | 'changed' =
      installments === r.installments && firstDueDate === firstDefault && sameIds && includeLateFees === settings.includeLateFees && rule === undefined ? 'as_is' : 'changed';

    const ts = stamp();
    const headReplace = await releasedHead(ctx, r, ts);
    const result = await deps.plans.createFromRequest(
      ctx,
      {
        idempotencyKey: `rq-${requestId}`,
        accountId: r.accountId,
        chargeIds,
        installments,
        firstDueDate,
        includeLateFees,
        ...(rule !== undefined ? { rule } : {}),
        reason,
      },
      {
        build: (plan) => {
          const next: PlanRequest = {
            ...r,
            status: 'approved',
            decision: { at: ts, by: ctx.userId, mode, reason, planId: plan.planId, installments: plan.installments.length, firstDueDate, total: plan.total },
            updatedAt: ts,
            updatedBy: ctx.userId,
            version: r.version + 1,
          };
          return {
            replaceRecords: [{ item: next, expectedVersion: r.version, label: 'plan_request' }, ...headReplace],
            outbox: [toEvent({ eventId: `RESTRUCTURE_APPROVED:${requestId}`, type: 'RESTRUCTURE_APPROVED', apartmentId: ctx.apartmentId, actorId: ctx.userId, groupKey: r.unitId, payload: { requestId } })],
            audit: {
              action: 'finance.plan_request_approve',
              target: { type: 'plan_request', id: requestId },
              details: { requestId, mode, requestedInstallments: r.installments, requesterId: r.userId },
            },
          };
        },
      },
    ).catch((err: unknown) => {
      if (err instanceof FinanceError && err.code === 'conflict' && /es zamanli|eş zamanlı/i.test(err.message)) {
        throw new FinanceError('conflict', 'Talep eş zamanlı sonuçlandırıldı; listeyi yenileyin');
      }
      throw err;
    });
    if (result.replayed) {
      // Ayni onay daha once yazildi (es zamanli ikinci onay): talep o planla onaylanmissa ayni sonuc.
      const after = await requireRequest(ctx, requestId);
      if (after.status !== 'approved' || after.decision?.planId !== result.plan.planId) throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış');
      return { request: managerView(after), plan: await deps.plans.get(ctx, result.plan.planId), replayed: true };
    }
    const after = (await deps.requests.get(ctx.apartmentId, requestId)) ?? r;
    return { request: managerView(after), plan: await deps.plans.get(ctx, result.plan.planId), replayed: false };
  }

  async function reject(ctx: PlanRequestContext, requestId: string, body: unknown) {
    const o = asObject(body);
    const reason = (optString(o, 'reason', 300) ?? '').trim();
    if (reason.length < 5) throw new ValidationError('Ret gerekçesi en az 5 karakter olmalidir', 'reason');
    const r = await requireRequest(ctx, requestId);
    if (r.status !== 'pending') throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış');
    const ts = stamp();
    const next: PlanRequest = { ...r, status: 'rejected', decision: { at: ts, by: ctx.userId, mode: 'rejected', reason }, updatedAt: ts, updatedBy: ctx.userId, version: r.version + 1 };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: `PLNRQ_DEC_${requestId}`, fingerprint: fingerprint({ op: 'plan_request_reject', requestId }), recordId: requestId },
        replaceRecords: [{ item: next, expectedVersion: r.version, label: 'plan_request' }, ...(await releasedHead(ctx, r, ts))],
        outbox: [toEvent({ eventId: `RESTRUCTURE_REJECTED:${requestId}`, type: 'RESTRUCTURE_REJECTED', apartmentId: ctx.apartmentId, actorId: ctx.userId, groupKey: r.unitId, payload: { requestId } })],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.plan_request_reject',
          target: { type: 'plan_request', id: requestId },
          actorId: ctx.userId,
          reason,
          details: { accountId: r.accountId, requesterId: r.userId, installments: r.installments },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış veya eş zamanlı değişti');
      throw err;
    }
    return { request: managerView(next) };
  }

  return { getSettings, updateSettings, portalOptions, myRequests, createRequest, withdraw, list, get, approve, reject };
}

export type PlanRequestService = ReturnType<typeof createPlanRequestService>;
