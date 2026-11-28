/**
 * Finans 2.2 sonrasi - Sakin portalindan yapilandirma (taksit) talebi.
 *
 * Akis:
 *  1. Yonetim talepleri acar (`PLANREQCFG.enabled`, VARSAYILAN KAPALI) ve sinirlari belirler: en
 *     fazla taksit, en dusuk taksit tutari, dondurulan gecikme tazminatinin taksitlere dahil olup
 *     olmadigi. Portal uclari ayrica `resident.restructure` VE `admin.debtRestructure` ister.
 *  2. Sakin (vadesi gecmis borcu olan alt carinin sorumlu tarafi) taksit sayisi (+ istege bagli not)
 *     ile talep acar. Talep anindaki vadesi gecmis kalemler (`chargeIds`) ve tahmin kayda yazilir.
 *  3. Cari basina tek acik talep: `PLANREQHEAD#<cari>` (sira, acik talep, son talepler) surum
 *     kosullu yazilir; ayni anda iki talep ayni sira numarasiyla (`PLNRQ_<cari ozeti>_<sira>`
 *     idempotency) yarisir, ikincisi 409 alir. Sakin anahtari ayri kayitta (`PLANREQKEY#`).
 *  4. Yonetim talebi oldugu gibi veya degisiklikle onaylar ya da gerekceyle reddeder. Onay, planlari
 *     olusturan MEVCUT yapilandirma servisinden (`plans.ts createFromRequest`) gecer: ayni defter
 *     kayitlari; talep, cari basligi, bildirim olayi ve denetim ayni atomik yazimdadir. "Oldugu gibi"
 *     yalnizca talepteki kalemleri kapsar; borc talepten sonra degistiyse onay `changed` sayilir.
 *     Taksit sayisi yonetim sinirlarina (en fazla taksit, en dusuk taksit) uyar.
 *  5. Bildirim (outbox, kategori `finance`): talep -> yonetim (`RESTRUCTURE_REQUESTED`), onay / ret ->
 *     talebi acan sakin (`RESTRUCTURE_APPROVED` / `_REJECTED`).
 *
 * KVKK: talebi yalnizca acan sakin (kendi talepleri) ve yonetim (yonetici + firma; denetci degil)
 * gorur. Sakin notu YALNIZCA `PLANREQ#` kaydinda kalir: defter islemi, plan ve denetim kaydi
 * (denetci okuyabilir) notu tasimaz. Ayni cariyi goren diger uyeye yalnizca "bekleyen talep var".
 */
import { createHash, randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type DomainEvent, type NewEvent, buildEvent } from '../../events/publisher.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, type TableKeys, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqString } from '../core/validation.js';
import { PortalError, type PortalContext, type PortalService } from '../portal/service.js';
import { MAX_INSTALLMENTS, type PlanRule, type PlanService, addMonths } from './plans.js';
import { type FinanceRepository, LedgerConflictError, type ReplaceRecord, financeRepository } from './repository.js';
import { FinanceError, MAX_AMOUNT } from './service.js';

// ---------------------------------------------------------------------------
// Kayitlar
// ---------------------------------------------------------------------------

export type PlanRequestSettings = {
  /** Kapaliysa (varsayilan) sakin talep acamaz; mevcut talepler sonuclandirilabilir. */
  enabled: boolean;
  /** Sakinin isteyebilecegi en fazla taksit (2-60). */
  maxInstallments: number;
  /** En kucuk taksit tutari (kurus); taksit sayisi buna gore sinirlanir. */
  minInstallmentAmount: Kurus;
  /** Yapilandirma aninda dondurulan gecikme tazminati taksitlere dahil edilir mi (plan kurali). */
  includeLateFees: boolean;
};

/** Sahip karari: yapilandirma talebi varsayilan kapali; yonetim acar (eski siteler dahil). */
export const DEFAULT_PLAN_REQUEST_SETTINGS: PlanRequestSettings = { enabled: false, maxInstallments: 6, minInstallmentAmount: toKurus(50_000), includeLateFees: true };
export const MIN_REQUEST_INSTALLMENTS = 2;
const HEAD_HISTORY = 20;
const DEFAULT_LIST_LIMIT = 100;

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
  /** Son talepler (yeniden eskiye, en fazla 20): sakin listesi tum talepleri taramaz. */
  history?: string[];
  updatedAt: IsoDateTime;
  version: number;
};

