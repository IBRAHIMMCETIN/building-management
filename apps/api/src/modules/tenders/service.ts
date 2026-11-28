/**
 * Ihale / teklif toplama servisi: buyuk tadilat / bakim islerinde alinan tekliflerin sakinlerle
 * seffafca paylasilmasi.
 *
 *  - Kiraci izolasyonu: apartman ve aktor JWT claim'lerinden; istek govdesindeki kimlik kullanilmaz.
 *  - Yazma: `apartment_manager`, `management_company`. Denetci (`observer`) ve sakin yalnizca
 *    yayinlanmis (sakinlerle paylasilmis) ihaleleri gorur; taslak / teklif toplama asamasi yonetimde kalir.
 *  - Durumlar: draft -> collecting -> published -> decided; draft / collecting / published -> cancelled.
 *    Silme yok. Tum yonetim islemleri denetim gunlugune (`tender.*`) ayni atomik yazimda.
 *  - Teklif belgesi: gider faturasi yukleme akisi (gecici `tmp/` -> kalici `apartments/{apt}/tenders/...`),
 *    indirme yalnizca kisa omurlu imzali URL ile.
 *  - Karsilastirma KDV dahil toplam uzerinden (model.ts); karar aninda secilen teklifin ozeti saklanir.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type DomainEvent, buildEvent } from '../../events/publisher.js';
import { type AssemblyRepository, assemblyRepository } from '../assemblies/repository.js';
import type { AssemblyDecision } from '../assemblies/types.js';
import type { IsoDate } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, reqEnum, reqInt, reqString } from '../core/validation.js';
import type { SignedDownload } from '../documents/service.js';
import type { FinanceService, WorkLinkWrite } from '../finance/service.js';
import { formatTL } from '../notifications/templates.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import { istanbulDate } from '../reservations/time.js';
import { type TicketRepository, ticketRepository } from '../tickets/repository.js';
import { TenderError } from './errors.js';
import { compareQuotes, isShared, nextStatus, normalizeQuote, publishReadiness, type TenderAction } from './model.js';
import { TenderConflictError, type TenderRepository, type TenderWrite, tenderRepository } from './repository.js';
import {
  CANCELLABLE_STATUSES,
  DEFAULT_MIN_QUOTES,
  EDITABLE_STATUSES,
  MAX_COMMENT_LENGTH,
  MAX_COMMENTS_PER_USER,
  MAX_DOCUMENT_HISTORY,
  MAX_MANAGEMENT_COMMENTS,
  MAX_DELIVERY_DAYS,
  MAX_MIN_QUOTES,
  MAX_QUOTE_KURUS,
  MAX_QUOTES,
  MAX_TENDER_EXPENSES,
  MAX_VAT_RATE,
  MAX_WARRANTY_MONTHS,
  TENDER_CATEGORIES,
  TENDER_EXPENSE_ACCOUNT,
  TENDER_STATUSES,
  type QuoteDocument,
  type Tender,
  type TenderAssemblyDecisionLink,
  type TenderComment,
  type TenderExpenseLink,
  type TenderQuote,
  type TenderStatus,
  type TenderTicketLink,
  tenderKeys,
} from './types.js';

export type TenderContext = { apartmentId: string; userId: string; role: string };

/** Belge deposu baglantisi (documents servisi): gecici yuklemeyi tasima ve imzali indirme linki. */
export type TenderDocuments = {
  promote(apartmentId: string, upload: { uploadId: string; fileName: string }, target: { tenderId: string; quoteId: string }): Promise<QuoteDocument>;
  sign(apartmentId: string, doc: QuoteDocument): Promise<SignedDownload>;
};

export type TenderServiceDeps = {
  repo: TenderRepository;
  /** Verilmezse (belge deposu yok) teklif belgesi eklenemez / acilamaz (503). */
  documents: TenderDocuments | undefined;
  tickets: Pick<TicketRepository, 'get'>;
  memberships: Pick<PortalRepository, 'listMemberships'>;
  /**
   * Karardan gider kaydi: MEVCUT Finans gider servisi (`recordExpense`; ayni dogrulama, bakiye ve
   * defter kurallari). Verilmezse "Gider kaydı oluştur" 503.
   */
  finance: Pick<FinanceService, 'recordExpense' | 'isReversed' | 'listAccounts'> | undefined;
  /** Genel kurul karar bagi: ayni apartmanin toplanti ve degismez karar kayitlari (salt okuma). */
  assemblies: Pick<AssemblyRepository, 'get' | 'list' | 'listDecisions'>;
  now: () => Date;
  newId: () => string;
};

type Audience = 'manager' | 'observer' | 'resident';

const MANAGER_ROLES = new Set(['apartment_manager', 'management_company']);
const WRITE_RETRIES = 3;
/** Bir yonetim yanitinin kaydettigi en fazla yanitlanan soru (kayit boyutu sinirli). */
const MAX_ANSWERS = 500;
const STATUS_ORDER: Record<TenderStatus, number> = { published: 0, collecting: 1, draft: 2, decided: 3, cancelled: 4 };

const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

type TenderFields = Pick<Tender, 'title' | 'description' | 'category' | 'minQuotes' | 'deadline'>;
const TENDER_FIELDS = ['title', 'description', 'category', 'minQuotes', 'deadline'] as const satisfies readonly (keyof TenderFields)[];

type QuoteFields = Pick<TenderQuote, 'supplierName' | 'amountKurus' | 'vatIncluded' | 'vatRate' | 'validUntil' | 'deliveryDays' | 'warrantyMonths' | 'notes'>;
const QUOTE_FIELDS = ['supplierName', 'amountKurus', 'vatIncluded', 'vatRate', 'validUntil', 'deliveryDays', 'warrantyMonths', 'notes'] as const satisfies readonly (keyof QuoteFields)[];