/** PK = `APT#<apartmentId>`, SK = `PLANREQKEY#<ozet(kullanici:anahtar)>`: sakin anahtarinin tekrar gonderimi. */
export type PlanRequestKey = TableKeys & { entityType: 'PLAN_REQUEST_KEY'; apartmentId: string; requestId: string; fingerprint: string; createdAt: IsoDateTime };

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
  /** Sakin notu (KVKK: yalnizca bu kayitta; defter / plan / denetime girmez). */
  note?: string;
  /** Talep anindaki vadesi gecmis (plana bagli olmayan) kalemler: "oldugu gibi" onayin kapsami. */
  chargeIds: string[];
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
  key: (apartmentId: string, tag: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('PLANREQKEY', tag) }),
  settings: (apartmentId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: 'PLANREQCFG' }),
};

export type PlanRequestRepository = {
  get(apartmentId: string, requestId: string): Promise<PlanRequest | undefined>;
  /** Tum talepler (yalnizca yonetim listesinde, durum filtresi `pending` disinda). */
  list(apartmentId: string): Promise<PlanRequest[]>;
  getHead(apartmentId: string, accountId: string): Promise<PlanRequestHead | undefined>;
  /** Cari basliklari (talep acilmis cari sayisi kadar): bekleyen talepler buradan bulunur. */
  listHeads(apartmentId: string): Promise<PlanRequestHead[]>;
  getKey(apartmentId: string, tag: string): Promise<PlanRequestKey | undefined>;
  getSettings(apartmentId: string): Promise<PlanRequestSettingsDoc | undefined>;
};