export function createTenderService(overrides: Partial<TenderServiceDeps> = {}) {
  const deps: TenderServiceDeps = {
    repo: tenderRepository,
    documents: undefined,
    tickets: ticketRepository,
    memberships: portalRepository,
    finance: undefined,
    assemblies: assemblyRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repo;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => istanbulDate(deps.now());
  const shortId = (n = 12) => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, n);

  // -------------------------------------------------------------------------
  // Aktor
  // -------------------------------------------------------------------------

  function audienceOf(ctx: TenderContext): Audience {
    if (MANAGER_ROLES.has(ctx.role)) return 'manager';
    if (ctx.role === 'observer') return 'observer';
    if (ctx.role === 'resident') return 'resident';
    throw new TenderError('forbidden', 'Bu rol ihale modülünü kullanamaz');
  }

  function managerOf(ctx: TenderContext) {
    if (audienceOf(ctx) !== 'manager') throw new TenderError('forbidden', 'Bu işlem yalnızca yönetim tarafından yapılabilir');
  }

  function staffOf(ctx: TenderContext): Exclude<Audience, 'resident'> {
    const a = audienceOf(ctx);
    if (a === 'resident') throw new TenderError('forbidden', 'Bu ekran yönetim ekranıdır');
    return a;
  }

  /**
   * Sakin: bu apartmanda bugun gecerli bir uyeligi olmali (tasinan sakin, token suresi dolmadan da
   * goremez). `owner`: bugun malik uyeligi var mi (genel kurul karar baglantisi yalnizca maliklere).
   */
  async function residentOf(ctx: TenderContext): Promise<{ owner: boolean }> {
    if (audienceOf(ctx) !== 'resident') throw new TenderError('forbidden', 'Bu ekran sakin portalıdır');
    const d = today();
    const current = (await deps.memberships.listMemberships(ctx.apartmentId, ctx.userId)).filter(
      (m) => m.apartmentId === ctx.apartmentId && m.status === 'active' && m.startDate <= d && (!m.endDate || m.endDate >= d),
    );
    if (!current.length) throw new TenderError('forbidden', 'İhaleleri görmek için bu sitede güncel bir daire üyeliğiniz olmalı');
    return { owner: current.some((m) => m.relation === 'owner') };
  }

  function requireDocuments(): TenderDocuments {
    if (!deps.documents) throw new TenderError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return deps.documents;
  }

  // -------------------------------------------------------------------------
  // Dogrulama
  // -------------------------------------------------------------------------

  function reqDate(o: Obj, key: string): IsoDate {
    const v = o[key];
    if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${key} YYYY-AA-GG biçiminde bir tarih olmalı`, key);
    return v;
  }

  function optDate(o: Obj, key: string): IsoDate | undefined {
    return o[key] === undefined || o[key] === null || o[key] === '' ? undefined : reqDate(o, key);
  }

  function optText(o: Obj, key: string, max: number): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new ValidationError(`${key} metin olmalı`, key);
    const text = v.trim();
    if (text.length > max) throw new ValidationError(`${key} en fazla ${max} karakter olabilir`, key);
    return text || undefined;
  }

  function optIntOrNull(o: Obj, key: string, min: number, max: number): number | undefined {
    return o[key] === undefined || o[key] === null ? undefined : reqInt(o, key, min, max);
  }

  function reqReason(o: Obj, key: string, min: number, max: number): string {
    const v = o[key];
    if (typeof v !== 'string' || v.trim().length < min) throw new ValidationError(`Gerekçe en az ${min} karakter olmalı`, key);
    const text = v.trim();
    if (text.length > max) throw new ValidationError(`Gerekçe en fazla ${max} karakter olabilir`, key);
    return text;
  }

  const parseVersion = (o: Obj) => reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);

  /** Ihale alanlari; verilmeyenler `current`ten (guncelleme) veya varsayilandan. */
  function readTender(o: Obj, current?: TenderFields): TenderFields {
    const has = (k: string) => o[k] !== undefined;
    const title = has('title') || !current ? reqString(o, 'title', 120, 3) : current.title;
    const description = has('description') || !current ? reqString(o, 'description', 4000, 10) : current.description;
    const category = has('category') || !current ? reqEnum(o, 'category', TENDER_CATEGORIES) : current.category;
    const minQuotes = has('minQuotes') ? reqInt(o, 'minQuotes', 1, MAX_MIN_QUOTES) : (current?.minQuotes ?? DEFAULT_MIN_QUOTES);
    const deadline = has('deadline') || !current ? reqDate(o, 'deadline') : current.deadline;
    if ((!current || deadline !== current.deadline) && deadline < today()) throw new ValidationError('Son teklif tarihi bugünden önce olamaz', 'deadline');
    return { title, description, category, minQuotes, deadline };
  }

  /** Ilgili talep: ayni apartmanda var olmali; numara ve baslik gosterim icin saklanir. `null` bagi kaldirir. */
  async function readTicket(ctx: TenderContext, o: Obj, current?: TenderTicketLink): Promise<TenderTicketLink | undefined> {
    if (o.ticketId === undefined) return current;
    if (o.ticketId === null || o.ticketId === '') return undefined;
    const ticketId = assertId(o.ticketId, 'ticketId');
    if (current?.ticketId === ticketId) return current;
    const ticket = await deps.tickets.get(ctx.apartmentId, ticketId);
    if (!ticket || ticket.apartmentId !== ctx.apartmentId) throw new TenderError('not_found', 'İlgili talep bulunamadı');
    return { ticketId, number: ticket.number, title: ticket.title };
  }

  function readQuote(o: Obj, current?: QuoteFields): QuoteFields {
    const has = (k: string) => o[k] !== undefined;
    const supplierName = has('supplierName') || !current ? reqString(o, 'supplierName', 120, 2) : current.supplierName;
    const amountKurus = has('amountKurus') || !current ? reqInt(o, 'amountKurus', 1, MAX_QUOTE_KURUS) : current.amountKurus;
    let vatIncluded = current?.vatIncluded;
    if (has('vatIncluded') || !current) {
      if (typeof o.vatIncluded !== 'boolean') throw new ValidationError('vatIncluded true/false olmalı (KDV dahil mi?)', 'vatIncluded');
      vatIncluded = o.vatIncluded;
    }
    const vatRate = has('vatRate') || !current ? reqInt(o, 'vatRate', 0, MAX_VAT_RATE) : current.vatRate;
    const validUntil = has('validUntil') ? optDate(o, 'validUntil') : current?.validUntil;
    const deliveryDays = has('deliveryDays') ? optIntOrNull(o, 'deliveryDays', 1, MAX_DELIVERY_DAYS) : current?.deliveryDays;
    const warrantyMonths = has('warrantyMonths') ? optIntOrNull(o, 'warrantyMonths', 0, MAX_WARRANTY_MONTHS) : current?.warrantyMonths;
    const notes = has('notes') ? optText(o, 'notes', 1000) : current?.notes;
    return {
      supplierName,
      amountKurus,
      vatIncluded: vatIncluded as boolean,
      vatRate,
      ...(validUntil ? { validUntil } : {}),
      ...(deliveryDays !== undefined ? { deliveryDays } : {}),
      ...(warrantyMonths !== undefined ? { warrantyMonths } : {}),
      ...(notes ? { notes } : {}),
    };
  }

  function readUpload(o: Obj): { uploadId: string; fileName: string } | undefined {
    if (o.document === undefined || o.document === null) return undefined;
    const d = asObject(o.document, 'document');
    return { uploadId: assertId(d.uploadId, 'document.uploadId'), fileName: reqString(d, 'fileName', 255) };
  }

  // -------------------------------------------------------------------------
  // Gorunumler
  // -------------------------------------------------------------------------

  function quoteView(q: TenderQuote, audience: Audience) {
    const { document, documentHistory, createdBy, updatedBy, withdrawnBy, ...rest } = q;
    return {
      ...rest,
      ...normalizeQuote(q),
      ...(document ? { document: { fileName: document.fileName, contentType: document.contentType, size: document.size } } : {}),
      // Degistirilen belgeler yalnizca yonetime (S3 anahtari donmez; sira numarasiyla acilir).
      ...(audience === 'manager' && documentHistory?.length
        ? { documentHistory: documentHistory.map((d) => ({ fileName: d.fileName, contentType: d.contentType, size: d.size, replacedAt: d.replacedAt, replacedBy: d.replacedBy })) }
        : {}),
      ...(audience === 'resident' ? {} : { createdBy, updatedBy, ...(withdrawnBy ? { withdrawnBy } : {}) }),
    };
  }

  function decisionView(t: Tender, audience: Audience) {
    if (!t.decision) return {};
    const { decidedBy, ...rest } = t.decision;
    return { decision: audience === 'resident' ? rest : t.decision };
  }

  function summaryView(t: Tender, audience: Audience) {
    const comparison = compareQuotes(t.quotes);
    return {
      tenderId: t.tenderId,
      title: t.title,
      category: t.category,
      status: t.status,
      deadline: t.deadline,
      deadlinePassed: t.deadline < today(),
      minQuotes: t.minQuotes,
      quoteCount: comparison.rows.length,
      ...(comparison.lowestTotalKurus !== undefined ? { lowestTotalKurus: comparison.lowestTotalKurus } : {}),
      // KVKK: arıza talepleri daireye ozeldir; sakin gorunumune talep bagi (kimlik / baslik) konmaz.
      ...(t.ticket && audience !== 'resident' ? { ticket: t.ticket } : {}),
      ...(t.publishedAt ? { publishedAt: t.publishedAt } : {}),
      ...decisionView(t, audience),
      ...(t.cancelledAt ? { cancelledAt: t.cancelledAt } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      version: t.version,
    };
  }

  function commentView(c: TenderComment, ctx: TenderContext, audience: Audience, hiddenIds: ReadonlySet<string>) {
    // Sakin gorunumunde gizlenen soruya yanit, sorusuz (bag kaldirilir) gosterilir.
    const replyTo = c.replyTo && !(audience === 'resident' && hiddenIds.has(c.replyTo)) ? c.replyTo : undefined;
    return {
      commentId: c.commentId,
      body: c.body,
      authorKind: c.authorKind,
      mine: c.authorId === ctx.userId,
      createdAt: c.createdAt,
      ...(replyTo ? { replyTo } : {}),
      // Moderasyon: gizlenen soru sakinlere hic donmez; yonetim ve denetci gerekceyle gorur.
      ...(c.hiddenAt && audience !== 'resident' ? { hidden: { at: c.hiddenAt, reason: c.hideReason ?? '', ...(audience === 'manager' && c.hiddenBy ? { by: c.hiddenBy } : {}) } } : {}),
      // KVKK: sakin ve denetci yazar kimligini gormez (denetciye sakin kisisel verisi maskelenir); yalnizca yonetim.
      ...(audience === 'manager' ? { authorId: c.authorId, authorRole: c.authorRole } : {}),
    };
  }

  /** Tum bagli giderler (eski tek gider modeli dahil), eskiden yeniye. */
  const expenseLinks = (t: Tender): TenderExpenseLink[] =>
    t.expenses ?? [...(t.previousExpenses ?? []).map(({ replacedAt: _r, ...e }) => e), ...(t.expense ? [t.expense] : [])];

  /** Finans'ta ters kayitla iptal edilmis bagli giderlerin islem kimlikleri (Finans yoksa bilinmez: hicbiri). */
  async function reversedLinks(ctx: TenderContext, links: readonly TenderExpenseLink[]): Promise<Set<string>> {
    const finance = deps.finance;
    if (!finance || !links.length) return new Set();
    const flags = await Promise.all(links.map((e) => finance.isReversed(ctx, e.transactionId)));
    return new Set(links.filter((_, i) => flags[i]).map((e) => e.transactionId));
  }

  type Progress = ReturnType<typeof progressOf>;

  /** Hakedis ilerlemesi: gecerli (ters kaydedilmemis) giderler karar tutarina (KDV dahil) gore. */
  function progressOf(t: Tender, links: readonly TenderExpenseLink[], reversed: ReadonlySet<string>) {
    const decided = t.decision?.totalKurus ?? 0;
    const active = links.filter((e) => !reversed.has(e.transactionId));
    const activeTotal = active.reduce((s, e) => s + e.amountKurus, 0);
    return {
      decidedTotalKurus: decided,
      activeTotalKurus: activeTotal,
      remainingKurus: Math.max(0, decided - activeTotal),
      overrunKurus: Math.max(0, activeTotal - decided),
      percentBps: decided > 0 ? Math.floor((activeTotal * 10_000) / decided) : 0,
      activeCount: active.length,
      reversedCount: links.length - active.length,
    };
  }

  /**
   * Gider penceresinin on dolumu: kalan tutar (karar tutari - gecerli giderler), firma, ihale referansi,
   * kategoriye gore gider kalemi ve eslestirilmis tedarikci hesabi (vadeli gider).
   */
  function expenseDraftOf(t: Tender, decision: NonNullable<Tender['decision']>, progress: Progress, installment: number) {
    const ref = decision.reference ? ` · Karar ${decision.reference}` : '';
    const part = installment > 1 ? ` · Hakediş ${installment}` : '';
    return {
      amountKurus: progress.remainingKurus,
      supplier: decision.supplierName.slice(0, 120),
      description: `İhale ${t.tenderId}: ${t.title}${ref}${part}`.slice(0, 200),
      expenseAccountId: TENDER_EXPENSE_ACCOUNT[t.category] ?? 'exp-repair',
      ...(t.supplierAccount ? { creditAccountId: t.supplierAccount.accountId } : {}),
      date: today(),
      installment,
    };
  }

  function expenseView(t: Tender, audience: Audience, links: readonly TenderExpenseLink[], reversed: ReadonlySet<string>) {
    if (audience === 'resident') return {};
    const progress = progressOf(t, links, reversed);
    const all = links.map((e, i) => ({
      expenseId: e.expenseId,
      transactionId: e.transactionId,
      amountKurus: e.amountKurus,
      date: e.date,
      linkedAt: e.linkedAt,
      linkedBy: e.linkedBy,
      reversed: reversed.has(e.transactionId),
      installment: e.installment ?? i + 1,
      ...(e.overrunReason ? { overrunReason: e.overrunReason } : {}),
    }));
    // `expense`: en son gecerli gider (eski istemciler icin; yoksa en sonuncu).
    const latest = [...all].reverse().find((e) => !e.reversed) ?? all.at(-1);
    return {
      ...(all.length ? { expenses: all, expense: latest } : {}),
      ...(t.status === 'decided' && t.decision ? { expenseProgress: progress } : {}),
      ...(t.supplierAccount ? { supplierAccount: t.supplierAccount } : {}),
      ...(audience === 'manager' && t.status === 'decided' && t.decision && links.length < MAX_TENDER_EXPENSES ? { expenseDraft: expenseDraftOf(t, t.decision, progress, links.length + 1) } : {}),
    };
  }

  /** Bolum basina degil madde basina en son (gecerli) karar kaydi. */
  const latestDecisions = (ds: readonly AssemblyDecision[]) => {
    const out = new Map<string, AssemblyDecision>();
    for (const d of ds) {
      const k = `${d.assemblyId}|${d.itemId}`;
      if ((out.get(k)?.seq ?? 0) < d.seq) out.set(k, d);
    }
    return [...out.values()];
  };

  /**
   * Genel kurul karari bagi. Sakin: karar ozeti (toplanti tarihi, madde, sonuc) ve `portalLink`
   * (yalnizca malik ve tutanagi kesinlesmis toplanti: genel kurul portali kiraciya kapali). Karar sonra
   * duzeltildiyse `corrected` + guncel sonuc.
   */
  async function assemblyLinkView(ctx: TenderContext, t: Tender, audience: Audience, resident?: { owner: boolean }) {
    const l = t.assemblyDecision;
    if (!l) return {};
    const [a, decisions] = await Promise.all([deps.assemblies.get(ctx.apartmentId, l.assemblyId), deps.assemblies.listDecisions(ctx.apartmentId, l.assemblyId)]);
    const own = a && a.apartmentId === ctx.apartmentId ? a : undefined;
    const latest = latestDecisions(decisions.filter((d) => d.apartmentId === ctx.apartmentId && d.itemId === l.itemId))[0];
    const corrected = Boolean(latest && latest.seq !== l.seq);
    const base = {
      assemblyId: l.assemblyId,
      itemId: l.itemId,
      itemTitle: l.itemTitle,
      meetingAt: l.meetingAt,
      decision: l.decision,
      ...(corrected && latest ? { corrected: true, currentDecision: latest.outcome.decision } : {}),
    };
    if (audience === 'resident') return { assemblyDecision: { ...base, portalLink: Boolean(resident?.owner && own?.status === 'held') } };
    return { assemblyDecision: { ...base, seq: l.seq, assemblyStatus: own?.status ?? 'missing', linkedAt: l.linkedAt, ...(audience === 'manager' ? { linkedBy: l.linkedBy } : {}) } };
  }

  async function detailView(ctx: TenderContext, t: Tender, audience: Audience, resident?: { owner: boolean }) {
    const links = expenseLinks(t);
    const [comments, reversed, assemblyLink] = await Promise.all([
      isShared(t) ? repo.listComments(ctx.apartmentId, t.tenderId) : Promise.resolve([] as TenderComment[]),
      audience === 'resident' ? Promise.resolve(new Set<string>()) : reversedLinks(ctx, links),
      assemblyLinkView(ctx, t, audience, resident),
    ]);
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const hiddenIds = new Set(comments.filter((c) => c.hiddenAt).map((c) => c.commentId));
    const visible = audience === 'resident' ? comments.filter((c) => !c.hiddenAt) : comments;
    return {
      ...summaryView(t, audience),
      ...expenseView(t, audience, links, reversed),
      ...assemblyLink,
      description: t.description,
      ...(t.shortfallReason ? { shortfallReason: t.shortfallReason } : {}),
      ...(t.cancelReason ? { cancelReason: t.cancelReason, cancelledFrom: t.cancelledFrom } : {}),
      quotes: t.quotes.map((q) => quoteView(q, audience)),
      comparison: compareQuotes(t.quotes),
      comments: visible.map((c) => commentView(c, ctx, audience, hiddenIds)),
      canComment: t.status === 'published' && audience !== 'observer',
      ...(audience === 'manager'
        ? { readiness: publishReadiness(t), createdBy: t.createdBy, updatedBy: t.updatedBy, ...(t.publishedBy ? { publishedBy: t.publishedBy } : {}), ...(t.cancelledBy ? { cancelledBy: t.cancelledBy } : {}) }
        : {}),
    };
  }

  const sortTenders = (items: Tender[]) =>
    items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt));

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  async function load(ctx: TenderContext, tenderId: string): Promise<Tender> {
    assertId(tenderId, 'tenderId');
    const t = await repo.get(ctx.apartmentId, tenderId);
    if (!t || t.apartmentId !== ctx.apartmentId) throw new TenderError('not_found', 'İhale bulunamadı');
    return t;
  }

  /** Denetci / sakin: paylasilmamis ihale yokmus gibi (404; varligi sizdirilmaz). */
  async function loadVisible(ctx: TenderContext, tenderId: string, audience: Audience): Promise<Tender> {
    const t = await load(ctx, tenderId);
    if (audience !== 'manager' && !isShared(t)) throw new TenderError('not_found', 'İhale bulunamadı');
    return t;
  }

  async function list(ctx: TenderContext, q: { status?: string } = {}) {
    const audience = staffOf(ctx);
    if (q.status !== undefined && !(TENDER_STATUSES as readonly string[]).includes(q.status)) throw new ValidationError('Geçersiz durum filtresi', 'status');
    const items = (await repo.list(ctx.apartmentId)).filter((t) => (audience === 'manager' || isShared(t)) && (!q.status || t.status === q.status));
    return { items: sortTenders(items).map((t) => summaryView(t, audience)) };
  }

  async function get(ctx: TenderContext, tenderId: string) {
    const audience = staffOf(ctx);
    return { tender: await detailView(ctx, await loadVisible(ctx, tenderId, audience), audience) };
  }

  async function portalList(ctx: TenderContext) {
    await residentOf(ctx);
    const items = (await repo.list(ctx.apartmentId)).filter(isShared);
    return { items: sortTenders(items).map((t) => summaryView(t, 'resident')) };
  }

  async function portalGet(ctx: TenderContext, tenderId: string) {
    const r = await residentOf(ctx);
    return { tender: await detailView(ctx, await loadVisible(ctx, tenderId, 'resident'), 'resident', r) };
  }

  /**
   * Teklif belgesi (5 dk imzali link). Yonetim her asamada; denetci ve sakin yalnizca yayinlanmis
   * (paylasilmis) ihalede - aksi halde 404.
   */
  async function documentFor(ctx: TenderContext, tenderId: string, quoteId: string, audience: Audience, historyIndex?: string) {
    const t = await loadVisible(ctx, tenderId, audience);
    assertId(quoteId, 'quoteId');
    const quote = t.quotes.find((q) => q.quoteId === quoteId);
    if (historyIndex !== undefined) {
      // Degistirilmis (onceki) belge: yalnizca yonetim; ayni imzali link ve on ek kontrolu.
      if (audience !== 'manager') throw new TenderError('not_found', 'Teklif belgesi bulunamadı');
      if (!/^\d{1,3}$/.test(historyIndex)) throw new ValidationError('history geçersiz', 'history');
      const old = quote?.documentHistory?.[Number(historyIndex)];
      if (!old) throw new TenderError('not_found', 'Teklif belgesi bulunamadı');
      return requireDocuments().sign(ctx.apartmentId, old);
    }
    if (!quote?.document) throw new TenderError('not_found', 'Teklif belgesi bulunamadı');
    return requireDocuments().sign(ctx.apartmentId, quote.document);
  }

  const quoteDocument = (ctx: TenderContext, tenderId: string, quoteId: string, q: { history?: string } = {}) => documentFor(ctx, tenderId, quoteId, staffOf(ctx), q.history);
  async function portalQuoteDocument(ctx: TenderContext, tenderId: string, quoteId: string) {
    await residentOf(ctx);
    return documentFor(ctx, tenderId, quoteId, 'resident');
  }

  // -------------------------------------------------------------------------
  // Yazim yardimcilari
  // -------------------------------------------------------------------------

  async function write(ctx: TenderContext, w: TenderWrite) {
    try {
      await repo.write(ctx.apartmentId, w);
    } catch (err) {
      if (err instanceof TenderConflictError) {
        if (err.reason === 'status') throw new TenderError('invalid_state', 'İhale artık yorumlara açık değil');
        throw new TenderError('conflict', 'İhale başka bir işlemle değişti; sayfayı yenileyin');
      }
      throw err;
    }
  }

  function assertVersion(t: Tender, version: number) {
    if (t.version !== version) throw new TenderError('conflict', 'İhale başka bir işlemle değişti; sayfayı yenileyin');
  }

  function assertEditable(t: Tender) {
    if (!EDITABLE_STATUSES.includes(t.status)) throw new TenderError('invalid_state', 'Yayınlanan, karara bağlanan veya iptal edilen ihalenin teklifleri değiştirilemez');
  }

  const touch = (ctx: TenderContext, t: Tender, ts: string) => ({ updatedAt: ts, updatedBy: ctx.userId, version: t.version + 1 });
  const audit = (ctx: TenderContext, action: string, tenderId: string, details: Record<string, unknown>, reason?: string) => ({
    apartmentId: ctx.apartmentId,
    action,
    target: { type: 'tender', id: tenderId },
    ...(reason ? { reason } : {}),
    details,
  });

  /** Idempotent olusturma: ayni anahtar + ayni icerik ayni kaydi doner, farkli icerik 409. */
  async function replayOf(ctx: TenderContext, key: string, kind: 'tender' | 'quote' | 'comment', fp: string) {
    const idem = await repo.getIdempotency(ctx.apartmentId, key);
    if (!idem) return undefined;
    if (idem.kind !== kind || idem.fingerprint !== fp) throw new TenderError('conflict', 'Bu idempotencyKey farklı bir istek için kullanılmış');
    return idem;
  }

  const idempotency = (ctx: TenderContext, key: string, kind: 'tender' | 'quote' | 'comment', tenderId: string, targetId: string, fp: string, ts: string) => ({
    ...tenderKeys.idempotency(ctx.apartmentId, key),
    entityType: 'TENDER_IDEMPOTENCY' as const,
    apartmentId: ctx.apartmentId,
    kind,
    tenderId,
    targetId,
    fingerprint: fp,
    createdAt: ts,
  });

  // -------------------------------------------------------------------------
  // Ihale (yonetim)
  // -------------------------------------------------------------------------

  /** Yeni ihale (taslak). `idempotencyKey` ayni istegin tekrarini ikinci ihaleye cevirmez. */
  async function create(ctx: TenderContext, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const fields = readTender(o);
    const ticketId = o.ticketId === undefined || o.ticketId === null || o.ticketId === '' ? undefined : assertId(o.ticketId, 'ticketId');
    const fp = fingerprint({ kind: 'tender', ...fields, ticketId });
    const replay = async () => {
      const idem = await replayOf(ctx, key, 'tender', fp);
      if (!idem) return undefined;
      const t = await repo.get(ctx.apartmentId, idem.tenderId);
      if (!t) throw new TenderError('conflict', 'İhale oluşturma sürüyor; tekrar deneyin');
      return { tender: await detailView(ctx, t, 'manager'), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    const ticket = await readTicket(ctx, o);
    const ts = stamp();
    const tenderId = `tnd-${shortId()}`;
    const tender: Tender = {
      ...tenderKeys.tender(ctx.apartmentId, tenderId),
      entityType: 'TENDER',
      apartmentId: ctx.apartmentId,
      tenderId,
      ...fields,
      ...(ticket ? { ticket } : {}),
      status: 'draft',
      quotes: [],
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.write(ctx.apartmentId, {
        tender: { item: tender, expectedVersion: 0 },
        idempotency: idempotency(ctx, key, 'tender', tenderId, tenderId, fp, ts),
        audit: audit(ctx, 'tender.create', tenderId, { title: fields.title, category: fields.category, minQuotes: fields.minQuotes, deadline: fields.deadline, ...(ticket ? { ticketId: ticket.ticketId } : {}) }),
      });
    } catch (err) {
      if (err instanceof TenderConflictError && err.reason === 'duplicate') {
        const r = await replay();
        if (r) return r;
      }
      if (err instanceof TenderConflictError) throw new TenderError('conflict', err.message);
      throw err;
    }
    return { tender: await detailView(ctx, tender, 'manager'), replayed: false };
  }

  /** Taslak / teklif toplama asamasinda bilgi duzeltme (surumlu). */
  async function update(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const t = await load(ctx, tenderId);
    if (!EDITABLE_STATUSES.includes(t.status)) throw new TenderError('invalid_state', 'Yalnızca taslak veya teklif toplanan ihale düzenlenebilir');
    assertVersion(t, version);
    const fields = readTender(o, t);
    // Asgari teklif sayisi taslaktan cikinca kilitli: toplama sirasinda dusurulup eksik teklif gerekcesi atlanamaz.
    if (t.status !== 'draft' && fields.minQuotes !== t.minQuotes) {
      throw new TenderError('invalid_state', 'Asgari teklif sayısı teklif toplamaya başlandıktan sonra değiştirilemez', { field: 'minQuotes' });
    }
    const ticket = await readTicket(ctx, o, t.ticket);
    const changed: string[] = TENDER_FIELDS.filter((k) => fields[k] !== t[k]);
    if ((ticket?.ticketId ?? null) !== (t.ticket?.ticketId ?? null)) changed.push('ticketId');
    if (!changed.length) return { tender: await detailView(ctx, t, 'manager') };
    const ts = stamp();
    const { ticket: _old, ...base } = t;
    const next: Tender = { ...base, ...fields, ...(ticket ? { ticket } : {}), ...touch(ctx, t, ts) };
    await write(ctx, { tender: { item: next, expectedVersion: version }, audit: audit(ctx, 'tender.update', tenderId, { fields: changed }) });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  /**
   * Sakinlere bildirim olayi (outbox; yalnizca kimlik). Olay kimligi gecis basina deterministik:
   * yayin, karar ve iptal birer kez olur. Worker ihalenin guncel halini okur (bayat olay elenir).
   */
  type TenderNotice = 'TENDER_PUBLISHED' | 'TENDER_DECIDED' | 'TENDER_CANCELLED';
  const tenderEvent = (ctx: TenderContext, type: TenderNotice, tenderId: string, ts: string): DomainEvent =>
    buildEvent({ eventId: `${type}:${tenderId}`, type, apartmentId: ctx.apartmentId, actorId: ctx.userId, occurredAt: ts, payload: { tenderId } }, deps.now);

  async function transition(
    ctx: TenderContext,
    tenderId: string,
    action: TenderAction,
    body: unknown,
    build: (t: Tender, o: Obj, ts: string) => { next: Partial<Tender>; details: Record<string, unknown>; reason?: string; notify?: TenderNotice },
  ) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const t = await load(ctx, tenderId);
    const to = nextStatus(t.status, action);
    if (!to) throw new TenderError('invalid_state', INVALID_TRANSITION[action]);
    assertVersion(t, version);
    const ts = stamp();
    const { next, details, reason, notify } = build(t, o, ts);
    const item: Tender = { ...t, ...next, status: to, ...touch(ctx, t, ts) };
    await write(ctx, {
      tender: { item, expectedVersion: version },
      audit: audit(ctx, `tender.${action}`, tenderId, { from: t.status, to, ...details }, reason),
      ...(notify ? { outbox: [tenderEvent(ctx, notify, tenderId, ts)] } : {}),
    });
    return { tender: await detailView(ctx, item, 'manager') };
  }

  const INVALID_TRANSITION: Record<TenderAction, string> = {
    collect: 'Yalnızca taslak ihale teklif toplamaya açılabilir',
    publish: 'Yalnızca teklif toplanan ihale sakinlerle paylaşılabilir',
    decide: 'Yalnızca yayınlanmış ihale karara bağlanabilir',
    cancel: 'Karara bağlanmış veya iptal edilmiş ihale iptal edilemez',
  };

  /** Taslak -> teklif toplama. */
  const collect = (ctx: TenderContext, tenderId: string, body: unknown) => transition(ctx, tenderId, 'collect', body, (_t, _o, ts) => ({ next: { collectingAt: ts }, details: {} }));

  /**
   * Teklif toplama -> yayinda (sakinlerle paylasilir). En az bir aktif teklif ve her aktif teklifin
   * belgesi gerekir. Asgari teklif sayisina ulasilmadiysa gerekce zorunludur (sakinler de gorur).
   */
  const publish = (ctx: TenderContext, tenderId: string, body: unknown) =>
    transition(ctx, tenderId, 'publish', body, (t, o, ts) => {
      const r = publishReadiness(t);
      if (!r.activeQuotes) throw new TenderError('unprocessable', 'Yayınlamak için en az bir teklif ekleyin');
      if (r.missingDocuments.length) {
        throw new TenderError('unprocessable', 'Her teklifin belgesi (PDF veya fotoğraf) yüklenmiş olmalı', { missingDocuments: r.missingDocuments });
      }
      let shortfallReason: string | undefined;
      if (r.shortfall) {
        if (o.shortfallReason === undefined || o.shortfallReason === null || o.shortfallReason === '') {
          throw new TenderError('unprocessable', `En az ${t.minQuotes} teklif bekleniyordu (${r.activeQuotes} teklif var); eksik teklifle yayınlamak için gerekçe yazın`, { shortfall: true });
        }
        shortfallReason = reqReason(o, 'shortfallReason', 10, 500);
      }
      return {
        next: { publishedAt: ts, publishedBy: ctx.userId, ...(shortfallReason ? { shortfallReason } : {}) },
        details: { quoteCount: r.activeQuotes, minQuotes: t.minQuotes, ...(shortfallReason ? { shortfall: true } : {}) },
        ...(shortfallReason ? { reason: shortfallReason } : {}),
        notify: 'TENDER_PUBLISHED',
      };
    });

  /**
   * Yayinda -> karar: secilen aktif teklif + gerekce (en dusuk teklif secilmediyse de gerekce ayni
   * alandir). Genel kurul karari gercek bagla (`assemblyDecision: { assemblyId, itemId }`, ayni apartmanin
   * kabul edilmis karari) veya serbest referansla (anket vb.) baglanabilir. Teklif ozeti saklanir.
   */
  async function decide(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const raw = asObject(body);
    const link = raw.assemblyDecision === undefined || raw.assemblyDecision === null ? undefined : await resolveAssemblyDecision(ctx, raw.assemblyDecision);
    return transition(ctx, tenderId, 'decide', raw, (t, o, ts) => {
      const quoteId = assertId(o.quoteId, 'quoteId');
      const quote = t.quotes.find((q) => q.quoteId === quoteId && q.status === 'active');
      if (!quote) throw new TenderError('not_found', 'Seçilen teklif bulunamadı');
      const reason = reqReason(o, 'reason', 10, 1000);
      const reference = optText(o, 'reference', 200);
      const amounts = normalizeQuote(quote);
      const lowest = compareQuotes(t.quotes).lowestQuoteIds.includes(quoteId);
      return {
        next: {
          decision: { quoteId, reason, ...(reference ? { reference } : {}), supplierName: quote.supplierName, ...amounts, decidedAt: ts, decidedBy: ctx.userId },
          ...(link ? { assemblyDecision: { ...link, linkedAt: ts } } : {}),
        },
        details: { quoteId, supplierName: quote.supplierName, totalKurus: amounts.totalKurus, lowest, ...(reference ? { reference } : {}), ...(link ? { assemblyId: link.assemblyId, assemblyItemId: link.itemId, assemblySeq: link.seq } : {}) },
        reason,
        notify: 'TENDER_DECIDED',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Genel kurul karari bagi
  // -------------------------------------------------------------------------

  /** Ayni apartmanin guncel (madde basina en son sirali) genel kurul kararlari: ihale karar seciciye. */
  async function assemblyDecisionOptions(ctx: TenderContext) {
    staffOf(ctx);
    const [assemblies, decisions] = await Promise.all([deps.assemblies.list(ctx.apartmentId), deps.assemblies.listDecisions(ctx.apartmentId)]);
    const statusOf = new Map(assemblies.filter((a) => a.apartmentId === ctx.apartmentId).map((a) => [a.assemblyId, a.status]));
    const order = (itemId: string) => Number(itemId.replace(/\D/g, '')) || 0;
    const items = latestDecisions(decisions.filter((d) => d.apartmentId === ctx.apartmentId && statusOf.has(d.assemblyId)))
      .sort((x, y) => y.meetingAt.localeCompare(x.meetingAt) || x.assemblyId.localeCompare(y.assemblyId) || order(x.itemId) - order(y.itemId))
      .map((d) => ({ assemblyId: d.assemblyId, itemId: d.itemId, seq: d.seq, itemTitle: d.itemTitle, meetingAt: d.meetingAt, decisionKind: d.decisionKind, decision: d.outcome.decision, assemblyStatus: statusOf.get(d.assemblyId) }));
    return { items };
  }

  /** Bag hedefi: ayni apartmanin iptal edilmemis toplantisinin, madde icin en son (gecerli) ve KABUL edilmis karari. */
  async function resolveAssemblyDecision(ctx: TenderContext, raw: unknown): Promise<TenderAssemblyDecisionLink> {
    const o = asObject(raw, 'assemblyDecision');
    const assemblyId = assertId(o.assemblyId, 'assemblyDecision.assemblyId');
    const itemId = assertId(o.itemId, 'assemblyDecision.itemId');
    const [a, decisions] = await Promise.all([deps.assemblies.get(ctx.apartmentId, assemblyId), deps.assemblies.listDecisions(ctx.apartmentId, assemblyId)]);
    if (!a || a.apartmentId !== ctx.apartmentId) throw new TenderError('not_found', 'Genel kurul kaydı bulunamadı');
    if (a.status === 'cancelled') throw new TenderError('unprocessable', 'İptal edilen toplantının kararına bağlanamaz');
    const latest = latestDecisions(decisions.filter((d) => d.apartmentId === ctx.apartmentId && d.itemId === itemId))[0];
    if (!latest) throw new TenderError('not_found', 'Genel kurul kararı bulunamadı');
    if (latest.outcome.decision !== 'accepted') throw new TenderError('unprocessable', 'Kabul edilmemiş genel kurul kararına ihale bağlanamaz');
    return { assemblyId, itemId, seq: latest.seq, itemTitle: latest.itemTitle, meetingAt: latest.meetingAt, decision: 'accepted', linkedAt: stamp(), linkedBy: ctx.userId };
  }

  /** Karar bagini sonradan kurar / degistirir / kaldirir (`assemblyDecision: null`); iptal edilmemis ihalede. */
  async function linkAssemblyDecision(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    if (o.assemblyDecision === undefined) throw new ValidationError('assemblyDecision gerekli ({ assemblyId, itemId } veya null)', 'assemblyDecision');
    const t = await load(ctx, tenderId);
    if (t.status === 'cancelled') throw new TenderError('invalid_state', 'İptal edilen ihale değiştirilemez');
    assertVersion(t, version);
    const link = o.assemblyDecision === null ? undefined : await resolveAssemblyDecision(ctx, o.assemblyDecision);
    const prev = t.assemblyDecision;
    if (`${link?.assemblyId}|${link?.itemId}|${link?.seq}` === `${prev?.assemblyId}|${prev?.itemId}|${prev?.seq}`) return { tender: await detailView(ctx, t, 'manager') };
    const ts = stamp();
    const { assemblyDecision: _old, ...rest } = t;
    const next: Tender = { ...rest, ...(link ? { assemblyDecision: { ...link, linkedAt: ts } } : {}), ...touch(ctx, t, ts) };
    await write(ctx, {
      tender: { item: next, expectedVersion: version },
      audit: audit(ctx, 'tender.assembly_link', tenderId, {
        ...(link ? { assemblyId: link.assemblyId, itemId: link.itemId, seq: link.seq } : { removed: true }),
        ...(prev ? { previousAssemblyId: prev.assemblyId, previousItemId: prev.itemId } : {}),
      }),
    });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  // -------------------------------------------------------------------------
  // Tedarikci (vadeli borc) hesabi eslestirme
  // -------------------------------------------------------------------------

  const normName = (s: string) =>
    s
      .toLocaleLowerCase('tr')
      .replace(/[^0-9a-zçğıöşü]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3 && !['ltd', 'şti', 'sti', 'san', 'tic', 'inş', 'ins', 've', 'limited', 'şirketi', 'anonim'].includes(w));

  /** Firma adinin anlamli ilk sozcugu hesap adinda geciyorsa oneri. */
  const suggests = (supplier: string, account: string) => {
    const first = normName(supplier)[0];
    return Boolean(first && normName(account).includes(first));
  };

  /** Eslestirme icin aktif tedarikci hesaplari; firma adina benzeyenler once (`suggested`). */
  async function supplierAccounts(ctx: TenderContext, tenderId: string) {
    managerOf(ctx);
    const t = await load(ctx, tenderId);
    if (!deps.finance) throw new TenderError('unavailable', 'Finans modülü bu ortamda yapılandırılmamış');
    const supplier = t.decision?.supplierName;
    const items = (await deps.finance.listAccounts(ctx, 'payable'))
      .filter((a) => a.status === 'active' && a.siteId === ctx.apartmentId)
      .map((a) => ({ accountId: a.accountId, name: a.name, ...(a.code ? { code: a.code } : {}), suggested: supplier ? suggests(supplier, a.name) : false, linked: t.supplierAccount?.accountId === a.accountId }))
      .sort((x, y) => Number(y.suggested) - Number(x.suggested) || x.name.localeCompare(y.name, 'tr'));
    return { items };
  }

  /**
   * Kazanan firmayi Finans tedarikci hesabina baglar (`accountId: null` bagi kaldirir). Yalnizca karara
   * baglanmis ihalede; gider aktariminda odeme hesabi varsayilani olur (vadeli gider: tedarikci borcu).
   */
  async function linkSupplier(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    if (o.accountId === undefined) throw new ValidationError('accountId gerekli (veya null)', 'accountId');
    const t = await load(ctx, tenderId);
    if (t.status !== 'decided' || !t.decision) throw new TenderError('invalid_state', 'Tedarikçi hesabı karara bağlanmış ihalede eşleştirilir');
    assertVersion(t, version);
    const ts = stamp();
    let link: Tender['supplierAccount'];
    if (o.accountId !== null) {
      const accountId = assertId(o.accountId, 'accountId');
      if (!deps.finance) throw new TenderError('unavailable', 'Finans modülü bu ortamda yapılandırılmamış');
      const acc = (await deps.finance.listAccounts(ctx, 'payable')).find((a) => a.accountId === accountId && a.siteId === ctx.apartmentId);
      if (!acc) throw new TenderError('not_found', 'Tedarikçi hesabı bulunamadı');
      if (acc.status !== 'active') throw new TenderError('unprocessable', 'Pasif tedarikçi hesabı seçilemez');
      link = { accountId, name: acc.name, linkedAt: ts, linkedBy: ctx.userId };
    }
    if ((link?.accountId ?? null) === (t.supplierAccount?.accountId ?? null)) return { tender: await detailView(ctx, t, 'manager') };
    const { supplierAccount: _old, ...rest } = t;
    const next: Tender = { ...rest, ...(link ? { supplierAccount: link } : {}), ...touch(ctx, t, ts) };
    await write(ctx, {
      tender: { item: next, expectedVersion: version },
      audit: audit(ctx, 'tender.supplier_link', tenderId, { accountId: link?.accountId ?? null, previousAccountId: t.supplierAccount?.accountId ?? null, supplierName: t.decision.supplierName }),
    });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  /** Iptal (gerekceli): taslak, teklif toplama veya yayin asamasinda. Kayit silinmez. */
  const cancel = (ctx: TenderContext, tenderId: string, body: unknown) =>
    transition(ctx, tenderId, 'cancel', body, (t, o, ts) => {
      const reason = reqReason(o, 'reason', 10, 500);
      if (!CANCELLABLE_STATUSES.includes(t.status)) throw new TenderError('invalid_state', INVALID_TRANSITION.cancel);
      // Sakinler yalnizca paylasilmis (yayindaki) ihalenin iptalini gorur ve e-postasini alir.
      return { next: { cancelledAt: ts, cancelledBy: ctx.userId, cancelReason: reason, cancelledFrom: t.status }, details: {}, reason, ...(t.status === 'published' ? { notify: 'TENDER_CANCELLED' as const } : {}) };
    });

  // -------------------------------------------------------------------------
  // Teklifler (yonetim; taslak / teklif toplama asamasinda)
  // -------------------------------------------------------------------------

  /**
   * Teklif ekleme (idempotent). Belge verildiyse gecici yukleme ihaleye tasinir (yazimdan once;
   * yazim basarisiz olursa kopya sahipsiz kalir, zararsiz). Ayni anda eklenen teklifler surum
   * cakismasinda guncel ihaleyle yeniden denenir.
   */
  async function addQuote(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const fields = readQuote(o);
    const upload = readUpload(o);
    const fp = fingerprint({ kind: 'quote', tenderId, ...fields, uploadId: upload?.uploadId });
    const replay = async () => {
      const idem = await replayOf(ctx, key, 'quote', fp);
      if (!idem) return undefined;
      const t = await load(ctx, idem.tenderId);
      if (!t.quotes.some((q) => q.quoteId === idem.targetId)) throw new TenderError('conflict', 'Teklif ekleme sürüyor; tekrar deneyin');
      return { tender: await detailView(ctx, t, 'manager'), quoteId: idem.targetId, replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    let t = await load(ctx, tenderId);
    assertEditable(t);
    if (t.quotes.length >= MAX_QUOTES) throw new TenderError('unprocessable', `Bir ihalede en fazla ${MAX_QUOTES} teklif olabilir (geri çekilen teklifler de sayılır)`);
    const quoteId = `q-${shortId(10)}`;
    const document = upload ? await requireDocuments().promote(ctx.apartmentId, upload, { tenderId, quoteId }) : undefined;
    for (let attempt = 1; ; attempt++) {
      assertEditable(t);
      if (t.quotes.length >= MAX_QUOTES) throw new TenderError('unprocessable', `Bir ihalede en fazla ${MAX_QUOTES} teklif olabilir (geri çekilen teklifler de sayılır)`);
      const ts = stamp();
      const quote: TenderQuote = { quoteId, ...fields, ...(document ? { document } : {}), status: 'active', createdAt: ts, createdBy: ctx.userId, updatedAt: ts, updatedBy: ctx.userId };
      const next: Tender = { ...t, quotes: [...t.quotes, quote], ...touch(ctx, t, ts) };
      try {
        await repo.write(ctx.apartmentId, {
          tender: { item: next, expectedVersion: t.version },
          idempotency: idempotency(ctx, key, 'quote', tenderId, quoteId, fp, ts),
          audit: audit(ctx, 'tender.quote_add', tenderId, { quoteId, supplierName: fields.supplierName, ...normalizeQuote(fields), vatIncluded: fields.vatIncluded, vatRate: fields.vatRate, document: Boolean(document) }),
        });
        return { tender: await detailView(ctx, next, 'manager'), quoteId, replayed: false };
      } catch (err) {
        if (err instanceof TenderConflictError && err.reason === 'duplicate') {
          const r = await replay();
          if (r) return r;
        }
        if (err instanceof TenderConflictError && err.reason === 'version' && attempt < WRITE_RETRIES) {
          t = await load(ctx, tenderId);
          continue;
        }
        if (err instanceof TenderConflictError) throw new TenderError('conflict', 'İhale başka bir işlemle değişti; sayfayı yenileyin');
        throw err;
      }
    }
  }

  function findActiveQuote(t: Tender, quoteId: string): TenderQuote {
    assertId(quoteId, 'quoteId');
    const q = t.quotes.find((x) => x.quoteId === quoteId);
    if (!q) throw new TenderError('not_found', 'Teklif bulunamadı');
    if (q.status !== 'active') throw new TenderError('invalid_state', 'Geri çekilen teklif değiştirilemez');
    return q;
  }

  /** Teklif duzeltme / belge ekleme-degistirme (ihale surumuyla). */
  async function updateQuote(ctx: TenderContext, tenderId: string, quoteId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const t = await load(ctx, tenderId);
    assertEditable(t);
    assertVersion(t, version);
    const current = findActiveQuote(t, quoteId);
    const fields = readQuote(o, current);
    const upload = readUpload(o);
    const changed: string[] = QUOTE_FIELDS.filter((k) => fields[k] !== current[k]);
    if (upload) changed.push('document');
    if (!changed.length) return { tender: await detailView(ctx, t, 'manager') };
    const history = current.documentHistory ?? [];
    if (upload && current.document && history.length >= MAX_DOCUMENT_HISTORY) {
      throw new TenderError('unprocessable', `Bir teklifin belgesi en fazla ${MAX_DOCUMENT_HISTORY} kez değiştirilebilir; yeni teklif olarak ekleyin`);
    }
    const document = upload ? await requireDocuments().promote(ctx.apartmentId, upload, { tenderId, quoteId }) : current.document;
    const ts = stamp();
    // Degistirilen belge silinmez: S3'te kalir, kaydi teklifte tutulur (yonetim acabilir).
    const replaced = upload && current.document ? { ...current.document, replacedAt: ts, replacedBy: ctx.userId } : undefined;
    const documentHistory = replaced ? [...history, replaced] : history;
    const { validUntil: _v, deliveryDays: _d, warrantyMonths: _w, notes: _n, document: _doc, documentHistory: _h, ...base } = current;
    const quote: TenderQuote = { ...base, ...fields, ...(document ? { document } : {}), ...(documentHistory.length ? { documentHistory } : {}), updatedAt: ts, updatedBy: ctx.userId };
    const next: Tender = { ...t, quotes: t.quotes.map((q) => (q.quoteId === quoteId ? quote : q)), ...touch(ctx, t, ts) };
    await write(ctx, {
      tender: { item: next, expectedVersion: version },
      audit: audit(ctx, 'tender.quote_update', tenderId, {
        quoteId,
        fields: changed,
        ...normalizeQuote(fields),
        ...(upload && document ? { documentKey: document.key } : {}),
        ...(replaced ? { replacedDocumentKey: replaced.key } : {}),
      }),
    });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  /** Teklif geri cekme (gerekceli; silinmez, karsilastirmaya girmez, sakinler gerekceyle gorur). */
  async function withdrawQuote(ctx: TenderContext, tenderId: string, quoteId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const reason = reqReason(o, 'reason', 3, 300);
    const t = await load(ctx, tenderId);
    assertEditable(t);
    assertVersion(t, version);
    const current = findActiveQuote(t, quoteId);
    const ts = stamp();
    const quote: TenderQuote = { ...current, status: 'withdrawn', withdrawnAt: ts, withdrawnBy: ctx.userId, withdrawReason: reason, updatedAt: ts, updatedBy: ctx.userId };
    const next: Tender = { ...t, quotes: t.quotes.map((q) => (q.quoteId === quoteId ? quote : q)), ...touch(ctx, t, ts) };
    await write(ctx, { tender: { item: next, expectedVersion: version }, audit: audit(ctx, 'tender.quote_withdraw', tenderId, { quoteId, supplierName: current.supplierName }, reason) });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  // -------------------------------------------------------------------------
  // Karardan Finans'a aktarim (gider kaydi)
  // -------------------------------------------------------------------------

  /**
   * "Gider / hakediş ekle": karara baglanmis ihale icin MEVCUT Finans gider servisiyle gider. Govde Finans
   * gider govdesidir (`expenseAccountId`, `creditAccountId`, `amount`, `date`, `description`, `supplier`,
   * `invoiceNumber`, `invoiceUpload`) + `overrunReason?`; verilmeyen tutar (kalan), aciklama, firma, gider
   * kalemi karardan; odeme hesabi verilmezse eslestirilmis tedarikci hesabi (vadeli gider), o da yoksa
   * Finans varsayilani. Arayuz Finans gider penceresini on doldurulmus acar; sessiz kayit yoktur.
   *
   * Ihale basina birden fazla gider (hakedis, en fazla MAX_TENDER_EXPENSES). Gecerli (ters kaydedilmemis)
   * giderler toplami karar tutarini (KDV dahil) asarsa gerekce (`overrunReason`) zorunlu; aksi halde 422.
   * Gider + defter islemi + ihaledeki bag (`expenses`, surum kosullu) + denetim kaydi TEK atomik yazim
   * (`recordExpense` is baglantisi); sinir her denemede guncel ihale ve ters kayit durumuyla yeniden
   * kontrol edilir (es zamanli iki hakedis siniri birlikte asamaz). Ayni anahtar ayni sonucu doner.
   */
  async function createExpense(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const t = await load(ctx, tenderId);
    const prior = expenseLinks(t).find((e) => e.idempotencyKey === key);
    if (prior) return { tender: await detailView(ctx, t, 'manager'), expenseId: prior.expenseId, transactionId: prior.transactionId, replayed: true };
    if (t.status !== 'decided' || !t.decision) throw new TenderError('invalid_state', 'Yalnızca karara bağlanmış ihale için gider kaydı oluşturulabilir');
    if (!deps.finance) throw new TenderError('unavailable', 'Finans modülü bu ortamda yapılandırılmamış');
    const finance = deps.finance;
    const overrunReason = o.overrunReason === undefined || o.overrunReason === null || o.overrunReason === '' ? undefined : reqReason(o, 'overrunReason', 10, 500);
    const links0 = expenseLinks(t);
    if (links0.length >= MAX_TENDER_EXPENSES) throw new TenderError('unprocessable', `Bir ihaleye en fazla ${MAX_TENDER_EXPENSES} gider bağlanabilir`);
    const progress0 = progressOf(t, links0, await reversedLinks(ctx, links0));
    const draft = expenseDraftOf(t, t.decision, progress0, links0.length + 1);
    const has = (k: string) => o[k] !== undefined && o[k] !== null && o[k] !== '';
    if (!has('amount') && progress0.remainingKurus === 0) {
      throw new TenderError('unprocessable', 'Karar tutarının tamamı gider olarak kaydedildi; aşım gideri için tutar ve gerekçe girin', { overBudget: true, remainingKurus: 0, overrunKurus: 0 });
    }
    const amount = has('amount') ? o.amount : progress0.remainingKurus;
    // Erken kontrol: Finans yazimindan once (gereksiz fatura tasima yok); yazimda guncel kayitla yeniden.
    if (typeof amount === 'number') assertCap(progress0, amount, overrunReason);
    const { overrunReason: _r, ...financeBody } = o;
    const r = await finance.recordExpense(
      ctx,
      {
        ...financeBody,
        expenseAccountId: has('expenseAccountId') ? o.expenseAccountId : draft.expenseAccountId,
        ...(has('creditAccountId') ? {} : t.supplierAccount ? { creditAccountId: t.supplierAccount.accountId } : {}),
        amount,
        description: has('description') ? o.description : draft.description,
        supplier: has('supplier') ? o.supplier : draft.supplier,
      },
      {
        fp: { tender: tenderId, ...(overrunReason ? { overrunReason } : {}) },
        expenseLink: { type: 'tender', id: tenderId, label: `İhale: ${t.title}`.slice(0, 200) },
        async build({ transaction, expense }): Promise<WorkLinkWrite> {
          if (!expense) throw new Error('gider kaydi yok');
          // Her denemede guncel ihale ve ters kayit durumu: es zamanli hakedisler siniri birlikte asamaz.
          const cur = await load(ctx, tenderId);
          if (cur.status !== 'decided' || !cur.decision) throw new TenderError('invalid_state', 'Yalnızca karara bağlanmış ihale için gider kaydı oluşturulabilir');
          const links = expenseLinks(cur);
          if (links.length >= MAX_TENDER_EXPENSES) throw new TenderError('unprocessable', `Bir ihaleye en fazla ${MAX_TENDER_EXPENSES} gider bağlanabilir`);
          const progress = progressOf(cur, links, await reversedLinks(ctx, links));
          assertCap(progress, expense.amount, overrunReason);
          const installment = links.length + 1;
          const after = progress.activeTotalKurus + expense.amount;
          const overrun = Math.max(0, after - cur.decision.totalKurus);
          const link: TenderExpenseLink = {
            expenseId: expense.expenseId,
            transactionId: transaction.transactionId,
            amountKurus: expense.amount,
            date: expense.date,
            idempotencyKey: key,
            linkedAt: transaction.createdAt,
            linkedBy: ctx.userId,
            installment,
            ...(overrun > 0 && overrunReason ? { overrunReason } : {}),
          };
          // Eski tek gider alanlari yeni listeye tasinir (silinen bilgi yok: hepsi `expenses` icinde).
          const { expense: _e, previousExpenses: _p, ...rest } = cur;
          const next: Tender = { ...rest, expenses: [...links, link], updatedAt: transaction.createdAt, updatedBy: ctx.userId, version: cur.version + 1 };
          return {
            replaceRecords: [{ item: next, expectedVersion: cur.version, label: `tender:${tenderId}` }],
            auditDetails: {
              tender: {
                tenderId,
                quoteId: cur.decision.quoteId,
                decisionTotalKurus: cur.decision.totalKurus,
                installment,
                activeBeforeKurus: progress.activeTotalKurus,
                activeAfterKurus: after,
                ...(overrun > 0 ? { overrunKurus: overrun, overrunReason } : {}),
                ...(cur.supplierAccount && expense.creditAccountId === cur.supplierAccount.accountId ? { supplierAccountId: cur.supplierAccount.accountId } : {}),
              },
            },
          };
        },
      },
    );
    return { tender: await detailView(ctx, await load(ctx, tenderId), 'manager'), expenseId: r.expense.expenseId, transactionId: r.transaction.transactionId, replayed: r.replayed };
  }

  /** Gecerli giderler + yeni tutar karar tutarini asarsa gerekce zorunlu. */
  function assertCap(p: Progress, amount: number, reason: string | undefined) {
    const overrun = p.activeTotalKurus + amount - p.decidedTotalKurus;
    if (overrun > 0 && !reason) {
      throw new TenderError('unprocessable', `Geçerli giderler toplamı karar tutarını (KDV dahil ${formatTL(p.decidedTotalKurus)}) ${formatTL(overrun)} aşıyor; aşım için gerekçe yazın`, {
        overBudget: true,
        remainingKurus: p.remainingKurus,
        overrunKurus: overrun,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Soru / yorum (yayindaki ihalede: sakin sorar, yonetim yanitlar)
  // -------------------------------------------------------------------------

  /**
   * Yanitlanmamis sakin sorulari: hicbir yonetim yanitinin `answers` listesinde olmayan ve son eski
   * (alansiz) yonetim yanitindan sonra yazilmis sorular. En yeni `MAX_ANSWERS` (kayit boyutu sinirli).
   */
  function openQuestions(existing: readonly TenderComment[]): string[] {
    const sorted = [...existing].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commentId.localeCompare(b.commentId));
    const answered = new Set<string>();
    let legacyUntil = '';
    for (const c of sorted) {
      if (c.authorKind !== 'management') continue;
      if (c.answers) for (const id of c.answers) answered.add(id);
      else legacyUntil = c.createdAt;
    }
    // Gizlenen (moderasyon) soru yanit beklemez: yanit e-postasi gitmez.
    return sorted.filter((c) => c.authorKind === 'resident' && !c.hiddenAt && !answered.has(c.commentId) && c.createdAt > legacyUntil).map((c) => c.commentId).slice(-MAX_ANSWERS);
  }

  async function comment(ctx: TenderContext, tenderId: string, body: unknown) {
    const audience = audienceOf(ctx);
    if (audience === 'observer') throw new TenderError('forbidden', 'Denetçi yorum yazamaz');
    const resident = audience === 'resident' ? await residentOf(ctx) : undefined;
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const text = reqString(o, 'body', MAX_COMMENT_LENGTH, 3);
    const replyTo = o.replyTo === undefined || o.replyTo === null || o.replyTo === '' ? undefined : assertId(o.replyTo, 'replyTo');
    if (replyTo && audience !== 'manager') throw new ValidationError('Belirli bir soruya yalnızca yönetim yanıt verebilir', 'replyTo');
    const fp = fingerprint({ kind: 'comment', tenderId, text, by: ctx.userId, ...(replyTo ? { replyTo } : {}) });
    const t = await loadVisible(ctx, tenderId, audience);
    const result = async () => ({ tender: await detailView(ctx, await load(ctx, tenderId), audience, resident) });
    if (await replayOf(ctx, key, 'comment', fp)) return { ...(await result()), replayed: true };
    if (t.status !== 'published') throw new TenderError('invalid_state', 'Yalnızca yayındaki ihaleye soru yazılabilir');
    const existing = await repo.listComments(ctx.apartmentId, tenderId);
    if (audience === 'resident') {
      // Sinir yalnizca sakine (kullanici basina); yonetim yanitlari ayri, genis bir sinirla.
      if (existing.filter((c) => c.authorId === ctx.userId).length >= MAX_COMMENTS_PER_USER) {
        throw new TenderError('unprocessable', `Bir ihaleye en fazla ${MAX_COMMENTS_PER_USER} mesaj yazabilirsiniz`);
      }
    } else if (existing.filter((c) => c.authorKind === 'management').length >= MAX_MANAGEMENT_COMMENTS) {
      throw new TenderError('unprocessable', `Bir ihaleye en fazla ${MAX_MANAGEMENT_COMMENTS} yönetim yanıtı yazılabilir`);
    }
    if (replyTo) {
      const q = existing.find((c) => c.commentId === replyTo);
      if (!q || q.authorKind !== 'resident') throw new TenderError('not_found', 'Yanıtlanan soru bulunamadı');
      if (q.hiddenAt) throw new TenderError('unprocessable', 'Gizlenen soru yanıtlanamaz');
    }
    const ts = stamp();
    const commentId = `c-${shortId()}`;
    // Yonetim yaniti: belirli soruya yanitta yalnizca o soru; aksi halde o ana kadar yanitlanmamis sakin
    // sorulari (her soru bir kez; e-posta alicilari).
    const answers = audience === 'manager' ? (replyTo ? [replyTo] : openQuestions(existing)) : undefined;
    const item: TenderComment = {
      ...tenderKeys.comment(ctx.apartmentId, tenderId, ts, commentId),
      entityType: 'TENDER_COMMENT',
      apartmentId: ctx.apartmentId,
      tenderId,
      commentId,
      body: text,
      authorId: ctx.userId,
      authorRole: ctx.role,
      authorKind: audience === 'resident' ? 'resident' : 'management',
      ...(answers ? { answers } : {}),
      ...(replyTo ? { replyTo } : {}),
      createdAt: ts,
    };
    try {
      await repo.write(ctx.apartmentId, {
        comment: { item, requireStatus: 'published' },
        idempotency: idempotency(ctx, key, 'comment', tenderId, commentId, fp, ts),
        // Yonetim yaniti sakinlere yapilan resmi aciklamadir: denetime yazilir (metin degil, kimlik + uzunluk).
        // Acik sorularin yazarlarina e-posta (outbox; worker yorumlari okur).
        ...(audience === 'manager'
          ? {
              audit: audit(ctx, 'tender.comment', tenderId, { commentId, length: text.length, ...(replyTo ? { replyTo } : {}) }),
              outbox: [buildEvent({ eventId: `TENDER_REPLIED:${tenderId}:${commentId}`, type: 'TENDER_REPLIED', apartmentId: ctx.apartmentId, actorId: ctx.userId, occurredAt: ts, payload: { tenderId, commentId } }, deps.now)],
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof TenderConflictError && err.reason === 'duplicate' && (await replayOf(ctx, key, 'comment', fp))) return { ...(await result()), replayed: true };
      if (err instanceof TenderConflictError && err.reason === 'status') throw new TenderError('invalid_state', 'İhale artık yorumlara açık değil');
      if (err instanceof TenderConflictError) throw new TenderError('conflict', err.message);
      throw err;
    }
    return { ...(await result()), replayed: false };
  }

  /**
   * Moderasyon: yonetim sakin sorusunu gerekceyle gizler (metin silinmez; sakinlere ve yazara
   * gosterilmez, yonetim / denetci gerekceyle gorur). Bir kez; denetimli (`tender.comment_hide`).
   */
  async function hideComment(ctx: TenderContext, tenderId: string, commentId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const reason = reqReason(o, 'reason', 5, 300);
    assertId(commentId, 'commentId');
    const t = await load(ctx, tenderId);
    const c = (await repo.listComments(ctx.apartmentId, tenderId)).find((x) => x.commentId === commentId);
    if (!c) throw new TenderError('not_found', 'Soru bulunamadı');
    if (c.authorKind !== 'resident') throw new TenderError('unprocessable', 'Yalnızca sakin soruları gizlenebilir');
    if (c.hiddenAt) throw new TenderError('conflict', 'Soru zaten gizlendi');
    const next: TenderComment = { ...c, hiddenAt: stamp(), hiddenBy: ctx.userId, hideReason: reason };
    await write(ctx, { hide: next, audit: audit(ctx, 'tender.comment_hide', tenderId, { commentId, length: c.body.length }, reason) });
    return { tender: await detailView(ctx, t, 'manager') };
  }

  return {
    list,
    get,
    create,
    update,
    collect,
    publish,
    decide,
    cancel,
    addQuote,
    updateQuote,
    withdrawQuote,
    createExpense,
    quoteDocument,
    comment,
    hideComment,
    linkSupplier,
    supplierAccounts,
    linkAssemblyDecision,
    assemblyDecisionOptions,
    portalList,
    portalGet,
    portalQuoteDocument,
  };
}

export type TenderService = ReturnType<typeof createTenderService>;