export const planRequestRepository: PlanRequestRepository = {
  get: (apartmentId, requestId) => getTenantItem<PlanRequest>(planRequestKeys.request(apartmentId, requestId)),
  // `PLANREQ#` oneki `PLANREQHEAD#` / `PLANREQKEY#` / `PLANREQCFG` kayitlarini kapsamaz.
  list: async (apartmentId) =>
    (await queryTenantAll<PlanRequest>(apartmentId, 'PLANREQ#', { ConsistentRead: true })).filter((r) => r.entityType === 'PLAN_REQUEST'),
  getHead: (apartmentId, accountId) => getTenantItem<PlanRequestHead>(planRequestKeys.head(apartmentId, accountId)),
  listHeads: async (apartmentId) =>
    (await queryTenantAll<PlanRequestHead>(apartmentId, 'PLANREQHEAD#', { ConsistentRead: true })).filter((h) => h.entityType === 'PLAN_REQUEST_HEAD'),
  getKey: (apartmentId, tag) => getTenantItem<PlanRequestKey>(planRequestKeys.key(apartmentId, tag)),
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

/** Onayda varsayilan gerekce: sakin notu defter / plan / denetime girmez (KVKK). */
export const approvalReason = (requestId: string) => `Sakin talebi ${requestId} onaylandı`;

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
const tagOf = (value: string, n = 24) => createHash('sha256').update(value).digest('hex').slice(0, n);

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

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

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

  type OpenItems = Awaited<ReturnType<PlanService['openItems']>>;

  /** Carinin talep icin durumu (yazmaz). */
  async function accountState(ctx: PlanRequestContext, accountId: string, settings: PlanRequestSettings) {
    const [open, head] = await Promise.all([
      // Hic hareketi olmayan (henuz acilmamis) cari: acik kalem yok.
      deps.plans.openItems(ctx, accountId).catch((err: unknown): OpenItems => {
        if (err instanceof FinanceError && err.code === 'not_found') return { accountId, date: today(), lateFeeMonthlyBasisPoints: 0, accruedLateFee: toKurus(0), items: [] };
        throw err;
      }),
      deps.requests.getHead(ctx.apartmentId, accountId),
    ]);
    const overdueItems = open.items.filter((i) => i.overdue && !i.planId && i.remaining > 0);
    const overdue = toKurus(overdueItems.reduce((s, i) => s + i.remaining, 0));
    const total = toKurus(overdue + (settings.includeLateFees ? open.accruedLateFee : 0));
    const maxInstallments = maxAllowedInstallments(total, settings);
    const validHead = head?.apartmentId === ctx.apartmentId ? head : undefined;
    const pendingRequestId = validHead?.openRequestId;
    let reason: 'disabled' | 'no_overdue' | 'active_plan' | 'pending_request' | 'too_small' | undefined;
    if (!settings.enabled) reason = 'disabled';
    else if (pendingRequestId) reason = 'pending_request';
    else if (open.activePlanId) reason = 'active_plan';
    else if (overdue <= 0) reason = 'no_overdue';
    else if (maxInstallments < MIN_REQUEST_INSTALLMENTS) reason = 'too_small';
    return { open, head: validHead, overdueItems, overdue, accruedLateFee: open.accruedLateFee, total, maxInstallments, pendingRequestId, eligible: !reason, reason };
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

  /** Yonetim talep almiyorsa (varsayilan) portal secenek / talep uclari 403. */
  async function requireEnabled(apartmentId: string) {
    const s = await settingsOf(apartmentId);
    if (!s.settings.enabled) throw new PortalError('forbidden', 'Yönetim şu anda taksit (yapılandırma) talebi almıyor');
    return s;
  }

  /** Sakin gorunumu: idempotency ozeti, kalem listesi, yonetici kimligi ve ic alanlar yok. */
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

  const ownRequest = async (apartmentId: string, requestId: string | undefined) => (requestId ? deps.requests.get(apartmentId, requestId) : undefined);

  // ----- Sakin -----

  async function portalOptions(ctx: PortalContext, unitId?: string) {
    const { settings } = await requireEnabled(ctx.apartmentId);
    const { unitId: u, parties } = await residentAccounts(ctx, unitId);
    const accounts = await Promise.all(
      parties.map(async ({ party, accountId }) => {
        const st = await accountState(ctx, accountId, settings);
        const pending = await ownRequest(ctx.apartmentId, st.pendingRequestId);
        const own = pending && pending.userId === ctx.userId ? pending : undefined;
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

  /**
   * Sakinin bu dairedeki talepleri: carilerin basliklarindaki son talepler (tum talepler taranmaz),
   * yalnizca kendi actiklari. Talep almayi kapatan yonetimde de sakin kararini gorebilir.
   */
  async function myRequests(ctx: PortalContext, unitId?: string) {
    const { parties } = await residentAccounts(ctx, unitId);
    const heads = await Promise.all(parties.map((p) => deps.requests.getHead(ctx.apartmentId, p.accountId)));
    const ids = [...new Set(heads.flatMap((h) => (h && h.apartmentId === ctx.apartmentId ? (h.history ?? []) : [])))];
    const items = (await Promise.all(ids.map((id) => deps.requests.get(ctx.apartmentId, id))))
      .filter((r): r is PlanRequest => !!r && r.apartmentId === ctx.apartmentId && r.userId === ctx.userId)
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
    const keyTag = tagOf(`${ctx.userId}:${key}`, 32);

    // Tekrar gonderim: ayni sakinin ayni anahtarli talebi (tek okuma; talepler taranmaz).
    const replay = async () => {
      const k = await deps.requests.getKey(ctx.apartmentId, keyTag);
      if (!k || k.apartmentId !== ctx.apartmentId) return undefined;
      if (k.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
      const prior = await deps.requests.get(ctx.apartmentId, k.requestId);
      if (!prior || prior.userId !== ctx.userId) throw new FinanceError('conflict', 'Talep kaydi bulunamadi');
      return { request: residentView(prior), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    const { settings } = await requireEnabled(ctx.apartmentId);
    const resolved = await residentAccounts(ctx, unitId);
    const choice = party ? resolved.parties.find((p) => p.party === party) : resolved.parties.length === 1 ? resolved.parties[0] : undefined;
    if (!choice) {
      if (party) throw new ValidationError('Bu dairede bu cariyi göremezsiniz', 'liableParty');
      throw new ValidationError('Birden fazla cariniz var; liableParty seçin', 'liableParty');
    }
    const st = await accountState(ctx, choice.accountId, settings);
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
      chargeIds: st.overdueItems.map((i) => i.chargeId),
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
      history: [requestId, ...(st.head?.history ?? [])].slice(0, HEAD_HISTORY),
      updatedAt: ts,
      version: (st.head?.version ?? 0) + 1,
    };
    const keyDoc: PlanRequestKey = { ...planRequestKeys.key(ctx.apartmentId, keyTag), entityType: 'PLAN_REQUEST_KEY', apartmentId: ctx.apartmentId, requestId, fingerprint: fp, createdAt: ts };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: `PLNRQ_${tagOf(choice.accountId)}_${seq}`, fingerprint: fp, recordId: requestId },
        newDocs: [request, keyDoc, ...(st.head ? [] : [head])],
        ...(st.head ? { replaceRecords: [{ item: head, expectedVersion: st.head.version, label: 'plan_request_head' }] } : {}),
        outbox: [
          toEvent({ eventId: `RESTRUCTURE_REQUESTED:${requestId}`, type: 'RESTRUCTURE_REQUESTED', apartmentId: ctx.apartmentId, actorId: ctx.userId, groupKey: resolved.unitId, payload: { requestId } }),
        ],
        // Not denetime yazilmaz (KVKK: denetci okur); yalnizca talep kaydinda.
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

  /** Talep sonuclaninca cari basligi serbest kalir (yeni talep acilabilir; gecmis korunur). */
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
        audit: { apartmentId: ctx.apartmentId, action: 'finance.plan_request_withdraw', target: { type: 'plan_request', id: requestId }, actorId: ctx.userId, details: { accountId: r.accountId } },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış veya eş zamanlı değişti');
      throw err;
    }
    return residentView(next);
  }

  // ----- Yonetim -----

  /**
   * `pending`: cari basliklarindan (talep acilmis cari sayisi kadar okuma). Diger durumlar / tumu:
   * yonetim listesi icin tum talepler taranir, en yeni `limit` kadari doner (varsayilan 100, en fazla 500).
   */
  async function list(ctx: PlanRequestContext, q: { status?: string; limit?: string } = {}) {
    if (q.status !== undefined && !(PLAN_REQUEST_STATUSES as readonly string[]).includes(q.status)) {
      throw new ValidationError(`status su degerlerden biri olmalidir: ${PLAN_REQUEST_STATUSES.join(', ')}`, 'status');
    }
    const limit = q.limit === undefined ? DEFAULT_LIST_LIMIT : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError('limit 1-500 arasi tam sayi olmalidir', 'limit');
    const heads = (await deps.requests.listHeads(ctx.apartmentId)).filter((h) => h.apartmentId === ctx.apartmentId && h.openRequestId);
    const pending = (await Promise.all(heads.map((h) => deps.requests.get(ctx.apartmentId, h.openRequestId as string)))).filter(
      (r): r is PlanRequest => !!r && r.apartmentId === ctx.apartmentId && r.status === 'pending',
    );
    const source = q.status === 'pending' ? pending : (await deps.requests.list(ctx.apartmentId)).filter((r) => r.apartmentId === ctx.apartmentId && (!q.status || r.status === q.status));
    const items = source
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(managerView);
    return { items, pendingCount: pending.length };
  }

  /**
   * Talebin onay cercevesi: talepteki kalemlerden hala acik olanlar ("oldugu gibi"), talepten sonra
   * borcun degisip degismedigi ve yonetim sinirlarina gore en fazla taksit.
   */
  async function approvalFrame(ctx: PlanRequestContext, r: PlanRequest, settings: PlanRequestSettings) {
    const [st, site] = await Promise.all([accountState(ctx, r.accountId, settings), deps.core.getSite ? deps.core.getSite(ctx.apartmentId) : undefined]);
    const currentIds = st.overdueItems.map((i) => i.chargeId);
    const asIsItems = st.overdueItems.filter((i) => r.chargeIds.includes(i.chargeId));
    const asIsOverdue = asIsItems.reduce((s, i) => s + i.remaining, 0);
    const newItems = currentIds.filter((id) => !r.chargeIds.includes(id)).length;
    const drift = !sameSet(asIsItems.map((i) => i.chargeId), r.chargeIds) || newItems > 0 || asIsOverdue !== r.estimate.overdue;
    const totalOf = (ids: readonly string[], includeLateFees: boolean) =>
      st.open.items.filter((i) => ids.includes(i.chargeId)).reduce((s, i) => s + i.remaining, 0) + (includeLateFees ? st.open.accruedLateFee : 0);
    return {
      st,
      asIs: {
        accountId: r.accountId,
        chargeIds: asIsItems.map((i) => i.chargeId),
        installments: r.installments,
        firstDueDate: defaultFirstDueDate(today(), site?.settings.dueDayOfMonth),
        includeLateFees: settings.includeLateFees,
      },
      drift: { changed: drift, overdueThen: r.estimate.overdue, overdueNow: st.overdue, asIsOverdue: toKurus(asIsOverdue), newItems },
      totalOf,
    };
  }

  /** Talep + carinin guncel durumu + "oldugu gibi" varsayilanlari ve sinirlar (onizleme icin). */
  async function get(ctx: PlanRequestContext, requestId: string) {
    const r = await requireRequest(ctx, requestId);
    const { settings } = await settingsOf(ctx.apartmentId);
    if (r.status !== 'pending') return { request: managerView(r), settings };
    const f = await approvalFrame(ctx, r, settings);
    return {
      request: managerView(r),
      settings,
      current: {
        overdue: f.st.overdue,
        accruedLateFee: f.st.accruedLateFee,
        total: f.st.total,
        ...(f.st.open.activePlanId ? { activePlanId: f.st.open.activePlanId } : {}),
        items: f.st.open.items,
      },
      asIs: f.asIs,
      drift: f.drift,
      limits: { maxInstallments: maxAllowedInstallments(f.totalOf(f.asIs.chargeIds, f.asIs.includeLateFees), settings), minInstallmentAmount: settings.minInstallmentAmount },
    };
  }

  async function approve(ctx: PlanRequestContext, requestId: string, body: unknown) {
    const o = body === undefined ? {} : asObject(body);
    const r = await requireRequest(ctx, requestId);
    if (r.status !== 'pending') throw new FinanceError('conflict', 'Talep zaten sonuçlandırılmış');
    const { settings } = await settingsOf(ctx.apartmentId);
    const f = await approvalFrame(ctx, r, settings);
    const installments = intField(o, 'installments', 1, MAX_INSTALLMENTS) ?? r.installments;
    const firstDueDate = o.firstDueDate === undefined ? f.asIs.firstDueDate : o.firstDueDate;
    if (typeof firstDueDate !== 'string' || !isIsoDate(firstDueDate)) throw new ValidationError('firstDueDate YYYY-MM-DD olmalidir', 'firstDueDate');
    if (o.chargeIds !== undefined && (!Array.isArray(o.chargeIds) || o.chargeIds.some((c) => typeof c !== 'string'))) {
      throw new ValidationError('chargeIds metin dizisi olmalidir', 'chargeIds');
    }
    const chargeIds = (o.chargeIds as string[] | undefined) ?? f.asIs.chargeIds;
    if (chargeIds.length === 0) {
      throw new FinanceError('unprocessable', 'Talepteki gecikmiş kalemler kapanmış; kalem seçerek onaylayın veya reddedin');
    }
    const includeLateFees = boolField(o, 'includeLateFees') ?? settings.includeLateFees;
    const rule = o.rule as PlanRule | undefined;
    // Yonetim sinirlari (en fazla taksit, en dusuk taksit tutari) onayda da gecerli.
    const max = maxAllowedInstallments(f.totalOf(chargeIds, includeLateFees), settings);
    if (installments > max) {
      throw new ValidationError(
        max < 1 ? 'Seçilen tutar taksitlendirme sınırının altında' : `Taksit sayısı en fazla ${max} olabilir (en fazla ${settings.maxInstallments} taksit, bir taksit en az ${settings.minInstallmentAmount} kuruş)`,
        'installments',
      );
    }
    // Varsayilan gerekce sakin notunu ICERMEZ (defter / plan / denetim; KVKK).
    const reason = (optString(o, 'reason', 300) ?? '').trim() || approvalReason(requestId);
    const same =
      installments === r.installments && firstDueDate === f.asIs.firstDueDate && sameSet(chargeIds, f.asIs.chargeIds) && includeLateFees === settings.includeLateFees && rule === undefined;
    // Borc talepten sonra degistiyse (odeme, yeni gecikme) onay "degisiklikle" sayilir.
    const mode: 'as_is' | 'changed' = same && !f.drift.changed ? 'as_is' : 'changed';

    const ts = stamp();
    const headReplace = await releasedHead(ctx, r, ts);
    const result = await deps.plans
      .createFromRequest(
        ctx,
        {
          idempotencyKey: `request-${requestId}`,
          accountId: r.accountId,
          chargeIds,
          installments,
          firstDueDate,
          includeLateFees,
          ...(rule !== undefined ? { rule } : {}),
          reason,
        },
        {
          // Sakin anahtarlarindan ayri ad alani (`POST /plans` anahtari `PLN_<anahtar>`).
          idempotencyId: `PLNRQA_${requestId}`,
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
                details: { requestId, mode, requestedInstallments: r.installments, requesterId: r.userId, ...(f.drift.changed ? { drift: f.drift } : {}) },
              },
            };
          },
        },
      )
      .catch((err: unknown) => {
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
